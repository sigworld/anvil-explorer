import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { Abi, Hex } from 'viem'
import { CopyButton } from './common.tsx'
import {
  OpcodeCard,
  AstContextCard,
  DecodedStepCard,
  StackCard,
  MemoryCard,
  StorageCard,
  StorageDiffCard,
  ReturnDataCard,
  FrameInputCard,
  FrameResultCard,
  FailureFocusCard,
  ContextCard,
  ChildCallsCard,
} from './inspector-cards.tsx'
import { StackTraceView } from './stack-trace-view.tsx'

// ---------------------------------------------------------------------------
// Drag-resizable splitter primitives
// ---------------------------------------------------------------------------

type SplitAxis = 'horizontal' | 'vertical'

function loadFractions(key: string, fallback: number[]): number[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || parsed.length !== fallback.length) return fallback
    if (!parsed.every((v) => typeof v === 'number' && v > 0)) return fallback
    return parsed as number[]
  } catch {
    return fallback
  }
}

function saveFractions(key: string, fractions: number[]) {
  try {
    localStorage.setItem(key, JSON.stringify(fractions))
  } catch {
    // Storage full or unavailable — ignore.
  }
}

function useDragSplitter(
  axis: SplitAxis,
  initialFractions: number[],
  storageKey: string,
  minPx: number = 120,
) {
  const [fractions, setFractions] = useState(() => loadFractions(storageKey, initialFractions))
  const containerRef = useRef<HTMLDivElement | null>(null)

  const startDrag = useCallback((index: number, event: MouseEvent) => {
    event.preventDefault()
    const container = containerRef.current
    if (!container) return

    const rect = container.getBoundingClientRect()
    const totalSize = axis === 'horizontal' ? rect.width : rect.height
    const startPos = axis === 'horizontal' ? event.clientX : event.clientY

    const startFractions = [...fractions]
    const minFrac = minPx / totalSize

    function onMove(moveEvent: MouseEvent) {
      const currentPos = axis === 'horizontal' ? moveEvent.clientX : moveEvent.clientY
      const delta = (currentPos - startPos) / totalSize

      const newFractions = [...startFractions]
      let leftNew = startFractions[index] + delta
      let rightNew = startFractions[index + 1] - delta

      if (leftNew < minFrac) {
        leftNew = minFrac
        rightNew = startFractions[index] + startFractions[index + 1] - minFrac
      }
      if (rightNew < minFrac) {
        rightNew = minFrac
        leftNew = startFractions[index] + startFractions[index + 1] - minFrac
      }

      newFractions[index] = leftNew
      newFractions[index + 1] = rightNew
      setFractions(newFractions)
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      // Persist only on drag end, not on every mousemove
      setFractions((current) => {
        saveFractions(storageKey, current)
        return current
      })
    }

    document.body.style.cursor = axis === 'horizontal' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [axis, fractions, minPx, storageKey])

  return { fractions, containerRef, startDrag }
}

function SplitHandle(props: {
  axis: SplitAxis
  index: number
  onDragStart: (index: number, event: MouseEvent) => void
}) {
  return (
    <div
      class={`debug-split-handle debug-split-handle-${props.axis}`}
      onMouseDown={(event) => props.onDragStart(props.index, event as unknown as MouseEvent)}
    />
  )
}
import { getAbi, listCodeImages, listSourceFiles } from '../lib/db.ts'
import { useExplorer } from '../hooks/use-explorer.tsx'
import { formatNumber } from '../lib/format.ts'
import { buildLineGasMap, stripHexPrefix, type ImageSourceData } from '../lib/source-map.ts'
import { decodeStep, type DecodedStep } from '../lib/step-decode.ts'
import { decodeStepStorage, diffStorage, type DecodedStorageSlot } from '../lib/storage-decode.ts'
import { buildSourceTraceModel } from '../lib/trace-source.ts'
import type {
  CodeImageRecord,
  OpcodeEntry,
  OpcodeTrace,
  ResolvedSourceSpan,
  StepAstContext,
  TraceFrame,
  TraceNode,
  TraceStepLocation,
} from '../lib/types.ts'

type Props = {
  trace: OpcodeTrace
  callTree: TraceNode
  loadRuntimeCode: (address: Hex) => Promise<Hex>
}

type FrameEntry = {
  globalIndex: number
  entry: OpcodeEntry
  step: TraceStepLocation
}

type FailureFocus = {
  frameId: string
  entryIndex: number
}

function flattenFrames(frames: TraceFrame[]): TraceFrame[] {
  const result: TraceFrame[] = []
  function visit(frame: TraceFrame) {
    result.push(frame)
    for (const child of frame.calls) {
      visit(child)
    }
  }
  for (const frame of frames) {
    visit(frame)
  }
  return result
}

function frameLabel(frame: TraceFrame) {
  return frame.signature ?? frame.functionName ?? frame.selector ?? (frame.type === 'CREATE' || frame.type === 'CREATE2'
    ? 'constructor'
    : 'fallback / receive')
}

function buildLineOffsets(content: string) {
  const lines = content.split('\n')
  const offsets: number[] = []
  let cursor = 0
  for (const line of lines) {
    offsets.push(cursor)
    cursor += line.length + 1
  }
  return { lines, offsets }
}

function renderHighlightedLine(line: string, lineStart: number, span: ResolvedSourceSpan | null) {
  if (!span || span.length <= 0) {
    return line || ' '
  }

  const lineEnd = lineStart + line.length
  const spanStart = span.start
  const spanEnd = span.start + span.length
  const overlapStart = Math.max(lineStart, spanStart)
  const overlapEnd = Math.min(lineEnd, spanEnd)

  if (overlapStart >= overlapEnd) {
    return line || ' '
  }

  const localStart = overlapStart - lineStart
  const localEnd = overlapEnd - lineStart

  return (
    <>
      {line.slice(0, localStart)}
      <mark class="source-inline-highlight">{line.slice(localStart, localEnd) || ' '}</mark>
      {line.slice(localEnd)}
    </>
  )
}

function readBigInt(value: string | undefined) {
  if (!value) {
    return null
  }

  try {
    return BigInt(value)
  } catch {
    return null
  }
}

function hexWordsToBytes(memory: string[] | undefined) {
  if (!memory || memory.length === 0) {
    return null
  }

  return memory.map(stripHexPrefix).join('')
}

function sliceMemory(memory: string[] | undefined, offset: bigint | null, size: bigint | null) {
  if (offset === null || size === null || offset < 0 || size < 0) {
    return null
  }

  if (offset > BigInt(Number.MAX_SAFE_INTEGER) || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null
  }

  const bytes = hexWordsToBytes(memory)
  if (!bytes) {
    return null
  }

  const start = Number(offset) * 2
  const end = start + Number(size) * 2
  if (start < 0 || end > bytes.length) {
    return null
  }

  return `0x${bytes.slice(start, end)}`
}

function deriveReturnPayload(entry: OpcodeEntry | null) {
  if (!entry || (entry.op !== 'REVERT' && entry.op !== 'RETURN')) {
    return null
  }

  const offset = readBigInt(entry.stack[entry.stack.length - 1])
  const size = readBigInt(entry.stack[entry.stack.length - 2])

  return {
    offset: offset?.toString() ?? null,
    size: size?.toString() ?? null,
    data: sliceMemory(entry.memory, offset, size),
  }
}

function findFailureFocus(flatFrames: TraceFrame[], frameEntryMap: Map<string, FrameEntry[]>): FailureFocus | null {
  const focusFrame = [...flatFrames]
    .filter((frame) => frame.status !== 'success')
    .sort((left, right) => {
      if (right.depth !== left.depth) {
        return right.depth - left.depth
      }
      return right.startEntryIndex - left.startEntryIndex
    })[0]

  if (!focusFrame) {
    return null
  }

  const entries = frameEntryMap.get(focusFrame.id) ?? []
  const focusEntry = [...entries].reverse().find((item) => (
    item.entry.op === 'REVERT'
    || item.entry.op === 'INVALID'
    || item.entry.op === 'ASSERTFAIL'
  )) ?? entries[entries.length - 1]

  return {
    frameId: focusFrame.id,
    entryIndex: focusEntry?.globalIndex ?? focusFrame.startEntryIndex,
  }
}

export function DebugTraceView({ trace, callTree, loadRuntimeCode }: Props) {
  const { refreshKey } = useExplorer()
  const [codeImages, setCodeImages] = useState<CodeImageRecord[]>([])
  const [frames, setFrames] = useState<TraceFrame[]>([])
  const [steps, setSteps] = useState<TraceStepLocation[]>([])
  const [imageSourceData, setImageSourceData] = useState<Map<string, ImageSourceData>>(new Map())
  const [abiMap, setAbiMap] = useState<Map<string, Abi>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedFrameId, setSelectedFrameId] = useState(callTree.id)
  const [selectedEntryIndex, setSelectedEntryIndex] = useState(0)
  const [selectedFileIndexOverride, setSelectedFileIndexOverride] = useState<number | null>(null)
  const sourceLineRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())
  const sourceBodyRef = useRef<HTMLDivElement | null>(null)

  // Splitter state: outer 2 columns [steps, right-side]
  const colSplit = useDragSplitter('horizontal', [0.22, 0.78], 'anvil-explorer.debug-cols-v2', 180)
  // Right side: vertical split [top-panes, inspector]
  const rowSplit = useDragSplitter('vertical', [0.55, 0.45], 'anvil-explorer.debug-rows', 140)
  // Top panes: horizontal split [stack-trace, source]
  const innerColSplit = useDragSplitter('horizontal', [0.48, 0.52], 'anvil-explorer.debug-inner-cols', 160)

  useEffect(() => {
    let cancelled = false

    async function run() {
      setLoading(true)
      setError(null)

      try {
        const [nextCodeImages, nextSourceFiles] = await Promise.all([
          listCodeImages(),
          listSourceFiles(),
        ])

        const model = await buildSourceTraceModel({
          callTree,
          opcodeTrace: trace,
          codeImages: nextCodeImages,
          sourceFiles: nextSourceFiles,
          getRuntimeCode: loadRuntimeCode,
        })

        if (cancelled) {
          return
        }

        // Collect all addresses from call tree for ABI loading
        const addresses = new Set<string>()
        function collectAddresses(node: TraceNode) {
          if (node.to) addresses.add(node.to)
          for (const child of node.calls) collectAddresses(child)
        }
        collectAddresses(callTree)

        const abiEntries = await Promise.all(
          [...addresses].map(async (addr) => {
            const record = await getAbi(addr)
            return record ? [addr, record.abi] as const : null
          }),
        )
        const nextAbiMap = new Map<string, Abi>()
        for (const entry of abiEntries) {
          if (entry) nextAbiMap.set(entry[0], entry[1])
        }

        if (cancelled) return

        setCodeImages(nextCodeImages)
        setFrames(model.frames)
        setSteps(model.steps)
        setImageSourceData(model.imageSourceData)
        setAbiMap(nextAbiMap)
      } catch (caughtError: unknown) {
        if (!cancelled) {
          setError(caughtError instanceof Error ? caughtError.message : 'Unable to build debug trace')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [callTree, trace, loadRuntimeCode, refreshKey])

  const flatFrames = useMemo(() => flattenFrames(frames), [frames])
  const frameById = useMemo(() => new Map(flatFrames.map((frame) => [frame.id, frame] as const)), [flatFrames])
  const imageById = useMemo(() => new Map(codeImages.map((image) => [image.id, image] as const)), [codeImages])
  const frameEntryMap = useMemo(() => {
    const map = new Map<string, FrameEntry[]>(flatFrames.map((frame) => [frame.id, []] as const))
    for (let index = 0; index < trace.entries.length; index++) {
      const step = steps[index]
      if (!step) continue
      const bucket = map.get(step.frameId)
      if (!bucket) continue
      bucket.push({
        globalIndex: index,
        entry: trace.entries[index],
        step,
      })
    }
    return map
  }, [flatFrames, steps, trace.entries])
  const failureFocus = useMemo(() => findFailureFocus(flatFrames, frameEntryMap), [flatFrames, frameEntryMap])

  useEffect(() => {
    if (loading || flatFrames.length === 0) {
      return
    }

    const focus = failureFocus ?? {
      frameId: flatFrames[0]?.id ?? callTree.id,
      entryIndex: flatFrames[0]?.startEntryIndex ?? 0,
    }
    setSelectedFrameId(focus.frameId)
    setSelectedEntryIndex(focus.entryIndex)
    setSelectedFileIndexOverride(null)
  }, [loading, callTree.id, flatFrames, frameById, failureFocus])

  const selectedFrame = frameById.get(selectedFrameId) ?? flatFrames[0] ?? null
  const selectedFrameEntries = selectedFrame ? frameEntryMap.get(selectedFrame.id) ?? [] : []
  const selectedEntryPosition = selectedFrameEntries.findIndex((item) => item.globalIndex === selectedEntryIndex)
  const selectedTraceEntry = trace.entries[selectedEntryIndex] ?? null
  const selectedStep = steps[selectedEntryIndex] ?? null
  const selectedSource = selectedStep?.source ?? null
  const selectedImage = selectedFrame?.imageId ? imageById.get(selectedFrame.imageId) ?? null : null
  const selectedImageData = selectedFrame?.imageId ? imageSourceData.get(selectedFrame.imageId) ?? null : null

  const imageFiles = useMemo(() => {
    if (!selectedImage || !selectedImageData) {
      return []
    }

    return [...selectedImageData.sourceContents.keys()]
      .sort((left, right) => left - right)
      .map((fileIndex) => {
        const filePath = selectedImage.fileIndexMap[fileIndex] ?? `file ${fileIndex}`
        return {
          fileIndex,
          filePath,
          generated: filePath.startsWith('<generated:'),
        }
      })
  }, [selectedImage, selectedImageData])

  const activeFileIndex = selectedFileIndexOverride
    ?? selectedSource?.fileIndex
    ?? imageFiles[0]?.fileIndex
    ?? null
  const activeFilePath = activeFileIndex !== null && activeFileIndex !== undefined
    ? selectedImage?.fileIndexMap[activeFileIndex] ?? null
    : null
  const activeFileContent = activeFileIndex !== null && activeFileIndex !== undefined
    ? selectedImageData?.sourceContents.get(activeFileIndex) ?? null
    : null
  const activeFile = activeFileContent ? buildLineOffsets(activeFileContent) : null

  const { lineGasMap, maxLineGas } = useMemo(() => {
    if (!selectedImage || !selectedImageData) {
      return { lineGasMap: new Map<string, number>(), maxLineGas: 1 }
    }

    const gasMap = buildLineGasMap(
      selectedFrameEntries.map((item) => item.entry),
      selectedImageData.pcToSource,
      selectedImageData.sourceContents,
    )

    let max = 1
    for (const value of gasMap.values()) {
      max = Math.max(max, value)
    }

    return { lineGasMap: gasMap, maxLineGas: max }
  }, [selectedFrameEntries, selectedImage, selectedImageData])

  const decodedCurrentStep: DecodedStep = useMemo(
    () => selectedTraceEntry ? decodeStep(selectedTraceEntry, abiMap) : null,
    [selectedTraceEntry, abiMap],
  )

  const selectedAstContext: StepAstContext | null = selectedStep?.astContext ?? null
  const effectiveSource = selectedAstContext?.narrowedSource ?? selectedSource

  const currentStorageDecoded: DecodedStorageSlot[] = useMemo(() => {
    if (!selectedTraceEntry?.storage || !selectedFrame?.imageId) {
      return decodeStepStorage(selectedTraceEntry?.storage, null)
    }
    const image = selectedFrame.imageId ? imageById.get(selectedFrame.imageId) : null
    return decodeStepStorage(selectedTraceEntry.storage, image?.storageLayout)
  }, [selectedTraceEntry?.storage, selectedFrame?.imageId, imageById])

  const storageDiff = useMemo(() => {
    if (selectedEntryIndex <= 0) return []
    const prevEntry = trace.entries[selectedEntryIndex - 1]
    return diffStorage(prevEntry?.storage, selectedTraceEntry?.storage)
  }, [selectedEntryIndex, selectedTraceEntry?.storage, trace.entries])

  const stackDiff = useMemo(() => {
    if (selectedEntryIndex <= 0 || !selectedTraceEntry) return null
    const prevEntry = trace.entries[selectedEntryIndex - 1]
    if (!prevEntry) return null
    const prevStack = prevEntry.stack ?? []
    const currStack = selectedTraceEntry.stack ?? []
    const popped = prevStack.length > currStack.length
      ? prevStack.slice(currStack.length - prevStack.length)
      : []
    const pushed = currStack.length > prevStack.length
      ? currStack.slice(prevStack.length - currStack.length)
      : []
    if (popped.length === 0 && pushed.length === 0) return null
    return { popped, pushed }
  }, [selectedEntryIndex, selectedTraceEntry, trace.entries])

  const returnPayload = useMemo(() => deriveReturnPayload(selectedTraceEntry), [selectedTraceEntry])

  useEffect(() => {
    const scrollSource = effectiveSource ?? selectedSource
    if (!scrollSource) {
      return
    }
    const key = `${scrollSource.fileIndex}:${scrollSource.line}`
    const lineEl = sourceLineRefs.current.get(key)
    const container = sourceBodyRef.current
    if (!lineEl || !container) {
      return
    }
    const lineTop = lineEl.offsetTop
    const lineHeight = lineEl.offsetHeight
    const containerHeight = container.clientHeight
    container.scrollTop = lineTop - containerHeight / 2 + lineHeight / 2
  }, [selectedEntryIndex, effectiveSource?.fileIndex, effectiveSource?.line, selectedSource?.fileIndex, selectedSource?.line])

  function selectEntry(entryIndex: number) {
    const nextStep = steps[entryIndex]
    const nextFrame = nextStep ? frameById.get(nextStep.frameId) ?? null : null
    const frameId = nextFrame?.id ?? selectedFrameId

    setSelectedFrameId(frameId)
    setSelectedEntryIndex(entryIndex)
    setSelectedFileIndexOverride(null)
  }

  function stepOver(offset: number) {
    if (selectedFrameEntries.length === 0) {
      return
    }

    const currentIndex = selectedEntryPosition >= 0 ? selectedEntryPosition : 0
    const nextIndex = Math.max(0, Math.min(selectedFrameEntries.length - 1, currentIndex + offset))
    const nextEntry = selectedFrameEntries[nextIndex]
    if (!nextEntry) {
      return
    }
    selectEntry(nextEntry.globalIndex)
  }

  function stepLine(direction: 1 | -1) {
    if (selectedFrameEntries.length === 0) return

    const currentPos = selectedEntryPosition >= 0 ? selectedEntryPosition : 0
    const currentSource = selectedFrameEntries[currentPos]?.step.source
    const currentFile = currentSource?.fileIndex ?? null
    const currentLine = currentSource?.line ?? null

    let pos = currentPos + direction
    while (pos >= 0 && pos < selectedFrameEntries.length) {
      const source = selectedFrameEntries[pos].step.source
      if (source && (source.fileIndex !== currentFile || source.line !== currentLine)) {
        selectEntry(selectedFrameEntries[pos].globalIndex)
        return
      }
      pos += direction
    }

    // Hit the boundary without finding a different line
    const boundary = direction > 0
      ? selectedFrameEntries[selectedFrameEntries.length - 1]
      : selectedFrameEntries[0]
    if (boundary) {
      selectEntry(boundary.globalIndex)
    }
  }

  function stepOut() {
    if (!selectedFrame?.parentId) {
      return
    }

    const parentFrame = frameById.get(selectedFrame.parentId)
    if (!parentFrame) {
      return
    }

    const parentEntries = frameEntryMap.get(parentFrame.id) ?? []
    const nextParentEntry = parentEntries.find((item) => item.globalIndex > selectedFrame.endEntryIndex)
    selectEntry(nextParentEntry?.globalIndex ?? parentFrame.endEntryIndex)
  }

  function handleSourceLineClick(fileIndex: number, line: number) {
    const match = selectedFrameEntries.find((item) => item.step.source?.fileIndex === fileIndex && item.step.source?.line === line)
    if (match) {
      selectEntry(match.globalIndex)
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Ignore if user is typing in an input/textarea
      const tag = (event.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (event.key === 'ArrowDown' || event.key === 'j') {
        event.preventDefault()
        if (event.shiftKey) stepOver(1)
        else stepLine(1)
      } else if (event.key === 'ArrowUp' || event.key === 'k') {
        event.preventDefault()
        if (event.shiftKey) stepOver(-1)
        else stepLine(-1)
      } else if (event.key === 'o' || event.key === 'Escape') {
        event.preventDefault()
        stepOut()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  if (loading) {
    return <p class="muted">Building debug trace…</p>
  }

  if (error) {
    return <p class="muted">{error}</p>
  }

  if (!selectedFrame) {
    return <p class="muted">No debug frames available.</p>
  }

  return (
    <div class="debug-trace-view" ref={colSplit.containerRef}>
      {/* Column 1: Frame Steps (full height) */}
      <div class="debug-col" style={{ flex: colSplit.fractions[0] }}>
        <section class="debug-panel debug-cell debug-cell-steps">
          <header class="debug-panel-header debug-steps-panel-header">
            <strong>Frame Steps</strong>
            <div class="debug-steps-controls">
              <button type="button" onClick={() => stepLine(-1)} disabled={selectedEntryPosition <= 0} title="Previous source line">Line ←</button>
              <button type="button" onClick={() => stepLine(1)} disabled={selectedEntryPosition < 0 || selectedEntryPosition >= selectedFrameEntries.length - 1} title="Next source line">Line →</button>
              <button type="button" onClick={() => stepOver(-1)} disabled={selectedEntryPosition <= 0} title="Previous opcode in frame">Op ←</button>
              <button type="button" onClick={() => stepOver(1)} disabled={selectedEntryPosition < 0 || selectedEntryPosition >= selectedFrameEntries.length - 1} title="Next opcode in frame">Op →</button>
              <button type="button" onClick={stepOut} disabled={!selectedFrame.parentId}>Out</button>
            </div>
          </header>
          <div class="debug-panel-body debug-opcode-mini-list">
            <div class="debug-opcode-mini-head" aria-hidden="true">
              <span>Step</span>
              <span>PC</span>
              <span>Opcode</span>
              <span>Source</span>
            </div>
            {selectedFrameEntries.map((item) => (
              <button
                key={item.globalIndex}
                type="button"
                ref={(el) => {
                  if (item.globalIndex === selectedEntryIndex && el) {
                    const container = el.parentElement
                    if (container) {
                      const top = el.offsetTop - container.offsetTop
                      const elH = el.offsetHeight
                      const cH = container.clientHeight
                      if (top < container.scrollTop || top + elH > container.scrollTop + cH) {
                        container.scrollTop = top - cH / 2 + elH / 2
                      }
                    }
                  }
                }}
                class={`debug-opcode-mini-item ${item.globalIndex === selectedEntryIndex ? 'is-selected' : ''}`.trim()}
                onClick={() => selectEntry(item.globalIndex)}
              >
                <span class="mono">{item.globalIndex}</span>
                <span class="mono">{item.entry.pc}</span>
                <span class="mono">{item.entry.op}</span>
                <span class="muted">{item.step.source ? `${item.step.source.filePath.split('/').pop()}:${item.step.source.line}` : 'unmapped'}</span>
              </button>
            ))}
          </div>
        </section>
      </div>

      <SplitHandle axis="horizontal" index={0} onDragStart={colSplit.startDrag} />

      {/* Column 2+3: Stack Trace + Source (top), Inspector (bottom) */}
      <div class="debug-col" style={{ flex: colSplit.fractions[1] }} ref={rowSplit.containerRef}>
        {/* Top row: Stack Trace | Source */}
        <div class="debug-row debug-row-top" style={{ flex: rowSplit.fractions[0] }} ref={innerColSplit.containerRef}>
          <div class="debug-inner-col debug-col-stv" style={{ flex: innerColSplit.fractions[0] }}>
            <section class="debug-panel debug-cell">
              <header class="debug-panel-header">
                <strong>Stack Trace</strong>
              </header>
              <div class="debug-panel-body debug-stv-body">
                <StackTraceView
                  trace={callTree}
                  opcodeTrace={trace}
                  opcodeLoading={false}
                  loadRuntimeCode={loadRuntimeCode}
                  initialFullTrace
                  embedded
                  onEntrySelect={selectEntry}
                />
              </div>
            </section>
          </div>

          <SplitHandle axis="horizontal" index={0} onDragStart={innerColSplit.startDrag} />

          <div class="debug-inner-col" style={{ flex: innerColSplit.fractions[1] }}>
            <section class="debug-panel debug-cell debug-cell-source debug-source-panel">
              <header class="debug-panel-header debug-source-header">
                <div class="debug-source-filebox">
                  <div class="debug-source-title-row">
                    <strong>{frameLabel(selectedFrame)}</strong>
                    <span class="meta-badge meta-kind">{selectedFrame.type}</span>
                    {selectedFrame.status !== 'success' && (
                      <span class={`meta-badge ${selectedFrame.status === 'reverted' ? 'meta-status meta-status-warning' : 'meta-status meta-status-danger'}`}>
                        {selectedFrame.status}
                      </span>
                    )}
                    <span class="muted mono">{selectedFrame.codeAddress ?? 'n/a'}</span>
                    {selectedFrame.codeAddress && <CopyButton value={selectedFrame.codeAddress} label="Copy address" />}
                  </div>
                  <span class="mono source-pane-filename">{activeFilePath ?? 'No source mapped'}</span>
                  {imageFiles.length > 1 && (
                    <select
                      class="source-file-select"
                      value={activeFileIndex ?? ''}
                      onInput={(event) => {
                        const next = Number(event.currentTarget.value)
                        setSelectedFileIndexOverride(Number.isFinite(next) ? next : null)
                      }}
                    >
                      {imageFiles.map((file) => (
                        <option key={file.fileIndex} value={file.fileIndex}>
                          {file.generated ? `[generated] ${file.filePath.split(':').slice(-2).join(':')}` : file.filePath}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </header>

              <div class="debug-panel-body debug-source-body" ref={sourceBodyRef}>
                {activeFile && (
                  <div class="source-code-view debug-source-code-view">
                    {activeFile.lines.map((line, lineIdx) => {
                      const lineNum = lineIdx + 1
                      const key = `${String(activeFileIndex)}:${lineNum}`
                      const lineGas = lineGasMap.get(key)
                      const gasIntensity = lineGas ? Math.min(lineGas / maxLineGas, 1) : 0
                      const focusSource = effectiveSource ?? selectedSource
                      const isFocused = focusSource?.fileIndex === activeFileIndex && focusSource.line === lineNum
                      const lineStart = activeFile.offsets[lineIdx]
                      const lineSelectedSpan = focusSource?.fileIndex === activeFileIndex ? focusSource : null

                      return (
                        <div
                          key={lineNum}
                          ref={(element) => {
                            sourceLineRefs.current.set(key, element)
                          }}
                          class={`source-line ${isFocused ? 'source-line-focused' : ''} ${lineGas !== undefined ? 'source-line-has-cost' : ''}`.trim()}
                          style={gasIntensity > 0 && !isFocused ? { background: `rgba(var(--warning-rgb, 234, 179, 8), ${gasIntensity * 0.14})` } : undefined}
                          onClick={() => handleSourceLineClick(activeFileIndex as number, lineNum)}
                        >
                          <span class="source-line-number">{lineNum}</span>
                          <span class="source-line-code mono">
                            {renderHighlightedLine(line, lineStart, lineSelectedSpan)}
                          </span>
                          {lineGas !== undefined && <span class="source-gas-gutter mono">{formatNumber(lineGas)}</span>}
                        </div>
                      )
                    })}
                  </div>
                )}
                {!activeFile && <p class="muted" style={{ padding: '16px' }}>No mapped source file is available for the selected frame.</p>}
              </div>
            </section>
          </div>
        </div>

        <SplitHandle axis="vertical" index={0} onDragStart={rowSplit.startDrag} />

        {/* Bottom: Inspector (spans col2+col3) */}
        <div class="debug-row" style={{ flex: rowSplit.fractions[1] }}>
          <section class="debug-panel debug-cell debug-cell-inspector debug-inspector-panel">
            <header class="debug-panel-header">
              <strong>Inspector</strong>
              <span class="muted mono">
                step {formatNumber(selectedEntryIndex)} / {formatNumber(trace.entries.length - 1)}
              </span>
            </header>
            <div class="debug-panel-body debug-inspector-grid">
              {/* Row 1: context | frame in | frame out */}
              <ContextCard
                frame={selectedFrame}
                image={selectedImage
                  ? { contractName: selectedImage.contractName, imageMatch: selectedFrame.imageMatch, sourcePath: selectedImage.sourcePath }
                  : null
                }
              />
              <FrameInputCard frame={selectedFrame} />
              <FrameResultCard frame={selectedFrame} />

              {/* Row 2: opcode | stack | storage diff */}
              <OpcodeCard entry={selectedTraceEntry} stackDiff={stackDiff} />
              <div class="insp-cell insp-card-scroll"><StackCard stack={selectedTraceEntry?.stack} /></div>
              <StorageDiffCard diffs={storageDiff} />

              {/* Row 3: return | memory | storage */}
              <ReturnDataCard
                entry={selectedTraceEntry}
                returnPayload={returnPayload}
                frameOutput={selectedFrame.output}
              />
              <div class="insp-cell insp-card-scroll"><MemoryCard memory={selectedTraceEntry?.memory} /></div>
              <div class="insp-cell insp-card-scroll"><StorageCard slots={currentStorageDecoded} /></div>

              {/* Row 4: failure | children | ast */}
              <FailureFocusCard
                frame={selectedFrame}
                failureFocus={failureFocus}
                source={effectiveSource ?? selectedSource}
              />
              <div class="insp-card-scroll"><ChildCallsCard calls={selectedFrame.calls} /></div>
              <AstContextCard ctx={selectedAstContext} />

              {decodedCurrentStep && (
                <div class="insp-card-wide"><DecodedStepCard decoded={decodedCurrentStep} /></div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
