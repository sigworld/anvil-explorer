import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { Hex } from 'viem'
import { listCodeImages, listSourceFiles } from '../lib/db.ts'
import { useExplorer } from '../hooks/use-explorer.tsx'
import { buildAstIntervals, findAstContext, formatAstLabel } from '../lib/ast-index.ts'
import { formatNumber } from '../lib/format.ts'
import { buildLineGasMap, type ImageSourceData } from '../lib/source-map.ts'
import { buildSourceTraceModel } from '../lib/trace-source.ts'
import type {
  CodeImageRecord,
  OpcodeEntry,
  OpcodeTrace,
  ResolvedSourceSpan,
  SourceFileRecord,
  TraceFrame,
  TraceNode,
  TraceStepLocation,
} from '../lib/types.ts'

type Props = {
  trace: OpcodeTrace
  callTree: TraceNode
  loadRuntimeCode: (address: Hex) => Promise<Hex>
}

const PAGE_SIZE = 300
const CALL_TYPES = new Set(['CALL', 'STATICCALL', 'DELEGATECALL', 'CALLCODE', 'CREATE', 'CREATE2'])

type FrameEntry = {
  globalIndex: number
  entry: OpcodeEntry
  step: TraceStepLocation
}

type FrameEntryGroup = {
  id: string
  fileIndex: number | null
  filePath: string | null
  label: string
  shortLabel: string
  generated: boolean
  firstGlobalIndex: number
  lastGlobalIndex: number
  startLine: number | null
  endLine: number | null
  entries: FrameEntry[]
}

type ExecutionStreamItem =
  | { kind: 'group'; startIndex: number; group: FrameEntryGroup }
  | { kind: 'child'; startIndex: number; frame: TraceFrame }

type SourceLineGroupMarker = {
  groupId: string
  groupIndex: number
  shortLabel: string
  firstGlobalIndex: number
  opCount: number
  startLine: number
  endLine: number
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

function frameChildrenSummary(frame: TraceFrame) {
  if (frame.calls.length === 0) {
    return null
  }

  return frame.calls
    .slice(0, 4)
    .map((child) => frameLabel(child))
    .join(', ')
}

function formatSourceGroupLabel(filePath: string | null) {
  if (!filePath) {
    return {
      label: 'Unmapped execution',
      shortLabel: 'unmapped',
      generated: false,
    }
  }

  const generated = filePath.startsWith('<generated:')
  const shortLabel = generated
    ? filePath.replace('<generated:', '').replace('>', '')
    : filePath.split('/').pop() ?? filePath

  return {
    label: filePath,
    shortLabel,
    generated,
  }
}

function groupFrameEntriesBySource(frameId: string, entries: FrameEntry[]): FrameEntryGroup[] {
  const groups: FrameEntryGroup[] = []

  for (const item of entries) {
    const source = item.step.source
    const fileIndex = source?.fileIndex ?? null
    const filePath = source?.filePath ?? null
    const previous = groups[groups.length - 1]

    const separatedByNestedCall = previous ? item.globalIndex > previous.lastGlobalIndex + 1 : false

    if (
      previous
      && !separatedByNestedCall
      && previous.fileIndex === fileIndex
      && previous.filePath === filePath
    ) {
      previous.entries.push(item)
      previous.lastGlobalIndex = item.globalIndex
      if (source?.line !== undefined) {
        previous.startLine = previous.startLine === null ? source.line : Math.min(previous.startLine, source.line)
        previous.endLine = previous.endLine === null ? source.line : Math.max(previous.endLine, source.line)
      }
      continue
    }

    const { label, shortLabel, generated } = formatSourceGroupLabel(filePath)
    groups.push({
      id: `${frameId}:${groups.length}:${fileIndex ?? 'unmapped'}:${item.globalIndex}`,
      fileIndex,
      filePath,
      label,
      shortLabel,
      generated,
      firstGlobalIndex: item.globalIndex,
      lastGlobalIndex: item.globalIndex,
      startLine: source?.line ?? null,
      endLine: source?.line ?? null,
      entries: [item],
    })
  }

  return groups
}

function buildExecutionStream(frame: TraceFrame, groups: FrameEntryGroup[], visibleBoundary: number) {
  const items: ExecutionStreamItem[] = [
    ...groups.map((group) => ({
      kind: 'group' as const,
      startIndex: group.firstGlobalIndex,
      group,
    })),
    ...frame.calls
      .filter((child) => child.startEntryIndex <= visibleBoundary)
      .map((child) => ({
        kind: 'child' as const,
        startIndex: child.startEntryIndex,
        frame: child,
      })),
  ]

  items.sort((left, right) => left.startIndex - right.startIndex)
  return items
}

function formatGroupLineRange(group: FrameEntryGroup) {
  if (group.startLine === null || group.endLine === null) {
    return null
  }
  return group.startLine === group.endLine
    ? `L${group.startLine}`
    : `L${group.startLine}-${group.endLine}`
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
  const before = line.slice(0, localStart)
  const highlighted = line.slice(localStart, localEnd)
  const after = line.slice(localEnd)

  return (
    <>
      {before}
      <mark class="source-inline-highlight">{highlighted || ' '}</mark>
      {after}
    </>
  )
}

type FrameTreeNodeProps = {
  frame: TraceFrame
  frameEntryMap: Map<string, FrameEntry[]>
  selectedFrameId: string
  selectedEntryIndex: number
  expandedFrameIds: Set<string>
  collapsedSourceGroupIds: Set<string>
  visibleCounts: Record<string, number>
  onSelectFrame: (frameId: string) => void
  onToggleFrame: (frameId: string) => void
  onSelectEntry: (frameId: string, entryIndex: number) => void
  onFocusSourceGroup: (frameId: string, fileIndex: number | null, entryIndex: number) => void
  onToggleSourceGroup: (groupId: string) => void
  onLoadMore: (frameId: string) => void
  registerGroupRef: (groupId: string, element: HTMLDivElement | null) => void
}

function FrameTreeNode(props: FrameTreeNodeProps) {
  const {
    frame,
    frameEntryMap,
    selectedFrameId,
    selectedEntryIndex,
    expandedFrameIds,
    collapsedSourceGroupIds,
    visibleCounts,
    onSelectFrame,
    onToggleFrame,
    onSelectEntry,
    onFocusSourceGroup,
    onToggleSourceGroup,
    onLoadMore,
    registerGroupRef,
  } = props

  const entries = frameEntryMap.get(frame.id) ?? []
  const visibleCount = visibleCounts[frame.id] ?? PAGE_SIZE
  const visibleEntries = entries.slice(0, visibleCount)
  const visibleGroups = useMemo(() => groupFrameEntriesBySource(frame.id, visibleEntries), [frame.id, visibleEntries])
  const isExpanded = expandedFrameIds.has(frame.id)
  const isSelected = selectedFrameId === frame.id
  const summary = frameChildrenSummary(frame)
  const maxGasCost = visibleEntries.reduce((max, item) => Math.max(max, item.entry.gasCost), 1)
  const visibleBoundary = visibleEntries.length > 0
    ? visibleEntries[visibleEntries.length - 1].globalIndex
    : frame.endEntryIndex
  const executionStream = useMemo(
    () => buildExecutionStream(frame, visibleGroups, visibleBoundary),
    [frame, visibleGroups, visibleBoundary],
  )

  return (
    <div class={`trace-frame-node depth-${frame.depth} ${isSelected ? 'is-selected' : ''}`.trim()}>
      <div class={`trace-frame-card ${isSelected ? 'is-selected' : ''}`.trim()}>
        <div class="trace-frame-card-header">
          <button
            type="button"
            class="trace-frame-toggle"
            onClick={() => onToggleFrame(frame.id)}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? 'Collapse frame' : 'Expand frame'}
          >
            <span class={`trace-chevron ${isExpanded ? 'trace-chevron-open' : ''}`}>▸</span>
          </button>
          <button
            type="button"
            class="trace-frame-summary"
            onClick={() => onSelectFrame(frame.id)}
          >
            <span class="trace-frame-main">
              <strong>{frameLabel(frame)}</strong>
              <span class="muted mono">{frame.type}</span>
            </span>
            <span class="trace-frame-meta">
              {frame.imageId ? (
                <span class="meta-badge meta-status meta-status-success">{frame.imageMatch}</span>
              ) : (
                <span class="muted">no image</span>
              )}
              <span class="muted">{formatNumber(entries.length)} ops</span>
              {frame.calls.length > 0 && <span class="muted">{formatNumber(frame.calls.length)} calls</span>}
            </span>
          </button>
        </div>
        {summary && <p class="trace-frame-children-summary muted">calls: {summary}</p>}

        {isExpanded && (
          <div class="trace-frame-body">
            {entries.length > 0 && (
              <div class="trace-frame-opcodes">
                {visibleGroups.length > 1 && (
                  <div class="trace-file-nav">
                    {visibleGroups.map((group, groupIndex) => (
                      <button
                        key={group.id}
                        type="button"
                        class={`trace-file-chip ${selectedEntryIndex >= group.firstGlobalIndex && selectedEntryIndex <= group.entries[group.entries.length - 1].globalIndex ? 'is-active' : ''}`.trim()}
                        onClick={() => {
                          onFocusSourceGroup(frame.id, group.fileIndex, group.firstGlobalIndex)
                        }}
                      >
                        <span class="mono">{groupIndex + 1}</span>
                        <span>{group.generated ? `[generated] ${group.shortLabel}` : group.shortLabel}</span>
                      </button>
                    ))}
                  </div>
                )}

                <div class="trace-frame-groups">
                  {executionStream.map((item) => {
                    if (item.kind === 'child') {
                      return (
                        <div key={item.frame.id} class="trace-stream-child">
                          <FrameTreeNode
                            frame={item.frame}
                            frameEntryMap={frameEntryMap}
                            selectedFrameId={selectedFrameId}
                            selectedEntryIndex={selectedEntryIndex}
                            expandedFrameIds={expandedFrameIds}
                            collapsedSourceGroupIds={collapsedSourceGroupIds}
                            visibleCounts={visibleCounts}
                            onSelectFrame={onSelectFrame}
                            onToggleFrame={onToggleFrame}
                            onSelectEntry={onSelectEntry}
                            onFocusSourceGroup={onFocusSourceGroup}
                            onToggleSourceGroup={onToggleSourceGroup}
                            onLoadMore={onLoadMore}
                            registerGroupRef={registerGroupRef}
                          />
                        </div>
                      )
                    }

                    const group = item.group
                    const groupIndex = visibleGroups.findIndex((candidate) => candidate.id === group.id)
                    const isGroupCollapsed = collapsedSourceGroupIds.has(group.id)
                    const isActiveGroup = selectedEntryIndex >= group.firstGlobalIndex && selectedEntryIndex <= group.lastGlobalIndex
                    const lineRange = formatGroupLineRange(group)

                    return (
                      <div
                        key={group.id}
                        ref={(element) => registerGroupRef(group.id, element)}
                        class={`trace-source-group ${isActiveGroup ? 'is-active' : ''}`.trim()}
                      >
                        <table class="opcode-table trace-frame-opcode-table trace-source-group-table">
                          <thead>
                            <tr class={`opcode-group-ribbon-row ${isActiveGroup ? 'is-active' : ''}`.trim()}>
                              <th colSpan={5}>
                                <div class="opcode-group-ribbon">
                                  <div class="opcode-group-ribbon-main">
                                    <button
                                      type="button"
                                      class="trace-source-group-toggle"
                                      onClick={() => onToggleSourceGroup(group.id)}
                                      aria-expanded={!isGroupCollapsed}
                                      aria-label={isGroupCollapsed ? 'Expand source group' : 'Collapse source group'}
                                    >
                                      <span class={`trace-chevron ${isGroupCollapsed ? '' : 'trace-chevron-open'}`}>▸</span>
                                    </button>
                                    <button
                                      type="button"
                                      class="opcode-group-ribbon-button"
                                      onClick={() => onFocusSourceGroup(frame.id, group.fileIndex, group.firstGlobalIndex)}
                                    >
                                      <span class="trace-source-group-title">
                                        <span class="trace-source-group-index mono">#{groupIndex + 1}</span>
                                        <strong>{group.generated ? `[generated] ${group.shortLabel}` : group.shortLabel}</strong>
                                      </span>
                                      <span class="trace-source-group-meta">
                                        {lineRange && <span class="meta-badge">{lineRange}</span>}
                                        <span class="muted">{formatNumber(group.entries.length)} ops</span>
                                        <span class="muted">{`steps ${formatNumber(group.firstGlobalIndex)}-${formatNumber(group.lastGlobalIndex)}`}</span>
                                      </span>
                                    </button>
                                  </div>
                                  <span class="trace-source-group-path mono">{group.label}</span>
                                </div>
                              </th>
                            </tr>
                            {!isGroupCollapsed && (
                              <tr>
                                <th>#</th>
                                <th>PC</th>
                                <th>Opcode</th>
                                <th>Gas</th>
                                <th>Source</th>
                              </tr>
                            )}
                          </thead>
                          {!isGroupCollapsed && (
                            <tbody>
                              {group.entries.map(({ globalIndex, entry, step }) => {
                                const source = step.source
                                const isEntrySelected = globalIndex === selectedEntryIndex
                                const gasIntensity = Math.min(entry.gasCost / maxGasCost, 1)

                                return (
                                  <tr
                                    key={globalIndex}
                                    class={`opcode-row ${CALL_TYPES.has(entry.op) ? 'opcode-call' : ''} ${isEntrySelected ? 'opcode-row-highlight' : ''} ${isActiveGroup ? 'opcode-row-group-highlight' : ''}`.trim()}
                                    onClick={() => onSelectEntry(frame.id, globalIndex)}
                                  >
                                    <td class="muted">{globalIndex}</td>
                                    <td class="mono">{entry.pc}</td>
                                    <td class="mono">
                                      <strong>{entry.op}</strong>
                                      {frame.proxyContext === 'delegate' && entry.op === 'DELEGATECALL' && (
                                        <span class="opcode-call-label"> delegate boundary</span>
                                      )}
                                    </td>
                                    <td class="mono">
                                      <span class="opcode-gas-heat" style={{ opacity: 0.3 + gasIntensity * 0.7 }}>
                                        {formatNumber(entry.gasCost)}
                                      </span>
                                    </td>
                                    <td class="mono opcode-source-cell">
                                      {source ? `${source.filePath.split('/').pop()}:${source.line}:${source.column}` : ''}
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          )}
                        </table>
                      </div>
                    )
                  })}
                </div>

                {visibleCount < entries.length && (
                  <button class="opcode-load-more" onClick={() => onLoadMore(frame.id)}>
                    Load more ({formatNumber(entries.length - visibleCount)} remaining)
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function OpcodeSourceView({ trace, callTree, loadRuntimeCode }: Props) {
  const { refreshKey } = useExplorer()
  const [codeImages, setCodeImages] = useState<CodeImageRecord[]>([])
  const [sourceFiles, setSourceFiles] = useState<SourceFileRecord[]>([])
  const [frames, setFrames] = useState<TraceFrame[]>([])
  const [steps, setSteps] = useState<TraceStepLocation[]>([])
  const [imageSourceData, setImageSourceData] = useState<Map<string, ImageSourceData>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedFrameId, setSelectedFrameId] = useState<string>(callTree.id)
  const [selectedEntryIndex, setSelectedEntryIndex] = useState(0)
  const [selectedFileIndexOverride, setSelectedFileIndexOverride] = useState<number | null>(null)
  const [expandedFrameIds, setExpandedFrameIds] = useState<Set<string>>(new Set([callTree.id]))
  const [collapsedSourceGroupIds, setCollapsedSourceGroupIds] = useState<Set<string>>(new Set())
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({})
  const [syncGroupId, setSyncGroupId] = useState<string | null>(null)
  const hierarchyPaneRef = useRef<HTMLDivElement | null>(null)
  const sourcePaneRef = useRef<HTMLDivElement | null>(null)
  const groupRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())
  const sourceLineRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())

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

        setCodeImages(nextCodeImages)
        setSourceFiles(nextSourceFiles)
        setFrames(model.frames)
        setSteps(model.steps)
        setImageSourceData(model.imageSourceData)
        setSelectedFrameId(callTree.id)
        setSelectedEntryIndex(model.frames[0]?.startEntryIndex ?? 0)
        setSelectedFileIndexOverride(null)
        setExpandedFrameIds(new Set([callTree.id]))
        setCollapsedSourceGroupIds(new Set())
        setVisibleCounts({})
        setSyncGroupId(null)
      } catch (caughtError: unknown) {
        if (!cancelled) {
          setError(caughtError instanceof Error ? caughtError.message : 'Unable to build source trace')
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
  const sourceFileByPath = useMemo(() => new Map(sourceFiles.map((file) => [file.path, file] as const)), [sourceFiles])
  const selectedFrame = frameById.get(selectedFrameId) ?? flatFrames[0] ?? null
  const selectedFrameEntries = useMemo(() => {
    if (!selectedFrame) {
      return []
    }

    const start = Math.max(selectedFrame.startEntryIndex, 0)
    const end = Math.max(selectedFrame.endEntryIndex, start)
    const result: Array<{ globalIndex: number; entry: OpcodeEntry; step: TraceStepLocation }> = []

    for (let index = start; index <= end && index < trace.entries.length; index++) {
      const step = steps[index]
      if (!step || step.frameId !== selectedFrame.id) {
        continue
      }

      result.push({
        globalIndex: index,
        entry: trace.entries[index],
        step,
      })
    }

    return result
  }, [selectedFrame, steps, trace.entries])
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

  const selectedStep = steps[selectedEntryIndex] ?? null
  const selectedImage = selectedFrame?.imageId ? imageById.get(selectedFrame.imageId) ?? null : null
  const selectedImageSourceData = selectedFrame?.imageId ? imageSourceData.get(selectedFrame.imageId) ?? null : null
  const selectedSource = selectedStep?.source ?? null
  const imageFiles = useMemo(() => {
    if (!selectedImage || !selectedImageSourceData) {
      return []
    }

    return [...selectedImageSourceData.sourceContents.keys()]
      .sort((left, right) => left - right)
      .map((fileIndex) => ({
        fileIndex,
        filePath: selectedImage.fileIndexMap[fileIndex] ?? `file ${fileIndex}`,
        generated: (selectedImage.fileIndexMap[fileIndex] ?? '').startsWith('<generated:'),
      }))
  }, [selectedImage, selectedImageSourceData])
  const activeFileIndex = selectedFileIndexOverride
    ?? selectedSource?.fileIndex
    ?? imageFiles[0]?.fileIndex
    ?? null
  const activeFilePath = activeFileIndex !== null && activeFileIndex !== undefined
    ? selectedImage?.fileIndexMap[activeFileIndex] ?? null
    : null
  const activeFileContent = activeFileIndex !== null && activeFileIndex !== undefined
    ? selectedImageSourceData?.sourceContents?.get(activeFileIndex) ?? null
    : null
  const activeSourceFile = useMemo(() => {
    if (!activeFilePath) {
      return null
    }

    const exact = sourceFileByPath.get(activeFilePath)
    if (exact) {
      return exact
    }

    for (const [path, file] of sourceFileByPath) {
      if (path.endsWith(activeFilePath) || activeFilePath.endsWith(path)) {
        return file
      }
    }

    return null
  }, [activeFilePath, sourceFileByPath])
  const astIntervals = useMemo(
    () => buildAstIntervals(activeSourceFile?.ast ?? null, activeSourceFile?.sourceId),
    [activeSourceFile?.ast, activeSourceFile?.sourceId],
  )
  const astContext = useMemo(
    () => selectedSource ? findAstContext(astIntervals, selectedSource.start, selectedSource.length) : null,
    [astIntervals, selectedSource?.start, selectedSource?.length],
  )

  const topOpcodes = useMemo(() => {
    const gasByOp = new Map<string, number>()
    for (const item of selectedFrameEntries) {
      gasByOp.set(item.entry.op, (gasByOp.get(item.entry.op) ?? 0) + item.entry.gasCost)
    }
    return [...gasByOp.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5)
  }, [selectedFrameEntries])

  const { lineGasMap, maxLineGas } = useMemo(() => {
    if (!selectedImage || !selectedImageSourceData) {
      return { lineGasMap: new Map<string, number>(), maxLineGas: 1 }
    }

    const gasMap = buildLineGasMap(
      selectedFrameEntries.map((item) => item.entry),
      selectedImageSourceData.pcToSource,
      selectedImageSourceData.sourceContents,
    )

    let max = 1
    for (const value of gasMap.values()) {
      max = Math.max(max, value)
    }

    return { lineGasMap: gasMap, maxLineGas: max }
  }, [selectedFrameEntries, selectedImage, selectedImageSourceData])

  const selectedVisibleGroups = useMemo(() => {
    if (!selectedFrame) {
      return []
    }
    const visibleCount = visibleCounts[selectedFrame.id] ?? PAGE_SIZE
    return groupFrameEntriesBySource(selectedFrame.id, selectedFrameEntries.slice(0, visibleCount))
  }, [selectedFrame, selectedFrameEntries, visibleCounts])

  const activeFileGroupMarkers = useMemo(() => {
    if (activeFileIndex === null || activeFileIndex === undefined) {
      return []
    }

    return selectedVisibleGroups
      .map((group, groupIndex) => ({
        groupId: group.id,
        groupIndex: groupIndex + 1,
        shortLabel: group.shortLabel,
        firstGlobalIndex: group.firstGlobalIndex,
        opCount: group.entries.length,
        startLine: group.startLine,
        endLine: group.endLine,
      }))
      .filter((group): group is SourceLineGroupMarker => (
        group.startLine !== null
        && group.endLine !== null
        && selectedVisibleGroups[group.groupIndex - 1]?.fileIndex === activeFileIndex
      ))
  }, [activeFileIndex, selectedVisibleGroups])

  const activeSelectedGroup = useMemo(() => (
    selectedVisibleGroups.find((group) => selectedEntryIndex >= group.firstGlobalIndex && selectedEntryIndex <= group.lastGlobalIndex) ?? null
  ), [selectedEntryIndex, selectedVisibleGroups])

  const sourceLineGroupStartMap = useMemo(() => {
    const map = new Map<number, SourceLineGroupMarker[]>()
    for (const marker of activeFileGroupMarkers) {
      const bucket = map.get(marker.startLine) ?? []
      bucket.push(marker)
      map.set(marker.startLine, bucket)
    }
    return map
  }, [activeFileGroupMarkers])

  const sourceLineGroupCoverMap = useMemo(() => {
    const map = new Map<number, SourceLineGroupMarker>()
    for (const marker of activeFileGroupMarkers) {
      for (let line = marker.startLine; line <= marker.endLine; line++) {
        if (!map.has(line)) {
          map.set(line, marker)
        }
      }
    }
    return map
  }, [activeFileGroupMarkers])

  useEffect(() => {
    if (!selectedSource) {
      return
    }

    const key = `${selectedSource.fileIndex}:${selectedSource.line}`
    sourceLineRefs.current.get(key)?.scrollIntoView({ block: 'center' })
  }, [selectedEntryIndex, selectedSource?.fileIndex, selectedSource?.line])

  useEffect(() => {
    if (!syncGroupId || !activeSelectedGroup || activeSelectedGroup.id !== syncGroupId) {
      return
    }

    groupRefs.current.get(activeSelectedGroup.id)?.scrollIntoView({ block: 'center', behavior: 'smooth' })

    if (
      activeSelectedGroup.fileIndex !== null
      && activeSelectedGroup.startLine !== null
    ) {
      const key = `${activeSelectedGroup.fileIndex}:${activeSelectedGroup.startLine}`
      sourceLineRefs.current.get(key)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }

    setSyncGroupId(null)
  }, [syncGroupId, activeSelectedGroup?.id])

  function handleFrameSelect(frameId: string) {
    const frame = frameById.get(frameId)
    setSelectedFrameId(frameId)
    setSelectedEntryIndex(frame?.startEntryIndex ?? 0)
    setSelectedFileIndexOverride(null)
    setSyncGroupId(null)
    setExpandedFrameIds((current) => {
      const next = new Set(current)
      next.add(frameId)
      return next
    })
  }

  function handleFrameToggle(frameId: string) {
    setExpandedFrameIds((current) => {
      const next = new Set(current)
      if (next.has(frameId)) {
        next.delete(frameId)
      } else {
        next.add(frameId)
      }
      return next
    })
  }

  function handleEntrySelect(frameId: string, entryIndex: number) {
    setSelectedFrameId(frameId)
    setSelectedEntryIndex(entryIndex)
    setSelectedFileIndexOverride(null)
    setSyncGroupId(null)
    setExpandedFrameIds((current) => {
      const next = new Set(current)
      next.add(frameId)
      return next
    })
  }

  function handleSourceGroupFocus(frameId: string, fileIndex: number | null, entryIndex: number) {
    const frame = frameById.get(frameId)
    const frameEntries = frame ? frameEntryMap.get(frameId) ?? [] : []
    const visibleCount = visibleCounts[frameId] ?? PAGE_SIZE
    const targetGroup = groupFrameEntriesBySource(frameId, frameEntries.slice(0, visibleCount))
      .find((group) => entryIndex >= group.firstGlobalIndex && entryIndex <= group.lastGlobalIndex)

    setSelectedFrameId(frameId)
    setSelectedEntryIndex(entryIndex)
    setSelectedFileIndexOverride(fileIndex)
    setSyncGroupId(targetGroup?.id ?? null)
    setExpandedFrameIds((current) => {
      const next = new Set(current)
      next.add(frameId)
      return next
    })
  }

  function handleSourceGroupToggle(groupId: string) {
    setCollapsedSourceGroupIds((current) => {
      const next = new Set(current)
      if (next.has(groupId)) {
        next.delete(groupId)
      } else {
        next.add(groupId)
      }
      return next
    })
  }

  function registerGroupRef(groupId: string, element: HTMLDivElement | null) {
    if (element) {
      groupRefs.current.set(groupId, element)
    } else {
      groupRefs.current.delete(groupId)
    }
  }

  function handleFrameLoadMore(frameId: string) {
    setVisibleCounts((current) => ({
      ...current,
      [frameId]: (current[frameId] ?? PAGE_SIZE) + PAGE_SIZE,
    }))
  }

  function handleSourceLineClick(fileIndex: number, line: number) {
    const match = selectedFrameEntries.find((item) => item.step.source?.fileIndex === fileIndex && item.step.source?.line === line)
    if (match) {
      setSelectedEntryIndex(match.globalIndex)
      setSelectedFileIndexOverride(null)
    }
  }

  if (loading) {
    return <p class="muted">Building source trace…</p>
  }

  if (error) {
    return <p class="muted">{error}</p>
  }

  if (flatFrames.length === 0) {
    return <p class="muted">No trace frames available.</p>
  }

  const activeFile = activeFileContent ? buildLineOffsets(activeFileContent) : null

  return (
    <div class="trace-source-view">
      <div class="opcode-summary">
        <div class="opcode-summary-stats">
          <span><strong>{formatNumber(trace.entries.length)}</strong> steps</span>
          <span><strong>{formatNumber(flatFrames.length)}</strong> frames</span>
          <span><strong>{formatNumber(trace.totalGas)}</strong> total gas</span>
        </div>
        <div class="opcode-top-gas">
          <span class="eyebrow">Top gas in frame</span>
          <div class="opcode-top-gas-list">
            {topOpcodes.map(([op, gas]) => (
              <span key={op} class="opcode-top-gas-item">
                <span class="mono">{op}</span>
                <span class="muted">{formatNumber(gas)}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div class="trace-layout">
        <div ref={hierarchyPaneRef} class="trace-hierarchy-pane">
          <div class="source-pane-header">
            <span>Execution Hierarchy</span>
          </div>
          <div class="trace-frame-tree">
            {frames.map((frame) => (
              <FrameTreeNode
                key={frame.id}
                frame={frame}
                frameEntryMap={frameEntryMap}
                selectedFrameId={selectedFrameId}
                selectedEntryIndex={selectedEntryIndex}
                expandedFrameIds={expandedFrameIds}
                collapsedSourceGroupIds={collapsedSourceGroupIds}
                visibleCounts={visibleCounts}
                onSelectFrame={handleFrameSelect}
                onToggleFrame={handleFrameToggle}
                onSelectEntry={handleEntrySelect}
                onFocusSourceGroup={handleSourceGroupFocus}
                onToggleSourceGroup={handleSourceGroupToggle}
                onLoadMore={handleFrameLoadMore}
                registerGroupRef={registerGroupRef}
              />
            ))}
          </div>
        </div>

        <div ref={sourcePaneRef} class="source-pane trace-source-pane">
          <div class="source-pane-header">
            <div class="source-pane-filebox">
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
          </div>
          {(selectedSource || astContext) && (
            <div class="trace-context-panel">
              {selectedSource && (
                <div class="trace-context-row">
                  <span class="eyebrow">Span</span>
                  <span class="mono">{`${selectedSource.filePath.split('/').pop()}:${selectedSource.line}:${selectedSource.column} (${selectedSource.length} chars)`}</span>
                </div>
              )}
              {selectedFrame && (
                <>
                  <div class="trace-context-row">
                    <span class="eyebrow">Execution</span>
                    <span class="mono">
                      {selectedFrame.codeAddress ?? 'n/a'}
                      {selectedImage && ` -> ${selectedImage.contractName} (${selectedImage.kind})`}
                    </span>
                  </div>
                  <div class="trace-context-row">
                    <span class="eyebrow">Storage</span>
                    <span class="mono">{selectedFrame.contextAddress ?? 'n/a'}</span>
                  </div>
                  <div class="trace-context-row">
                    <span class="eyebrow">Context</span>
                    <span>
                      {selectedFrame.proxyContext === 'delegate'
                        ? 'delegatecall: borrowed code, parent storage context'
                        : selectedFrame.proxyContext === 'callcode'
                          ? 'callcode: legacy borrowed code, caller storage context'
                          : 'direct execution context'}
                    </span>
                  </div>
                  <div class="trace-context-row">
                    <span class="eyebrow">Image Match</span>
                    <span>{selectedFrame.imageId ? selectedFrame.imageMatch : 'no imported image matched this frame'}</span>
                  </div>
                </>
              )}
              {astContext && (
                <>
                  <div class="trace-context-row">
                    <span class="eyebrow">Function</span>
                    <span>{formatAstLabel(astContext.functionLike)}</span>
                  </div>
                  <div class="trace-context-row">
                    <span class="eyebrow">Statement</span>
                    <span>{formatAstLabel(astContext.statement)}</span>
                  </div>
                  <div class="trace-context-row">
                    <span class="eyebrow">Scope</span>
                    <span>{formatAstLabel(astContext.contract ?? astContext.declaration)}</span>
                  </div>
                </>
              )}
            </div>
          )}
          {!selectedFrame?.imageId && (
            <p class="muted" style={{ padding: '16px' }}>
              This frame could not be matched to an imported Foundry code image. Re-import the project with `build-info` enabled.
            </p>
          )}
          {selectedFrame?.imageId && !activeFile && (
            <p class="muted" style={{ padding: '16px' }}>
              No mapped source file is available for the selected frame.
            </p>
          )}
          {activeFile && activeFilePath && (
            <div class="source-code-view">
              {activeFile.lines.map((line, lineIdx) => {
                const lineNum = lineIdx + 1
                const key = `${String(activeFileIndex)}:${lineNum}`
                const lineGas = lineGasMap.get(key)
                const gasIntensity = lineGas ? Math.min(lineGas / maxLineGas, 1) : 0
                const isFocused = selectedSource?.fileIndex === activeFileIndex && selectedSource.line === lineNum
                const groupCover = sourceLineGroupCoverMap.get(lineNum)
                const groupStarts = sourceLineGroupStartMap.get(lineNum) ?? []
                const isInActiveGroup = !!(
                  activeSelectedGroup
                  && activeSelectedGroup.fileIndex === activeFileIndex
                  && activeSelectedGroup.startLine !== null
                  && activeSelectedGroup.endLine !== null
                  && lineNum >= activeSelectedGroup.startLine
                  && lineNum <= activeSelectedGroup.endLine
                )
                const lineStart = activeFile.offsets[lineIdx]
                const lineSelectedSpan = selectedSource?.fileIndex === activeFileIndex ? selectedSource : null

                return (
                  <div
                    key={lineNum}
                    ref={(element) => {
                      sourceLineRefs.current.set(key, element)
                    }}
                    class={`source-line ${isFocused ? 'source-line-focused' : ''} ${lineGas !== undefined ? 'source-line-has-cost' : ''} ${groupCover ? 'source-line-group-covered' : ''} ${isInActiveGroup ? 'source-line-group-active' : ''}`.trim()}
                    style={gasIntensity > 0 && !isFocused ? { background: `rgba(var(--warning-rgb, 234, 179, 8), ${gasIntensity * 0.15})` } : undefined}
                    onClick={() => handleSourceLineClick(activeFileIndex as number, lineNum)}
                  >
                    <span class="source-line-number">{lineNum}</span>
                    {groupStarts.length > 0 && (
                      <span class="source-line-group-marker-lane">
                        {groupStarts.map((marker) => (
                          <button
                            key={marker.groupId}
                            type="button"
                            class="source-line-group-marker"
                            onClick={(event) => {
                              event.stopPropagation()
                              handleSourceGroupFocus(selectedFrame?.id ?? callTree.id, activeFileIndex as number, marker.firstGlobalIndex)
                            }}
                          >
                            <span class="mono">#{marker.groupIndex}</span>
                            <span>{`L${marker.startLine}-${marker.endLine}`}</span>
                            <span>{formatNumber(marker.opCount)} ops</span>
                          </button>
                        ))}
                      </span>
                    )}
                    <span class="source-line-code mono">
                      {renderHighlightedLine(
                        line,
                        lineStart,
                        lineSelectedSpan,
                      )}
                    </span>
                    {lineGas !== undefined && <span class="source-gas-gutter mono">{formatNumber(lineGas)}</span>}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
