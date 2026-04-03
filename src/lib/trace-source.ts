import type { Hex } from 'viem'
import type {
  CodeImageRecord,
  OpcodeTrace,
  ResolvedSourceSpan,
  SourceFileRecord,
  StepAstContext,
  TraceFrame,
  TraceNode,
  TraceStepLocation,
} from './types.ts'
import { createImageSourceData, stripHexPrefix, type ImageSourceData, resolveSourceSpan, offsetToLineColumn, sliceByByteOffset } from './source-map.ts'
import { buildAstIntervals, findAstContext, formatAstLabel, type AstInterval } from './ast-index.ts'

export type SourceTraceModel = {
  frames: TraceFrame[]
  steps: TraceStepLocation[]
  imageSourceData: Map<string, ImageSourceData>
}

type MutableFrame = TraceFrame & {
  calls: MutableFrame[]
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const end = haystack.length - needle.length
  outer: for (let i = from; i <= end; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

function toRelativeDepth(depth: number, baseDepth: number) {
  return Math.max(depth - baseDepth, 0)
}

function frameFromNode(node: TraceNode, parentId: string | null, depth: number): MutableFrame {
  const proxyContext = node.type === 'DELEGATECALL'
    ? 'delegate'
    : node.type === 'CALLCODE'
      ? 'callcode'
      : 'direct'

  return {
    id: node.id,
    path: node.id,
    depth,
    type: node.type,
    from: node.from,
    to: node.to,
    input: node.input,
    output: node.output,
    value: node.value,
    gas: node.gas,
    gasUsed: node.gasUsed,
    codeAddress: node.to,
    contextAddress: node.to,
    functionName: node.functionName,
    signature: node.signature,
    selector: node.selector,
    args: node.args,
    error: node.error,
    revertReason: node.revertReason,
    status: node.status,
    startEntryIndex: -1,
    endEntryIndex: -1,
    parentId,
    imageId: null,
    imageMatch: 'none',
    proxyContext,
    calls: node.calls.map((child) => frameFromNode(child, node.id, depth + 1)),
  }
}

function flattenFrames(root: MutableFrame): MutableFrame[] {
  const result: MutableFrame[] = [root]
  for (const child of root.calls) {
    result.push(...flattenFrames(child))
  }
  return result
}

function assignExecutionContexts(frame: MutableFrame, parent: MutableFrame | null) {
  if (frame.proxyContext === 'delegate' || frame.proxyContext === 'callcode') {
    frame.contextAddress = parent?.contextAddress ?? parent?.to ?? frame.to
  } else {
    frame.contextAddress = frame.to
  }

  frame.codeAddress = frame.to

  for (const child of frame.calls) {
    assignExecutionContexts(child, frame)
  }
}

function assignFrameRanges(root: TraceNode, trace: OpcodeTrace) {
  const rootFrame = frameFromNode(root, null, 0)
  const entryFrameIds = new Map<number, string>()

  if (trace.entries.length === 0) {
    return { rootFrame, entryFrameIds, flatFrames: flattenFrames(rootFrame) }
  }

  const baseDepth = trace.entries[0].depth
  const stack: MutableFrame[] = [rootFrame]
  const nextChildIndex = new Map<string, number>()

  rootFrame.startEntryIndex = 0

  for (let index = 0; index < trace.entries.length; index++) {
    const entry = trace.entries[index]
    const relativeDepth = toRelativeDepth(entry.depth, baseDepth)

    while (stack.length - 1 > relativeDepth) {
      const completed = stack.pop()
      if (completed && completed.endEntryIndex < 0) {
        completed.endEntryIndex = index - 1
      }
    }

    if (index > 0) {
      const previous = trace.entries[index - 1]
      const previousDepth = toRelativeDepth(previous.depth, baseDepth)
      if (relativeDepth > previousDepth) {
        const parent = stack[stack.length - 1]
        const childIndex = nextChildIndex.get(parent.id) ?? 0
        const child = parent.calls[childIndex]
        if (child) {
          nextChildIndex.set(parent.id, childIndex + 1)
          child.startEntryIndex = index
          stack.push(child)
        }
      }
    }

    const current = stack[stack.length - 1]
    if (current.startEntryIndex < 0) {
      current.startEntryIndex = index
    }
    current.endEntryIndex = index
    entryFrameIds.set(index, current.id)
  }

  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame && frame.endEntryIndex < 0) {
      frame.endEntryIndex = trace.entries.length - 1
    }
  }

  return { rootFrame, entryFrameIds, flatFrames: flattenFrames(rootFrame) }
}

function stripSolcMetadata(bytecode: string) {
  const hex = stripHexPrefix(bytecode).toLowerCase()
  if (hex.length < 4) {
    return hex
  }

  const metadataLengthBytes = parseInt(hex.slice(-4), 16)
  if (!Number.isFinite(metadataLengthBytes) || metadataLengthBytes <= 0) {
    return hex
  }

  const metadataHexLength = metadataLengthBytes * 2
  const metadataStart = hex.length - metadataHexLength - 4
  if (metadataStart <= 0) {
    return hex
  }

  const firstByte = parseInt(hex.slice(metadataStart, metadataStart + 2), 16)
  if (!Number.isFinite(firstByte) || firstByte < 0xa0 || firstByte > 0xbf) {
    return hex
  }

  return hex.slice(0, metadataStart)
}

function byteInMaskedRange(byteIndex: number, image: CodeImageRecord) {
  return [...image.immutableRanges, ...image.libraryRanges]
    .some((range) => byteIndex >= range.start && byteIndex < range.start + range.length)
}

function matchBytecode(
  image: CodeImageRecord,
  actualBytecode: string,
  mode: 'exact' | 'prefix',
) {
  const candidate = mode === 'exact'
    ? stripSolcMetadata(image.bytecode).toLowerCase()
    : stripHexPrefix(image.bytecode).toLowerCase()
  const actual = mode === 'exact'
    ? stripSolcMetadata(actualBytecode).toLowerCase()
    : stripHexPrefix(actualBytecode).toLowerCase()

  if (mode === 'exact' && candidate.length !== actual.length) {
    return false
  }

  if (mode === 'prefix' && actual.length < candidate.length) {
    return false
  }

  const compareLength = candidate.length
  for (let offset = 0; offset < compareLength; offset += 2) {
    const byteIndex = offset / 2
    if (byteInMaskedRange(byteIndex, image)) {
      continue
    }

    if (candidate.slice(offset, offset + 2) !== actual.slice(offset, offset + 2)) {
      return false
    }
  }

  return true
}

function matchCreationImage(images: CodeImageRecord[], input: Hex) {
  return images.find((image) => image.kind === 'creation' && matchBytecode(image, input, 'prefix')) ?? null
}

function matchRuntimeImage(images: CodeImageRecord[], runtimeCode: Hex) {
  return images.find((image) => image.kind === 'runtime' && matchBytecode(image, runtimeCode, 'exact')) ?? null
}

async function bindFramesToImages(
  frames: MutableFrame[],
  codeImages: CodeImageRecord[],
  getRuntimeCode: (address: Hex) => Promise<Hex>,
) {
  const runtimeCodeCache = new Map<Hex, Promise<Hex>>()

  function getCachedCode(address: Hex) {
    if (!runtimeCodeCache.has(address)) {
      runtimeCodeCache.set(address, getRuntimeCode(address))
    }
    return runtimeCodeCache.get(address)!
  }

  for (const frame of frames) {
    const isCreation = frame.type === 'CREATE' || frame.type === 'CREATE2' || (frame.parentId === null && !frame.to)
    if (isCreation) {
      const image = matchCreationImage(codeImages, frame.input)
      if (image) {
        frame.imageId = image.id
        frame.imageMatch = 'creation-input'
      }
      continue
    }

    if (!frame.to) {
      continue
    }

    const runtimeCode = await getCachedCode(frame.to)
    if (runtimeCode && runtimeCode !== '0x') {
      const image = matchRuntimeImage(codeImages, runtimeCode)
      if (image) {
        frame.imageId = image.id
        frame.imageMatch = 'runtime-code'
      }
    }
  }
}

export async function buildSourceTraceModel(args: {
  callTree: TraceNode
  opcodeTrace: OpcodeTrace
  codeImages: CodeImageRecord[]
  sourceFiles: SourceFileRecord[]
  getRuntimeCode: (address: Hex) => Promise<Hex>
}): Promise<SourceTraceModel> {
  const { rootFrame, entryFrameIds, flatFrames } = assignFrameRanges(args.callTree, args.opcodeTrace)
  assignExecutionContexts(rootFrame, null)
  await bindFramesToImages(flatFrames, args.codeImages, args.getRuntimeCode)

  const imageById = new Map(args.codeImages.map((image) => [image.id, image] as const))
  const usedImages = new Set(flatFrames.map((frame) => frame.imageId).filter((value): value is string => !!value))
  const imageSourceData = new Map<string, ImageSourceData>()

  for (const imageId of usedImages) {
    const image = imageById.get(imageId)
    if (!image) {
      continue
    }
    imageSourceData.set(imageId, createImageSourceData(image, args.sourceFiles))
  }

  // Build AST interval caches per image+file for narrowing
  const astIntervalsCache = new Map<string, AstInterval[]>()
  const funcOffsetCache = new Map<string, number>()

  function getAstIntervals(imageId: string, fileIndex: number): AstInterval[] {
    const cacheKey = `${imageId}:${fileIndex}`
    const cached = astIntervalsCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const image = imageById.get(imageId)
    if (!image) {
      astIntervalsCache.set(cacheKey, [])
      return []
    }

    // Find the source file and its AST
    const filePath = image.fileIndexMap[fileIndex]
    if (!filePath) {
      astIntervalsCache.set(cacheKey, [])
      return []
    }

    const sourceFile = args.sourceFiles.find((sf) => sf.path === filePath || sf.path.endsWith(filePath) || filePath.endsWith(sf.path))
    const intervals = sourceFile?.ast ? buildAstIntervals(sourceFile.ast, sourceFile.sourceId) : []
    astIntervalsCache.set(cacheKey, intervals)
    return intervals
  }

  function resolveAstContext(
    source: ResolvedSourceSpan | null,
    imageId: string | null,
  ): StepAstContext | null {
    if (!source || !imageId) {
      return null
    }

    const intervals = getAstIntervals(imageId, source.fileIndex)
    if (intervals.length === 0) {
      return null
    }

    const ctx = findAstContext(intervals, source.start, source.length)

    const data = imageSourceData.get(imageId)
    const content = data?.sourceContents.get(source.fileIndex)

    // Narrow broad source spans to innermost statement when available
    let narrowedSource: ResolvedSourceSpan | null = null
    if (ctx.statement && (ctx.statement.length < source.length) && content) {
      const { line, column } = offsetToLineColumn(content, ctx.statement.start)
      narrowedSource = {
        fileIndex: source.fileIndex,
        filePath: source.filePath,
        start: ctx.statement.start,
        length: ctx.statement.length,
        line,
        column,
        snippet: sliceByByteOffset(content, ctx.statement.start, ctx.statement.length),
      }
    }

    // Resolve function declaration source span.
    // AST byte offsets can be stale in Forge incremental builds, so we search the
    // content for the function name to get an accurate line number.
    let functionSource: ResolvedSourceSpan | null = null
    if (ctx.functionLike && content) {
      const funcName = ctx.functionLike.name
      const cacheKey = `${source.fileIndex}:${funcName ?? ''}`
      const cached = funcOffsetCache.get(cacheKey)
      let resolvedStart = cached ?? ctx.functionLike.start
      if (cached === undefined) {
        if (funcName) {
          // Search in the UTF-8 byte array since source map offsets are byte-based
          const contentBytes = new TextEncoder().encode(content)
          const patternBytes = new TextEncoder().encode(`function ${funcName}`)
          const searchFrom = Math.max(0, ctx.functionLike.start - 2000)
          const nearIdx = indexOfBytes(contentBytes, patternBytes, searchFrom)
          if (nearIdx >= 0) {
            resolvedStart = nearIdx
          } else {
            const globalIdx = indexOfBytes(contentBytes, patternBytes, 0)
            if (globalIdx >= 0) resolvedStart = globalIdx
          }
        }
        funcOffsetCache.set(cacheKey, resolvedStart)
      }
      const { line, column } = offsetToLineColumn(content, resolvedStart)
      functionSource = {
        fileIndex: source.fileIndex,
        filePath: source.filePath,
        start: resolvedStart,
        length: ctx.functionLike.length,
        line,
        column,
        snippet: sliceByByteOffset(content, resolvedStart, Math.min(ctx.functionLike.length, 80)),
      }
    }

    return {
      contract: formatAstLabel(ctx.contract),
      function: formatAstLabel(ctx.functionLike),
      statement: formatAstLabel(ctx.statement),
      narrowedSource,
      functionSource,
    }
  }

  const frameById = new Map(flatFrames.map((frame) => [frame.id, frame] as const))
  const steps: TraceStepLocation[] = args.opcodeTrace.entries.map((entry, entryIndex) => {
    const frameId = entryFrameIds.get(entryIndex) ?? rootFrame.id
    const frame = frameById.get(frameId) ?? rootFrame
    const imageData = frame.imageId ? imageSourceData.get(frame.imageId) : null
    const source: ResolvedSourceSpan | null = imageData
      ? resolveSourceSpan(entry.pc, imageData.pcToSource, imageData.fileIndexMap, imageData.sourceContents)
      : null
    const astContext = resolveAstContext(source, frame.imageId)

    return {
      entryIndex,
      frameId,
      source,
      astContext,
    }
  })

  return {
    frames: [rootFrame],
    steps,
    imageSourceData,
  }
}
