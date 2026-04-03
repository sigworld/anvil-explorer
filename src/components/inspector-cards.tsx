import { useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import type { DecodedStep } from '../lib/step-decode.ts'
import type { DecodedStorageSlot } from '../lib/storage-decode.ts'
import type { StepAstContext, TraceFrame } from '../lib/types.ts'
import { formatNumber } from '../lib/format.ts'

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function CopyInline({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)

  function handleClick(event: Event) {
    event.stopPropagation()
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <button
      type="button"
      class={`insp-copy ${copied ? 'insp-copy-done' : ''}`}
      onClick={handleClick}
      title="Copy"
      aria-label="Copy to clipboard"
    >
      {copied ? '\u2713' : '\u2398'}
    </button>
  )
}

function HexValue({ value, copy }: { value: string; copy?: boolean }) {
  return (
    <span class="insp-hex">
      <span class="mono">{value}</span>
      {copy !== false && value.length > 4 && <CopyInline value={value} />}
    </span>
  )
}

function AddressValue({ value }: { value: string | null }) {
  if (!value) return <span class="insp-null">n/a</span>
  return (
    <span class="insp-addr">
      <span class="mono">{value}</span>
      <CopyInline value={value} />
    </span>
  )
}

function NumberValue({ value, unit }: { value: number | string | null; unit?: string }) {
  if (value === null || value === undefined) return <span class="insp-null">n/a</span>
  const display = typeof value === 'number' ? formatNumber(value) : value
  return (
    <span class="insp-num">
      {display}
      {unit && <span class="insp-unit">{unit}</span>}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'success' ? 'insp-badge-success'
    : status === 'reverted' ? 'insp-badge-warning'
    : 'insp-badge-danger'
  return <span class={`insp-badge ${cls}`}>{status}</span>
}

function TypeBadge({ type }: { type: string }) {
  return <span class="insp-badge insp-badge-kind">{type}</span>
}

function Row({ label, children, wide }: { label: string; children: ComponentChildren; wide?: boolean }) {
  return (
    <div class={`insp-row ${wide ? 'insp-row-wide' : ''}`}>
      <span class="insp-row-label">{label}</span>
      <span class="insp-row-value">{children}</span>
    </div>
  )
}

function EmptyNote({ text }: { text: string }) {
  return <span class="insp-empty">{text}</span>
}

function CardShell({ label, accent, children }: { label: string; accent?: 'danger' | 'warning' | 'info' | 'success'; children: ComponentChildren }) {
  return (
    <div class={`insp-card ${accent ? `insp-card-${accent}` : ''}`}>
      <span class="insp-card-label">{label}</span>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hex stack display
// ---------------------------------------------------------------------------

function HexStack({ items, startIndex }: { items: string[]; startIndex?: number }) {
  if (items.length === 0) return <EmptyNote text="empty" />
  const base = startIndex ?? 0
  return (
    <div class="insp-hex-stack">
      {items.map((item, i) => (
        <div key={i} class="insp-hex-stack-row">
          <span class="insp-hex-stack-idx">{base + i}</span>
          <HexValue value={item} />
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Card: Opcode + stack diff
// ---------------------------------------------------------------------------

export function OpcodeCard({ entry, stackDiff }: {
  entry: { pc: number; op: string; gas: number; gasCost: number; depth: number } | null
  stackDiff: { popped: string[]; pushed: string[] } | null
}) {
  if (!entry) return <CardShell label="Opcode"><EmptyNote text="no step" /></CardShell>

  const opClass = entry.op === 'REVERT' || entry.op === 'INVALID'
    ? 'insp-op-danger'
    : entry.op.startsWith('CALL') || entry.op.startsWith('STATICCALL') || entry.op.startsWith('DELEGATECALL')
    ? 'insp-op-call'
    : entry.op === 'RETURN'
    ? 'insp-op-success'
    : entry.op.startsWith('PUSH') || entry.op.startsWith('DUP') || entry.op.startsWith('SWAP')
    ? 'insp-op-stack'
    : ''

  return (
    <CardShell label="Opcode">
      <div class="insp-opcode-header">
        <span class={`insp-opcode-name mono ${opClass}`}>{entry.op}</span>
        <span class="insp-opcode-pc mono">PC {entry.pc}</span>
      </div>
      <div class="insp-opcode-stats">
        <Row label="gas"><NumberValue value={entry.gas} /></Row>
        <Row label="cost"><NumberValue value={entry.gasCost} /></Row>
        <Row label="depth"><NumberValue value={entry.depth} /></Row>
      </div>
      {stackDiff && (
        <div class="insp-opcode-diff">
          {stackDiff.popped.length > 0 && (
            <div class="insp-diff-section">
              <span class="insp-diff-label insp-diff-removed">popped</span>
              {stackDiff.popped.map((v, i) => (
                <div key={i} class="insp-diff-row insp-diff-row-removed"><span class="mono">{v}</span></div>
              ))}
            </div>
          )}
          {stackDiff.pushed.length > 0 && (
            <div class="insp-diff-section">
              <span class="insp-diff-label insp-diff-added">pushed</span>
              {stackDiff.pushed.map((v, i) => (
                <div key={i} class="insp-diff-row insp-diff-row-added"><span class="mono">{v}</span></div>
              ))}
            </div>
          )}
        </div>
      )}
    </CardShell>
  )
}

// ---------------------------------------------------------------------------
// Card: AST Context
// ---------------------------------------------------------------------------

export function AstContextCard({ ctx }: { ctx: StepAstContext | null }) {
  if (!ctx) return <CardShell label="AST"><EmptyNote text="unmapped" /></CardShell>
  return (
    <CardShell label="AST">
      <Row label="contract"><span class="mono">{ctx.contract ?? 'n/a'}</span></Row>
      <Row label="function"><span class="mono">{ctx.function ?? 'n/a'}</span></Row>
      <Row label="statement"><span class="mono">{ctx.statement ?? 'n/a'}</span></Row>
      {ctx.functionSource && (
        <Row label="func src">
          <span class="mono">{ctx.functionSource.filePath.split('/').pop()}:{ctx.functionSource.line}</span>
        </Row>
      )}
      {ctx.narrowedSource && (
        <Row label="narrowed">
          <span class="mono">{ctx.narrowedSource.filePath.split('/').pop()}:{ctx.narrowedSource.line}</span>
        </Row>
      )}
    </CardShell>
  )
}

// ---------------------------------------------------------------------------
// Card: Decoded Call / Revert / Return
// ---------------------------------------------------------------------------

export function DecodedStepCard({ decoded }: { decoded: DecodedStep }) {
  if (!decoded) return null

  if (decoded.kind === 'call') {
    return (
      <CardShell label="Decoded Call" accent="info">
        <div class="insp-decoded-sig">
          <TypeBadge type={decoded.op} />
          {decoded.functionName
            ? <span class="insp-fn-name mono">{decoded.functionName}</span>
            : <span class="insp-fn-name mono muted">{decoded.selector ?? 'unknown'}</span>
          }
        </div>
        {decoded.targetAddress && (
          <Row label="to"><AddressValue value={decoded.targetAddress} /></Row>
        )}
        {decoded.value && (
          <Row label="value"><NumberValue value={decoded.value} unit="wei" /></Row>
        )}
        {decoded.args.length > 0 && (
          <div class="insp-arg-list">
            {decoded.args.map((arg, i) => (
              <div key={i} class="insp-arg-row">
                <span class="insp-arg-name">{arg.name}</span>
                <span class="insp-arg-value mono">{arg.value}</span>
              </div>
            ))}
          </div>
        )}
        {decoded.rawCalldata && decoded.args.length === 0 && (
          <Row label="calldata"><HexValue value={decoded.rawCalldata} /></Row>
        )}
      </CardShell>
    )
  }

  if (decoded.kind === 'revert') {
    return (
      <CardShell label="Decoded Revert" accent="danger">
        {decoded.errorName && (
          <div class="insp-decoded-sig">
            <span class="insp-badge insp-badge-danger">{decoded.errorName}</span>
            {decoded.signature && <span class="mono muted">{decoded.signature}</span>}
          </div>
        )}
        {decoded.message && (
          <Row label="message"><span class="insp-revert-msg">{decoded.message}</span></Row>
        )}
        {decoded.args.length > 0 && (
          <div class="insp-arg-list">
            {decoded.args.map((arg, i) => (
              <div key={i} class="insp-arg-row">
                <span class="insp-arg-name">{arg.name}</span>
                <span class="insp-arg-value mono">{arg.value}</span>
              </div>
            ))}
          </div>
        )}
        {decoded.data && (
          <Row label="raw"><HexValue value={decoded.data} /></Row>
        )}
      </CardShell>
    )
  }

  // return
  return (
    <CardShell label="Return Data" accent="success">
      {decoded.data
        ? <Row label="data"><HexValue value={decoded.data} /></Row>
        : <EmptyNote text="empty return" />
      }
    </CardShell>
  )
}

// ---------------------------------------------------------------------------
// Card: Stack (EVM)
// ---------------------------------------------------------------------------

export function StackCard({ stack }: { stack: string[] | undefined }) {
  const items = stack ?? []
  const topN = 12
  const display = items.length > topN ? items.slice(-topN) : items
  const startIdx = items.length > topN ? items.length - topN : 0
  return (
    <CardShell label={`Stack (${items.length})`}>
      {display.length === 0
        ? <EmptyNote text="empty" />
        : <HexStack items={[...display].reverse()} startIndex={startIdx} />
      }
    </CardShell>
  )
}

// ---------------------------------------------------------------------------
// Card: Stack diff
// ---------------------------------------------------------------------------

export function StackDiffCard({ diff }: { diff: { popped: string[]; pushed: string[] } | null }) {
  if (!diff) return <CardShell label={'\u0394 Stack'}><EmptyNote text="no change" /></CardShell>
  return (
    <CardShell label={'\u0394 Stack'}>
      {diff.popped.length > 0 && (
        <div class="insp-diff-section">
          <span class="insp-diff-label insp-diff-removed">popped</span>
          {diff.popped.map((v, i) => (
            <div key={i} class="insp-diff-row insp-diff-row-removed"><span class="mono">{v}</span></div>
          ))}
        </div>
      )}
      {diff.pushed.length > 0 && (
        <div class="insp-diff-section">
          <span class="insp-diff-label insp-diff-added">pushed</span>
          {diff.pushed.map((v, i) => (
            <div key={i} class="insp-diff-row insp-diff-row-added"><span class="mono">{v}</span></div>
          ))}
        </div>
      )}
    </CardShell>
  )
}

// ---------------------------------------------------------------------------
// Card: Memory
// ---------------------------------------------------------------------------

export function MemoryCard({ memory }: { memory: string[] | undefined }) {
  const words = memory ?? []
  if (words.length === 0) return <CardShell label="Memory"><EmptyNote text="empty" /></CardShell>

  const preview = words.slice(0, 8)
  return (
    <CardShell label={`Memory (${words.length} words)`}>
      <div class="insp-mem-grid">
        {preview.map((word, i) => (
          <div key={i} class="insp-mem-row">
            <span class="insp-mem-offset mono">0x{(i * 32).toString(16).padStart(4, '0')}</span>
            <span class="insp-mem-word mono">{word}</span>
          </div>
        ))}
        {words.length > 8 && (
          <span class="insp-empty">+{words.length - 8} more words</span>
        )}
      </div>
    </CardShell>
  )
}

// ---------------------------------------------------------------------------
// Card: Storage access
// ---------------------------------------------------------------------------

export function StorageCard({ slots }: { slots: DecodedStorageSlot[] }) {
  if (slots.length === 0) return <CardShell label="Storage"><EmptyNote text="no access" /></CardShell>
  return (
    <CardShell label={`Storage (${slots.length})`}>
      <div class="insp-storage-table">
        <div class="insp-storage-head">
          <span>Variable</span>
          <span>Value</span>
        </div>
        {slots.map((slot, i) => (
          <div key={i} class="insp-storage-row">
            <span class="insp-storage-label">
              <span class="insp-storage-name">{slot.label}</span>
              <span class="insp-storage-type mono muted">{slot.typeName !== 'unknown' ? slot.typeName : ''}</span>
            </span>
            <span class="insp-storage-value">
              <HexValue value={slot.rawValue} />
            </span>
          </div>
        ))}
      </div>
    </CardShell>
  )
}

// ---------------------------------------------------------------------------
// Card: Storage diff
// ---------------------------------------------------------------------------

export function StorageDiffCard({ diffs }: { diffs: Array<{ slot: string; before: string | null; after: string | null }> }) {
  if (diffs.length === 0) return <CardShell label={'\u0394 Storage'}><EmptyNote text="no change" /></CardShell>
  return (
    <CardShell label={'\u0394 Storage'}>
      <div class="insp-storage-diff">
        {diffs.map((diff, i) => (
          <div key={i} class="insp-storage-diff-entry">
            <span class="insp-storage-diff-slot mono">{diff.slot}</span>
            <div class="insp-storage-diff-values">
              <span class="insp-diff-row insp-diff-row-removed mono">{diff.before ?? '0x0'}</span>
              <span class="insp-storage-diff-arrow">&#x2192;</span>
              <span class="insp-diff-row insp-diff-row-added mono">{diff.after ?? '0x0'}</span>
            </div>
          </div>
        ))}
      </div>
    </CardShell>
  )
}

// ---------------------------------------------------------------------------
// Card: Return / Revert data
// ---------------------------------------------------------------------------

export function ReturnDataCard({ entry, returnPayload, frameOutput }: {
  entry: { op: string; returnData?: string | null } | null
  returnPayload: { offset: string | null; size: string | null; data: string | null } | null
  frameOutput: string | null
}) {
  const hasPayload = returnPayload?.data
  const hasReturnData = entry?.returnData
  const hasFrameOutput = frameOutput && frameOutput !== '0x'
  if (!hasPayload && !hasReturnData && !hasFrameOutput) {
    return <CardShell label="Return / Revert"><EmptyNote text="no data" /></CardShell>
  }

  return (
    <CardShell label="Return / Revert" accent={entry?.op === 'REVERT' ? 'danger' : undefined}>
      {entry?.op && <Row label="op"><span class="mono">{entry.op}</span></Row>}
      {returnPayload?.data && (
        <Row label="payload"><HexValue value={returnPayload.data} /></Row>
      )}
      {hasReturnData && (
        <Row label="returnData"><HexValue value={entry!.returnData!} /></Row>
      )}
      {hasFrameOutput && (
        <Row label="output"><HexValue value={frameOutput!} /></Row>
      )}
    </CardShell>
  )
}

// ---------------------------------------------------------------------------
// Card: Frame input
// ---------------------------------------------------------------------------

function frameLabel(frame: TraceFrame) {
  return frame.signature ?? frame.functionName ?? frame.selector ?? (frame.type === 'CREATE' || frame.type === 'CREATE2'
    ? 'constructor'
    : 'fallback / receive')
}

export function FrameInputCard({ frame }: { frame: TraceFrame }) {
  return (
    <CardShell label="Frame In">
      <div class="insp-decoded-sig">
        <TypeBadge type={frame.type} />
        <span class="insp-fn-name mono">{frameLabel(frame)}</span>
      </div>
      {frame.selector && <Row label="selector"><span class="mono">{frame.selector}</span></Row>}
      {frame.args.length > 0 && (
        <div class="insp-arg-list">
          {frame.args.map((arg, i) => (
            <div key={i} class="insp-arg-row">
              <span class="insp-arg-name">{arg.name}</span>
              <span class="insp-arg-value mono">{arg.value}</span>
            </div>
          ))}
        </div>
      )}
      {frame.args.length === 0 && frame.input !== '0x' && (
        <Row label="input"><HexValue value={frame.input} /></Row>
      )}
    </CardShell>
  )
}

// ---------------------------------------------------------------------------
// Card: Frame result
// ---------------------------------------------------------------------------

export function FrameResultCard({ frame }: { frame: TraceFrame }) {
  return (
    <CardShell label="Frame Out" accent={frame.status === 'reverted' ? 'warning' : frame.status === 'failed' ? 'danger' : undefined}>
      <Row label="status"><StatusBadge status={frame.status} /></Row>
      {frame.gasUsed && <Row label="gas used"><NumberValue value={frame.gasUsed} /></Row>}
      {frame.error && <Row label="error"><span class="insp-revert-msg">{frame.error}</span></Row>}
      {frame.revertReason && <Row label="reason"><span class="insp-revert-msg">{frame.revertReason}</span></Row>}
      {frame.output && frame.output !== '0x' && (
        <Row label="output"><HexValue value={frame.output} /></Row>
      )}
    </CardShell>
  )
}

// ---------------------------------------------------------------------------
// Card: Failure focus
// ---------------------------------------------------------------------------

export function FailureFocusCard({ frame, failureFocus, source }: {
  frame: TraceFrame
  failureFocus: { frameId: string; entryIndex: number } | null
  source: { filePath: string; line: number; column: number } | null
}) {
  if (frame.status === 'success' && !failureFocus) {
    return <CardShell label="Failure"><EmptyNote text="no failure" /></CardShell>
  }

  return (
    <CardShell label="Failure" accent={frame.status === 'reverted' ? 'warning' : 'danger'}>
      <Row label="status"><StatusBadge status={frame.status} /></Row>
      {frame.error && <Row label="error"><span class="insp-revert-msg">{frame.error}</span></Row>}
      {frame.revertReason && <Row label="reason"><span class="insp-revert-msg">{frame.revertReason}</span></Row>}
      {failureFocus && (
        <Row label="step"><span class="mono">{formatNumber(failureFocus.entryIndex)}</span></Row>
      )}
      {source && (
        <Row label="source"><span class="mono">{source.filePath.split('/').pop()}:{source.line}:{source.column}</span></Row>
      )}
    </CardShell>
  )
}

// ---------------------------------------------------------------------------
// Card: Context (addresses, image info)
// ---------------------------------------------------------------------------

export function ContextCard({ frame, image }: {
  frame: TraceFrame
  image: { contractName: string; imageMatch: string; sourcePath: string | null } | null
}) {
  return (
    <CardShell label="Context">
      <Row label="from"><AddressValue value={frame.from} /></Row>
      <Row label="to"><AddressValue value={frame.to} /></Row>
      {frame.value && frame.value !== '0' && (
        <Row label="value"><NumberValue value={frame.value} unit="wei" /></Row>
      )}
      {frame.codeAddress && frame.codeAddress !== frame.to && (
        <Row label="code"><AddressValue value={frame.codeAddress} /></Row>
      )}
      {frame.contextAddress && frame.contextAddress !== frame.to && (
        <Row label="context"><AddressValue value={frame.contextAddress} /></Row>
      )}
      {image && (
        <>
          <Row label="contract"><span class="mono">{image.contractName}</span></Row>
          <Row label="match"><span class="insp-badge insp-badge-kind">{image.imageMatch}</span></Row>
        </>
      )}
    </CardShell>
  )
}

// ---------------------------------------------------------------------------
// Card: Child calls
// ---------------------------------------------------------------------------

export function ChildCallsCard({ calls }: { calls: TraceFrame[] }) {
  if (calls.length === 0) return <CardShell label="Children"><EmptyNote text="leaf frame" /></CardShell>
  return (
    <CardShell label={`Children (${calls.length})`}>
      <div class="insp-children-list">
        {calls.map((child) => (
          <div key={child.id} class="insp-child-row">
            <StatusBadge status={child.status} />
            <TypeBadge type={child.type} />
            <span class="insp-fn-name mono">{frameLabel(child)}</span>
          </div>
        ))}
      </div>
    </CardShell>
  )
}
