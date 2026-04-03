import type {
  CodeImageRecord,
  OpcodeEntry,
  ResolvedSourceSpan,
  SourceFileRecord,
  SourceLocation,
} from './types.ts'

export type ImageSourceData = {
  pcToSource: Map<number, SourceLocation>
  fileIndexMap: Record<number, string>
  sourceContents: Map<number, string>
}

/**
 * Parse a Solidity source map string + bytecode into a PC → source location mapping.
 */
export function parseSourceMap(sourceMapStr: string, bytecodeHex: string): Map<number, SourceLocation> {
  const bytecode = stripHexPrefix(bytecodeHex)
  const instructionPCs: number[] = []
  let pc = 0

  while (pc < bytecode.length / 2) {
    instructionPCs.push(pc)
    const opcode = parseInt(bytecode.slice(pc * 2, pc * 2 + 2), 16)
    if (opcode >= 0x60 && opcode <= 0x7f) {
      pc += 1 + (opcode - 0x5f)
    } else {
      pc += 1
    }
  }

  const entries = sourceMapStr.split(';')
  const result = new Map<number, SourceLocation>()
  let prev: SourceLocation = { fileIndex: -1, start: -1, length: -1, jump: '-' }

  for (let i = 0; i < entries.length && i < instructionPCs.length; i++) {
    const parts = entries[i].split(':')
    const start = parts[0] !== '' && parts[0] !== undefined ? parseInt(parts[0], 10) : prev.start
    const length = parts[1] !== '' && parts[1] !== undefined ? parseInt(parts[1], 10) : prev.length
    const fileIndex = parts[2] !== '' && parts[2] !== undefined ? parseInt(parts[2], 10) : prev.fileIndex
    const jump = parts[3] !== '' && parts[3] !== undefined ? parts[3] : prev.jump

    const loc: SourceLocation = { fileIndex, start, length, jump }
    prev = loc

    if (fileIndex >= 0 && start >= 0) {
      result.set(instructionPCs[i], loc)
    }
  }

  return result
}

export function stripHexPrefix(value: string) {
  return value.startsWith('0x') ? value.slice(2) : value
}

export function buildSourceContentMap(
  image: CodeImageRecord,
  sourceFiles: SourceFileRecord[],
): Map<number, string> {
  const sourceFilesByPath = new Map(sourceFiles.map((file) => [file.path, file.content] as const))
  const sourceFilesByName = new Map<string, SourceFileRecord>()

  for (const file of sourceFiles) {
    const fileName = file.path.split('/').pop() ?? file.path
    if (!sourceFilesByName.has(fileName) || file.path.length < (sourceFilesByName.get(fileName)?.path.length ?? Infinity)) {
      sourceFilesByName.set(fileName, file)
    }
  }

  const generatedContents = new Map(
    image.generatedSources.map((generated) => [
      image.fileIndexMap[generated.id] ?? generated.name,
      generated.contents,
    ] as const),
  )

  const sourceContents = new Map<number, string>()
  for (const [fileIndexKey, filePath] of Object.entries(image.fileIndexMap)) {
    const fileIndex = Number(fileIndexKey)
    let content = sourceFilesByPath.get(filePath) ?? generatedContents.get(filePath)

    if (!content) {
      for (const [storedPath, storedContent] of sourceFilesByPath) {
        if (storedPath.endsWith(filePath) || filePath.endsWith(storedPath)) {
          content = storedContent
          break
        }
      }
    }

    if (!content) {
      const fileName = filePath.split('/').pop() ?? filePath
      content = sourceFilesByName.get(fileName)?.content
    }

    if (content !== undefined) {
      sourceContents.set(fileIndex, content)
    }
  }

  return sourceContents
}

export function createImageSourceData(
  image: CodeImageRecord,
  sourceFiles: SourceFileRecord[],
): ImageSourceData {
  return {
    pcToSource: parseSourceMap(image.sourceMap, image.bytecode),
    fileIndexMap: image.fileIndexMap,
    sourceContents: buildSourceContentMap(image, sourceFiles),
  }
}

/**
 * Convert a UTF-8 byte offset (as used by the Solidity compiler) to a 1-based line and column.
 * Solidity source maps use byte offsets into the UTF-8 encoded source, not JS string char indices.
 */
export function offsetToLineColumn(content: string, offset: number) {
  // Encode once to get the byte-accurate mapping
  const encoder = new TextEncoder()
  const bytes = encoder.encode(content)

  let line = 1
  let column = 1

  for (let i = 0; i < offset && i < bytes.length; i++) {
    if (bytes[i] === 0x0a) { // '\n'
      line++
      column = 1
    } else {
      column++
    }
  }

  return { line, column }
}

/**
 * Decode a UTF-8 byte range back to a JS string, given the original content.
 */
export function sliceByByteOffset(content: string, byteStart: number, byteLength: number): string {
  const bytes = new TextEncoder().encode(content)
  const slice = bytes.slice(byteStart, byteStart + byteLength)
  return new TextDecoder().decode(slice)
}

export function resolveSourceSpan(
  pc: number,
  pcToSource: Map<number, SourceLocation>,
  fileIndexMap: Record<number, string>,
  sourceContents: Map<number, string>,
): ResolvedSourceSpan | null {
  const loc = pcToSource.get(pc)
  if (!loc || loc.fileIndex < 0 || loc.start < 0) {
    return null
  }

  const filePath = fileIndexMap[loc.fileIndex]
  if (!filePath) {
    return null
  }

  const content = sourceContents.get(loc.fileIndex)
  if (!content) {
    return null
  }

  const { line, column } = offsetToLineColumn(content, loc.start)
  return {
    fileIndex: loc.fileIndex,
    filePath,
    start: loc.start,
    length: loc.length,
    line,
    column,
    snippet: sliceByByteOffset(content, loc.start, Math.max(loc.length, 0)),
  }
}

export function buildLineGasMap(
  entries: OpcodeEntry[],
  pcToSource: Map<number, SourceLocation>,
  sourceContents: Map<number, string>,
): Map<string, number> {
  const gasMap = new Map<string, number>()

  for (const entry of entries) {
    const loc = pcToSource.get(entry.pc)
    if (!loc || loc.fileIndex < 0) {
      continue
    }

    const content = sourceContents.get(loc.fileIndex)
    if (!content) {
      continue
    }

    const { line } = offsetToLineColumn(content, loc.start)
    const key = `${loc.fileIndex}:${line}`
    gasMap.set(key, (gasMap.get(key) ?? 0) + entry.gasCost)
  }

  return gasMap
}
