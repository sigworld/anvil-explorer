import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { decodeEventLog, decodeErrorResult, decodeFunctionResult, getAbiItem, parseAbi } from 'viem'
import type { Abi, Hex } from 'viem'
import { getAbi, getResolvedAddressLabel, listAbis, listCodeImages, listSourceFiles } from '../lib/db.ts'
import { mergeAbis } from '../lib/decode.ts'
import { createAnvilClient, getProxyImplementation } from '../lib/rpc.ts'
import { useExplorer } from '../hooks/use-explorer.tsx'
import { formatNumber } from '../lib/format.ts'
import { buildSourceTraceModel } from '../lib/trace-source.ts'
import type { ImageSourceData } from '../lib/source-map.ts'
import type { OpcodeEntry, OpcodeTrace, TraceNode, TraceStepLocation } from '../lib/types.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Props = {
  trace: TraceNode
  opcodeTrace?: OpcodeTrace | null
  opcodeLoading?: boolean
  onRequestOpcodeTrace?: () => void
  loadRuntimeCode: (address: Hex) => Promise<Hex>
  /** Start with full trace mode enabled (also enables storage + events) */
  initialFullTrace?: boolean
  /** Embedded mode: hides toolbar and footer, disables source popup */
  embedded?: boolean
  /** Called when a row is clicked in embedded mode — receives the opcode entry index */
  onEntrySelect?: (entryIndex: number) => void
}

type RowKind = 'call' | 'sload' | 'sstore' | 'log' | 'jump'

type SourceRef = {
  filePath: string
  line: number
  column?: number
  fileIndex: number
}

type FlatRow = {
  id: string
  depth: number
  kind: RowKind
  gasUsed: string | null
  gasCost: number | null
  description: string
  returnDescription: string | null
  status: 'success' | 'reverted' | 'failed'
  hasChildren: boolean
  opBadge: string
  badgeType: string
  label: string | null
  address: string | null
  searchText: string
  sourceRef: SourceRef | null
  /** Index into the opcode trace entries array, if applicable */
  entryIndex: number | null
}

type LabelMap = Map<string, string>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const standardErrors = parseAbi([
  'error Error(string)',
  'error Panic(uint256)',
])

const LOG_OPS = new Set(['LOG0', 'LOG1', 'LOG2', 'LOG3', 'LOG4'])

function stringifyArg(value: { name: string; value: string }) {
  return `${value.name} = ${value.value}`
}

function buildCallDescription(node: TraceNode, contractName: string | null): string {
  const target = contractName ?? (node.to ?? '???')
  const funcLabel = node.functionName ?? node.selector ?? (
    node.type === 'CREATE' || node.type === 'CREATE2' ? 'constructor' : 'fallback'
  )
  const argsStr = node.args.length > 0
    ? `(${node.args.map(stringifyArg).join(', ')})`
    : node.input && node.input.length > 10 ? `(${node.input})` : '()'

  return `${target}.${funcLabel}${argsStr}`
}

function buildReturnDescription(node: TraceNode, abiMap: Map<string, Abi>): string | null {
  if (node.status === 'reverted' || node.status === 'failed') {
    if (node.revertReason) return node.revertReason
    if (node.error) return node.error
    if (node.output && node.output !== '0x' && node.output.length >= 10) {
      const candidates = node.to ? [abiMap.get(node.to.toLowerCase())] : []
      candidates.push(standardErrors as unknown as Abi)
      for (const abi of candidates) {
        if (!abi) continue
        try {
          const decoded = decodeErrorResult({ abi, data: node.output as Hex })
          if (decoded.errorName === 'Error' && decoded.args?.[0]) {
            return String(decoded.args[0])
          }
          return decoded.errorName
        } catch { continue }
      }
    }
    return null
  }

  if (!node.output || node.output === '0x') return '()'

  if (node.to && node.input && node.input.length >= 10) {
    const abi = abiMap.get(node.to.toLowerCase())
    if (abi) {
      try {
        const selector = node.input.slice(0, 10) as Hex
        const abiItem = getAbiItem({ abi, name: selector })
        if (abiItem && abiItem.type === 'function' && abiItem.outputs) {
          const values = decodeFunctionResult({ abi, data: node.output as Hex, functionName: abiItem.name })
          const results = Array.isArray(values) ? values : [values]
          const parts = results.map((v, i) => {
            const name = abiItem.outputs?.[i]?.name || ''
            const formatted = typeof v === 'bigint' ? v.toString() : String(v)
            return name ? `${name}: ${formatted}` : formatted
          })
          return `(${parts.join(', ')})`
        }
      } catch { /* fall through */ }
    }
  }

  return `(${node.output})`
}

function getOpBadge(nodeType: string): string {
  switch (nodeType) {
    case 'STATICCALL': return 'S\u00b7CALL'
    case 'DELEGATECALL': return 'D\u00b7CALL'
    case 'CALLCODE': return 'C\u00b7CODE'
    default: return nodeType
  }
}

// ---------------------------------------------------------------------------
// Call-only flattening (no opcode trace needed)
// ---------------------------------------------------------------------------

function buildCallRow(node: TraceNode, depth: number, labelMap: LabelMap, abiMap: Map<string, Abi>, entryIndex: number | null = null): FlatRow {
  const label = node.to ? labelMap.get(node.to.toLowerCase()) ?? null : null
  const desc = buildCallDescription(node, label)
  return {
    id: node.id,
    depth,
    kind: 'call',
    gasUsed: node.gasUsed,
    gasCost: null,
    description: desc,
    returnDescription: buildReturnDescription(node, abiMap),
    status: node.status,
    hasChildren: node.calls.length > 0,
    opBadge: getOpBadge(node.type),
    badgeType: node.type.toLowerCase(),
    label,
    address: node.to,
    searchText: `${label ?? ''} ${desc} ${node.to ?? ''}`.toLowerCase(),
    sourceRef: null,
    entryIndex,
  }
}

function flattenCallTree(
  node: TraceNode,
  labelMap: LabelMap,
  abiMap: Map<string, Abi>,
  depth: number = 0,
): FlatRow[] {
  const rows: FlatRow[] = [buildCallRow(node, depth, labelMap, abiMap)]

  for (const child of node.calls) {
    rows.push(...flattenCallTree(child, labelMap, abiMap, depth + 1))
  }

  return rows
}

// ---------------------------------------------------------------------------
// Interleaved flattening (uses opcode trace for SLOAD/SSTORE/LOG/JUMP rows)
// ---------------------------------------------------------------------------

function extractSlot(entry: OpcodeEntry): string {
  const top = entry.stack.length - 1
  return entry.stack[top] ?? '0x?'
}

function extractStoreValue(entry: OpcodeEntry): string {
  const top = entry.stack.length - 1
  return entry.stack[top - 1] ?? '0x?'
}

type ExtractedLog = {
  topics: Hex[]
  data: Hex
  decoded: string | null
}

/** Pad a hex value to 32 bytes (66 chars with 0x prefix) for topic matching */
function padTopic(value: string): Hex {
  const stripped = value.startsWith('0x') ? value.slice(2) : value
  return `0x${stripped.padStart(64, '0')}` as Hex
}

function extractLogData(
  entry: OpcodeEntry,
  numTopics: number,
  abiMap: Map<string, Abi>,
  currentAddress: string | null,
): ExtractedLog {
  const top = entry.stack.length - 1
  // LOG stack layout (from top): offset, size, topic0, topic1, ...
  const topics: Hex[] = []
  for (let t = 0; t < numTopics; t++) {
    const raw = entry.stack[top - 2 - t]
    if (raw) topics.push(padTopic(raw))
  }

  // Extract data from memory
  let data: Hex = '0x'
  try {
    const offset = Number(BigInt(entry.stack[top] ?? '0'))
    const size = Number(BigInt(entry.stack[top - 1] ?? '0'))
    if (entry.memory && size > 0) {
      const memHex = entry.memory.map((w) => (w.startsWith('0x') ? w.slice(2) : w)).join('')
      const start = offset * 2
      const end = start + size * 2
      if (end <= memHex.length) {
        data = `0x${memHex.slice(start, end)}` as Hex
      }
    }
  } catch { /* offset/size parse failed */ }

  // Try ABI decode — try the current address first, then all other ABIs
  let decoded: string | null = null
  if (topics.length > 0) {
    const abisToTry: Abi[] = []
    if (currentAddress) {
      const primary = abiMap.get(currentAddress.toLowerCase())
      if (primary) abisToTry.push(primary)
    }
    for (const [addr, abi] of abiMap) {
      if (addr !== currentAddress?.toLowerCase()) abisToTry.push(abi)
    }

    for (const abi of abisToTry) {
      try {
        const result = decodeEventLog({
          abi,
          data,
          topics: topics as [Hex, ...Hex[]],
          strict: false,
        })
        const abiItem = getAbiItem({ abi, name: topics[0] })
        const inputs = abiItem?.type === 'event' ? abiItem.inputs ?? [] : []

        // viem returns args as a named object or array depending on the ABI
        let argParts: string[]
        if (Array.isArray(result.args)) {
          argParts = result.args.map((v: unknown, idx: number) => {
            const name = inputs[idx]?.name ?? `arg${idx}`
            const formatted = typeof v === 'bigint' ? v.toString() : String(v)
            return `${name} = ${formatted}`
          })
        } else if (result.args && typeof result.args === 'object') {
          if (inputs.length > 0) {
            // Use ABI input order to extract named args
            argParts = inputs
              .map((input, idx) => {
                const key = input.name || `arg${idx}`
                const value = (result.args as unknown as Record<string, unknown>)?.[key]
                if (value === undefined) return null
                const formatted = typeof value === 'bigint' ? value.toString() : String(value)
                return `${key} = ${formatted}`
              })
              .filter((v): v is string => v !== null)
          } else {
            // Fallback: iterate object entries
            argParts = Object.entries(result.args).map(([name, value]) => {
              const formatted = typeof value === 'bigint' ? (value as bigint).toString() : String(value)
              return `${name} = ${formatted}`
            })
          }
        } else {
          argParts = []
        }

        decoded = `${result.eventName}(${argParts.join(', ')})`
        break
      } catch { continue }
    }
  }

  return { topics, data, decoded }
}

function formatLogDescription(contractTag: string, log: ExtractedLog): string {
  const parts: string[] = [contractTag]

  if (log.decoded) {
    parts.push(log.decoded)
  }

  // Always show raw topics and data
  if (log.topics.length > 0) {
    const topicStrs = log.topics.map((t, idx) => `topic${idx} = ${t}`)
    parts.push(`[${topicStrs.join(', ')}]`)
  }

  if (log.data !== '0x') {
    parts.push(`data = ${log.data}`)
  }

  return parts.join(' ')
}

function flattenWithOpcodes(
  trace: TraceNode,
  entries: OpcodeEntry[],
  labelMap: LabelMap,
  abiMap: Map<string, Abi>,
  opts: { storage: boolean; events: boolean; fullTrace: boolean },
  steps?: TraceStepLocation[] | null,
): FlatRow[] {
  const rows: FlatRow[] = []

  // Walk the call tree and opcode entries in parallel using depth tracking
  type FrameState = { node: TraceNode; nextChild: number }
  const stack: FrameState[] = [{ node: trace, nextChild: 0 }]
  let prevDepth = entries[0]?.depth ?? 1
  let lastJumpContext = ''

  rows.push(buildCallRow(trace, 0, labelMap, abiMap, 0))

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const curDepth = entry.depth

    // Handle depth changes — new call entered
    if (curDepth !== prevDepth) lastJumpContext = ''
    if (curDepth > prevDepth) {
      const parent = stack[stack.length - 1]
      if (parent) {
        const child = parent.node.calls[parent.nextChild]
        if (child) {
          parent.nextChild++
          stack.push({ node: child, nextChild: 0 })
          rows.push(buildCallRow(child, stack.length - 1, labelMap, abiMap, i))
        }
      }
    } else if (curDepth < prevDepth) {
      // Returned from one or more calls
      const diff = prevDepth - curDepth
      for (let d = 0; d < diff && stack.length > 1; d++) {
        stack.pop()
      }
    }
    prevDepth = curDepth

    const currentFrame = stack[stack.length - 1]
    const currentNode = currentFrame?.node ?? trace
    const treeDepth = stack.length - 1
    const currentAddress = currentNode.to ?? (entry.address ? `0x${entry.address.replace(/^0x/, '')}` : null)
    const currentLabel = currentAddress ? labelMap.get(currentAddress.toLowerCase()) ?? null : null
    const contractTag = currentLabel ?? (currentAddress ?? '???')

    // SLOAD
    if (opts.storage && entry.op === 'SLOAD') {
      const slot = extractSlot(entry)
      const nextEntry = entries[i + 1]
      const value = nextEntry ? nextEntry.stack[nextEntry.stack.length - 1] ?? '?' : '?'
      const desc = `${contractTag} [${slot} = ${value}]`
      rows.push({
        id: `sload-${i}`,
        depth: treeDepth + 1,
        kind: 'sload',
        gasUsed: null,
        gasCost: entry.gasCost,
        description: desc,
        returnDescription: null,
        status: 'success',
        hasChildren: false,
        opBadge: 'SLOAD',
        badgeType: 'sload',
        label: currentLabel,
        address: currentAddress,
        searchText: `${contractTag} ${slot} ${value} sload`.toLowerCase(),
        sourceRef: null,
        entryIndex: i,
      })
    }

    // SSTORE
    if (opts.storage && entry.op === 'SSTORE') {
      const slot = extractSlot(entry)
      const value = extractStoreValue(entry)
      const desc = `${contractTag} [${slot} ← ${value}]`
      rows.push({
        id: `sstore-${i}`,
        depth: treeDepth + 1,
        kind: 'sstore',
        gasUsed: null,
        gasCost: entry.gasCost,
        description: desc,
        returnDescription: null,
        status: 'success',
        hasChildren: false,
        opBadge: 'SSTORE',
        badgeType: 'sstore',
        label: currentLabel,
        address: currentAddress,
        searchText: `${contractTag} ${slot} ${value} sstore`.toLowerCase(),
        sourceRef: null,
        entryIndex: i,
      })
    }

    // LOG events
    if (opts.events && LOG_OPS.has(entry.op)) {
      const numTopics = parseInt(entry.op.slice(3), 10)
      const log = extractLogData(entry, numTopics, abiMap, currentAddress)
      const desc = formatLogDescription(contractTag, log)
      rows.push({
        id: `log-${i}`,
        depth: treeDepth + 1,
        kind: 'log',
        gasUsed: null,
        gasCost: entry.gasCost,
        description: desc,
        returnDescription: null,
        status: 'success',
        hasChildren: false,
        opBadge: entry.op,
        badgeType: 'log',
        label: currentLabel,
        address: currentAddress,
        searchText: `${contractTag} ${log.decoded ?? ''} ${log.topics.join(' ')} log event`.toLowerCase(),
        sourceRef: null,
        entryIndex: i,
      })
    }

    // Full trace: show JUMPs only at internal function boundaries
    // Use the NEXT step (the JUMPDEST landing) for AST context since the JUMP
    // instruction's PC still maps to the call site, not the target function.
    // Use functionSource (from AST interval) for line numbers — the opcode source map
    // often doesn't have an entry at the exact function declaration offset.
    if (opts.fullTrace && (entry.op === 'JUMP' || entry.op === 'JUMPI')) {
      const nextStep = steps?.[i + 1] ?? null
      const nextAst = nextStep?.astContext
      const funcSrc = nextAst?.functionSource
      const currFunc = nextAst?.function ?? null
      const currFile = funcSrc?.filePath ?? nextStep?.source?.filePath ?? null

      const contextKey = `${currFunc ?? ''}|${currFile ?? ''}`
      const changed = contextKey !== lastJumpContext
      const hasContext = currFunc && currFunc !== 'n/a'

      if (changed && hasContext) {
        lastJumpContext = contextKey

        const contractName = nextAst?.contract && nextAst.contract !== 'n/a' ? nextAst.contract.replace('ContractDefinition: ', '') : contractTag
        const funcName = currFunc.replace('FunctionDefinition: ', '').replace('ModifierDefinition: ', '')

        const desc = `${contractName}.${funcName}`

        rows.push({
          id: `jump-${i}`,
          depth: treeDepth + 1,
          kind: 'jump',
          gasUsed: null,
          gasCost: entry.gasCost,
          description: desc,
          returnDescription: null,
          status: 'success',
          hasChildren: false,
          opBadge: entry.op === 'JUMPI' ? 'JUMP·I' : 'JUMP',
          badgeType: 'jump',
          label: currentLabel,
          address: currentAddress,
          searchText: `${contractTag} ${desc} jump`.toLowerCase(),
          sourceRef: funcSrc
            ? { filePath: funcSrc.filePath, line: funcSrc.line, column: funcSrc.column, fileIndex: funcSrc.fileIndex }
            : null,
          entryIndex: i + 1,
        })
      }
    }
  }

  return rows
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

function resolveSourceContent(
  ref: SourceRef,
  imageSourceData: Map<string, ImageSourceData>,
  sourceFiles: Map<string, string>,
): string | null {
  // First: use imageSourceData (same content that offsetToLineColumn used) — this is authoritative
  for (const data of imageSourceData.values()) {
    const content = data.sourceContents.get(ref.fileIndex)
    if (content) return content
  }
  // Fallback: try source files DB
  const direct = sourceFiles.get(ref.filePath)
  if (direct) return direct
  for (const [path, src] of sourceFiles) {
    if (path.endsWith(ref.filePath) || ref.filePath.endsWith(path)) return src
  }
  return null
}

function SourcePanel(props: {
  sourceRef: SourceRef
  imageSourceData: Map<string, ImageSourceData>
  sourceFiles: Map<string, string>
  onClose: () => void
  anchorPos?: { x: number; y: number } | null
}) {
  const { sourceRef, imageSourceData, sourceFiles, onClose, anchorPos } = props
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  const content = useMemo(
    () => resolveSourceContent(sourceRef, imageSourceData, sourceFiles),
    [sourceRef.filePath, sourceRef.fileIndex, imageSourceData, sourceFiles],
  )
  const lines = useMemo(() => content?.split('\n') ?? [], [content])

  // Position panel so the highlighted line aligns with the click Y coordinate
  useEffect(() => {
    const panel = panelRef.current
    const container = bodyRef.current
    if (!panel || !container) return

    requestAnimationFrame(() => {
      const lineEl = container.querySelector(`[data-line="${sourceRef.line}"]`) as HTMLElement | null
      if (!lineEl) return

      if (anchorPos && !pos) {
        // Place the panel so the focused line aligns with the click Y
        const panelRect = panel.getBoundingClientRect()
        const headerHeight = container.offsetTop - panel.offsetTop
        const lineOffset = lineEl.offsetTop
        const lineHeight = lineEl.offsetHeight
        const containerHeight = container.clientHeight

        // Scroll the line to center of the body area
        container.scrollTop = lineOffset - containerHeight / 2 + lineHeight / 2

        // Compute where the line will visually sit relative to the panel top
        const scrolledLineTop = lineOffset - container.scrollTop
        const lineScreenY = headerHeight + scrolledLineTop + lineHeight / 2

        // Position panel so that point aligns with click Y
        let panelTop = anchorPos.y - lineScreenY
        // Place to the right of the click
        let panelLeft = anchorPos.x + 48

        // Clamp to viewport
        panelTop = Math.max(8, Math.min(panelTop, window.innerHeight - panelRect.height - 8))
        if (panelLeft + panelRect.width > window.innerWidth - 8) {
          panelLeft = anchorPos.x - panelRect.width - 48
        }
        panelLeft = Math.max(8, panelLeft)

        setPos({ x: panelLeft, y: panelTop })
      } else {
        // Default: just scroll to center the line
        const top = lineEl.offsetTop
        const height = lineEl.offsetHeight
        const containerHeight = container.clientHeight
        container.scrollTop = top - containerHeight / 2 + height / 2
      }
    })
  }, [sourceRef.filePath, sourceRef.line])

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Drag handling
  const startDrag = useCallback((e: MouseEvent) => {
    e.preventDefault()
    const panel = panelRef.current
    if (!panel) return

    const rect = panel.getBoundingClientRect()
    const offsetX = e.clientX - rect.left
    const offsetY = e.clientY - rect.top

    function onMove(me: MouseEvent) {
      setPos({ x: me.clientX - offsetX, y: me.clientY - offsetY })
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  const style = pos
    ? { left: `${pos.x}px`, top: `${pos.y}px`, right: 'auto', bottom: 'auto' }
    : undefined

  return (
    <div
      ref={panelRef}
      class="stv-source-panel"
      style={style}
    >
      <div
        class="stv-source-panel-header"
        onMouseDown={(e) => startDrag(e as unknown as MouseEvent)}
      >
        <span class="stv-modal-title mono">{sourceRef.filePath}</span>
        <span class="muted">line {sourceRef.line}</span>
        <button type="button" class="stv-modal-close" onClick={onClose}>×</button>
      </div>
      <div class="stv-source-panel-body" ref={bodyRef}>
        {content ? (
          <div class="source-code-view stv-source-code">
            {lines.map((line, idx) => {
              const lineNum = idx + 1
              const isFocused = lineNum === sourceRef.line
              return (
                <div
                  key={lineNum}
                  data-line={lineNum}
                  class={`source-line ${isFocused ? 'source-line-focused' : ''}`}
                >
                  <span class="source-line-number">{lineNum}</span>
                  <span class="source-line-code mono">{line || ' '}</span>
                </div>
              )
            })}
          </div>
        ) : (
          <p class="muted" style={{ padding: 16 }}>
            Source file not found: {sourceRef.filePath}
          </p>
        )}
      </div>
    </div>
  )
}

function ColoredDescription({ row }: { row: FlatRow }) {
  const desc = row.description

  if (row.kind === 'call' || row.kind === 'jump') {
    // Pattern: Contract.function(args) or Contract.function()
    const dotIdx = desc.indexOf('.')
    if (dotIdx > 0) {
      const contract = desc.slice(0, dotIdx)
      const rest = desc.slice(dotIdx + 1)
      const parenIdx = rest.indexOf('(')
      if (parenIdx > 0) {
        const func = rest.slice(0, parenIdx)
        const argsStr = rest.slice(parenIdx)
        return (
          <span class={`stv-call-text stv-text-${row.kind}`}>
            <span class="stv-contract-name">{contract}</span>
            <span class="stv-separator">.</span>
            <span class="stv-func-name">{func}</span>
            <span class="stv-call-args">{argsStr}</span>
          </span>
        )
      }
    }
  }

  if (row.kind === 'sload' || row.kind === 'sstore') {
    // Pattern: ContractTag [slot = value] or [slot ← value]
    const bracketIdx = desc.indexOf('[')
    if (bracketIdx > 0) {
      const tag = desc.slice(0, bracketIdx).trim()
      const inner = desc.slice(bracketIdx)
      return (
        <span class={`stv-call-text stv-text-${row.kind}`}>
          <span class="stv-contract-name">{tag}</span>
          {' '}
          <span class="stv-call-args">{inner}</span>
        </span>
      )
    }
  }

  if (row.kind === 'log') {
    // Pattern: ContractTag EventName(args) [topics] data = ...
    // First token is the contract tag, then decoded event if present
    const spaceIdx = desc.indexOf(' ')
    if (spaceIdx > 0) {
      const tag = desc.slice(0, spaceIdx)
      const rest = desc.slice(spaceIdx + 1)
      const parenIdx = rest.indexOf('(')
      const bracketIdx = rest.indexOf('[')

      // Check if there's a decoded event before the brackets
      if (parenIdx > 0 && (bracketIdx < 0 || parenIdx < bracketIdx)) {
        const closeParen = rest.indexOf(')', parenIdx)
        if (closeParen > 0) {
          const rawPart = rest.slice(closeParen + 1).trim()
          const eventName = rest.slice(0, parenIdx)
          const eventArgs = rest.slice(parenIdx, closeParen + 1)
          return (
            <span class={`stv-call-text stv-text-${row.kind}`}>
              <span class="stv-contract-name">{tag}</span>
              {' '}
              <span class="stv-event-name">{eventName}</span>
              <span class="stv-call-args">{eventArgs}</span>
              {rawPart && <span class="stv-call-args"> {rawPart}</span>}
            </span>
          )
        }
      }

      return (
        <span class={`stv-call-text stv-text-${row.kind}`}>
          <span class="stv-contract-name">{tag}</span>
          {' '}
          <span class="stv-call-args">{rest}</span>
        </span>
      )
    }
  }

  return <span class={`stv-call-text stv-text-${row.kind}`}>{desc}</span>
}

function StackTraceRow(props: {
  row: FlatRow
  isExpanded: boolean
  onToggle: (id: string) => void
  searchMatch: boolean
  showGas: boolean
  onSourceClick: (ref: SourceRef, clickPos?: { x: number; y: number }) => void
  onRowClick?: (entryIndex: number) => void
}) {
  const { row, isExpanded, onToggle, searchMatch, showGas, onSourceClick, onRowClick } = props
  const indent = row.depth * 20

  const statusClass = row.status === 'reverted' ? 'stv-status-reverted'
    : row.status === 'failed' ? 'stv-status-failed'
    : ''

  const gas = row.gasUsed ?? (row.gasCost !== null ? String(row.gasCost) : null)

  return (
    <div
      class={`stv-row ${statusClass} ${searchMatch ? 'stv-row-match' : ''} ${row.kind !== 'call' ? 'stv-row-detail' : ''} ${onRowClick ? 'stv-row-clickable' : ''}`.trim()}
      style={{ paddingLeft: `${12 + indent}px` }}
      onClick={onRowClick && row.entryIndex !== null ? () => onRowClick(row.entryIndex!) : undefined}
    >
      <span class={`stv-badge stv-badge-${row.badgeType}`}>{row.opBadge}</span>
      {showGas && <span class="stv-gas mono">{gas ? formatNumber(Number(gas)) : ''}</span>}
      <span class="stv-tree-indent">
        {row.depth > 0 && (
          <span class="stv-tree-connector">
            {row.kind === 'call' ? '├─' : '│ '}
          </span>
        )}
      </span>
      {row.hasChildren && (
        <button
          type="button"
          class="stv-toggle"
          onClick={() => onToggle(row.id)}
          aria-expanded={isExpanded}
        >
          <span class={`trace-chevron ${isExpanded ? 'trace-chevron-open' : ''}`}>▸</span>
        </button>
      )}
      <span class="stv-description mono">
        {row.kind === 'call' && row.address && (
          <span class="stv-label">[{row.label ?? row.address}]</span>
        )}
        {row.kind === 'call' && ' '}
        <ColoredDescription row={row} />
        {row.sourceRef && !onRowClick && (
          <button
            type="button"
            class="stv-source-link"
            onClick={(e) => {
              e.stopPropagation()
              onSourceClick(row.sourceRef!, { x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY })
            }}
          >
            [{row.sourceRef.filePath.split('/').pop()}:{row.sourceRef.line}]
          </button>
        )}
        {row.returnDescription && (
          <>
            <span class="stv-arrow"> =&gt; </span>
            <span class={row.status !== 'success' ? 'stv-error-text' : 'stv-return-text'}>
              {row.returnDescription}
            </span>
          </>
        )}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function StackTraceView({ trace, opcodeTrace, opcodeLoading, onRequestOpcodeTrace, loadRuntimeCode, initialFullTrace, embedded, onEntrySelect }: Props) {
  const { refreshKey, rpcUrl } = useExplorer()
  const [labelMap, setLabelMap] = useState<LabelMap>(new Map())
  const [abiMap, setAbiMap] = useState<Map<string, Abi>>(new Map())
  const [steps, setSteps] = useState<TraceStepLocation[] | null>(null)
  const [imageSourceData, setImageSourceData] = useState<Map<string, ImageSourceData>>(new Map())
  const [stepsLoading, setStepsLoading] = useState(false)
  const loadRuntimeCodeRef = useRef(loadRuntimeCode)
  loadRuntimeCodeRef.current = loadRuntimeCode
  const stepsRequestedRef = useRef(false)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [showGas, setShowGas] = useState(true)
  const [showStorage, setShowStorage] = useState(true)
  const [showEvents, setShowEvents] = useState(true)
  const [showFullTrace, setShowFullTrace] = useState(!!initialFullTrace)
  const [sourceFiles, setSourceFiles] = useState<Map<string, string>>(new Map())
  const [activeSourceRef, setActiveSourceRef] = useState<SourceRef | null>(null)
  const [sourceClickPos, setSourceClickPos] = useState<{ x: number; y: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const needsOpcodeTrace = showStorage || showEvents || showFullTrace
  const hasOpcodeTrace = !!opcodeTrace && opcodeTrace.entries.length > 0

  // Auto-request opcode trace when a detail toggle is enabled
  useEffect(() => {
    if (needsOpcodeTrace && !hasOpcodeTrace && !opcodeLoading && onRequestOpcodeTrace) {
      onRequestOpcodeTrace()
    }
  }, [needsOpcodeTrace, hasOpcodeTrace, opcodeLoading, onRequestOpcodeTrace])

  // Reset steps when trace changes
  useEffect(() => {
    stepsRequestedRef.current = false
    setSteps(null)
    setStepsLoading(false)
  }, [trace, opcodeTrace])

  // Build source trace model for Full Trace JUMP labels
  useEffect(() => {
    if (!showFullTrace || !hasOpcodeTrace || stepsRequestedRef.current) return
    stepsRequestedRef.current = true
    setStepsLoading(true)

    let cancelled = false

    async function build() {
      try {
        const [codeImages, sourceFiles] = await Promise.all([
          listCodeImages(),
          listSourceFiles(),
        ])
        const model = await buildSourceTraceModel({
          callTree: trace,
          opcodeTrace: opcodeTrace!,
          codeImages,
          sourceFiles,
          getRuntimeCode: loadRuntimeCodeRef.current,
        })
        if (!cancelled) {
          setSteps(model.steps)
          setImageSourceData(model.imageSourceData)
        }
      } catch (err) {
        console.warn('[StackTraceView] source trace model build failed:', err)
      } finally {
        if (!cancelled) setStepsLoading(false)
      }
    }

    void build()
    return () => { cancelled = true }
  }, [showFullTrace, hasOpcodeTrace, trace, opcodeTrace, refreshKey])

  // Load labels and ABIs
  useEffect(() => {
    let cancelled = false

    async function load() {
      const addresses = new Set<string>()
      function visit(node: TraceNode) {
        if (node.to) addresses.add(node.to)
        if (node.from) addresses.add(node.from)
        for (const child of node.calls) visit(child)
      }
      visit(trace)

      const labelEntries = await Promise.all(
        [...addresses].map(async (addr) => {
          const label = await getResolvedAddressLabel(addr)
          return [addr.toLowerCase(), label] as const
        }),
      )

      const abiRecords = await listAbis()
      const nextAbiMap = new Map<string, Abi>()
      for (const record of abiRecords) {
        nextAbiMap.set(record.address.toLowerCase(), record.abi)
      }

      // Resolve proxy implementations and merge ABIs for addresses in the trace
      const client = createAnvilClient(rpcUrl)
      await Promise.all(
        [...addresses].map(async (addr) => {
          const implAddr = await getProxyImplementation(client, addr as `0x${string}`).catch(() => null)
          if (implAddr) {
            const implRecord = await getAbi(implAddr)
            if (implRecord) {
              const existing = nextAbiMap.get(addr.toLowerCase())
              nextAbiMap.set(addr.toLowerCase(), mergeAbis([existing, implRecord.abi]))
            }
          }
        }),
      )

      const sources = await listSourceFiles()

      if (cancelled) return

      const nextLabelMap = new Map<string, string>()
      for (const [addr, label] of labelEntries) {
        if (label) nextLabelMap.set(addr, label)
      }
      setLabelMap(nextLabelMap)
      setAbiMap(nextAbiMap)
      setSourceFiles(new Map(sources.map((s) => [s.path, s.content])))
    }

    void load()
    return () => { cancelled = true }
  }, [trace])

  const allRows = useMemo(() => {
    if (needsOpcodeTrace && hasOpcodeTrace) {
      return flattenWithOpcodes(trace, opcodeTrace!.entries, labelMap, abiMap, {
        storage: showStorage,
        events: showEvents,
        fullTrace: showFullTrace,
      }, steps)
    }
    return flattenCallTree(trace, labelMap, abiMap, 0)
  }, [trace, labelMap, abiMap, opcodeTrace, needsOpcodeTrace, hasOpcodeTrace, showStorage, showEvents, showFullTrace, steps])

  // Compute visible rows (hide children of collapsed nodes)
  const visibleRows = useMemo(() => {
    const result: FlatRow[] = []
    const collapsedDepths: number[] = []

    for (const row of allRows) {
      while (collapsedDepths.length > 0 && collapsedDepths[collapsedDepths.length - 1] >= row.depth) {
        collapsedDepths.pop()
      }

      if (collapsedDepths.length > 0) continue

      result.push(row)

      if (collapsedIds.has(row.id) && row.hasChildren) {
        collapsedDepths.push(row.depth)
      }
    }

    return result
  }, [allRows, collapsedIds])

  // Search filtering
  const searchLower = search.toLowerCase()
  const matchedIds = useMemo(() => {
    if (!searchLower) return null
    const ids = new Set<string>()
    for (const row of allRows) {
      if (row.searchText.includes(searchLower)) {
        ids.add(row.id)
      }
    }
    return ids
  }, [allRows, searchLower])

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const detailCounts = useMemo(() => {
    let storage = 0
    let events = 0
    let jumps = 0
    for (const row of allRows) {
      if (row.kind === 'sload' || row.kind === 'sstore') storage++
      else if (row.kind === 'log') events++
      else if (row.kind === 'jump') jumps++
    }
    return { storage, events, jumps }
  }, [allRows])

  return (
    <div class="stv-container">
      {!embedded && (
        <div class="stv-toolbar">
          <div class="stv-search-box">
            <input
              type="text"
              placeholder="Search…"
              value={search}
              onInput={(e) => setSearch(e.currentTarget.value)}
              class="stv-search-input"
            />
            {search && (
              <button type="button" class="stv-search-clear" onClick={() => setSearch('')}>
                ×
              </button>
            )}
          </div>
          <div class="stv-toolbar-actions">
            <label class="stv-checkbox-label">
              <input type="checkbox" checked={showGas} onChange={() => setShowGas((v) => !v)} />
              Gas
            </label>
            <label class="stv-checkbox-label">
              <input
                type="checkbox"
                checked={showFullTrace}
                onChange={() => {
                  const next = !showFullTrace
                  setShowFullTrace(next)
                  if (next) {
                    setShowStorage(true)
                    setShowEvents(true)
                  }
                }}
              />
              Full Trace
            </label>
            <label class="stv-checkbox-label">
              <input type="checkbox" checked={showStorage} onChange={() => setShowStorage((v) => !v)} />
              Storage
            </label>
            <label class="stv-checkbox-label">
              <input type="checkbox" checked={showEvents} onChange={() => setShowEvents((v) => !v)} />
              Events
            </label>
          </div>
        </div>
      )}

      {needsOpcodeTrace && !hasOpcodeTrace && (
        <div class="stv-loading-bar">
          {opcodeLoading
            ? <span class="muted">Loading detailed trace…</span>
            : opcodeTrace && opcodeTrace.entries.length === 0
              ? <span class="muted">Anvil returned 0 struct logs. Opcode-level features (Full Trace, Storage, Events) are unavailable. This is a known issue with some Anvil versions on forked chains — try upgrading Foundry (foundryup).</span>
              : <span class="muted">Detailed trace not yet loaded.</span>
          }
        </div>
      )}
      {showFullTrace && hasOpcodeTrace && stepsLoading && (
        <div class="stv-loading-bar">
          <span class="muted">Building source map model…</span>
        </div>
      )}

      <div class="stv-header-row">
        <span class="stv-header-badge">Type</span>
        {showGas && <span class="stv-header-gas">Gas</span>}
        <span class="stv-header-desc">Call</span>
      </div>

      <div class="stv-body" ref={scrollRef}>
        {visibleRows.map((row) => {
          if (matchedIds && !matchedIds.has(row.id)) {
            return (
              <div key={row.id} class="stv-row stv-row-dimmed" style={{ paddingLeft: `${12 + row.depth * 20}px` }}>
                <span class={`stv-badge stv-badge-${row.badgeType}`}>{row.opBadge}</span>
                {showGas && <span class="stv-gas mono">{(row.gasUsed ?? (row.gasCost !== null ? String(row.gasCost) : null)) ? formatNumber(Number(row.gasUsed ?? row.gasCost)) : ''}</span>}
                <span class="stv-description mono stv-dimmed-text">
                  {row.description}
                </span>
              </div>
            )
          }

          return (
            <StackTraceRow
              key={row.id}
              row={row}
              isExpanded={!collapsedIds.has(row.id)}
              onToggle={toggleCollapse}
              searchMatch={!!matchedIds}
              showGas={showGas}
              onSourceClick={embedded ? () => {} : (ref, clickPos) => {
                setActiveSourceRef(ref)
                setSourceClickPos(clickPos ?? null)
              }}
              onRowClick={onEntrySelect}
            />
          )
        })}
      </div>

      {!embedded && (
        <div class="stv-footer muted">
          {formatNumber(visibleRows.length)} / {formatNumber(allRows.length)} rows
          {detailCounts.storage > 0 && ` · ${formatNumber(detailCounts.storage)} storage ops`}
          {detailCounts.events > 0 && ` · ${formatNumber(detailCounts.events)} events`}
          {detailCounts.jumps > 0 && ` · ${formatNumber(detailCounts.jumps)} jumps`}
          {matchedIds && ` · ${formatNumber(matchedIds.size)} matches`}
        </div>
      )}

      {!embedded && activeSourceRef && (
        <SourcePanel
          sourceRef={activeSourceRef}
          imageSourceData={imageSourceData}
          sourceFiles={sourceFiles}
          onClose={() => { setActiveSourceRef(null); setSourceClickPos(null) }}
          anchorPos={sourceClickPos}
        />
      )}
    </div>
  )
}
