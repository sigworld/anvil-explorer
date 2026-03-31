import { useEffect, useState } from 'preact/hooks'
import { getResolvedAddressLabel } from '../lib/db.ts'
import { formatEtherString, shortenHex } from '../lib/format.ts'
import type { AccountInsightRelation } from '../lib/types.ts'
import { useAsyncResource } from '../hooks/use-async-resource.ts'
import { useExplorer } from '../hooks/use-explorer.tsx'
import { AddressLink, BlockLink, EmptyState, PageSection, SummaryTable, TxLink } from './common.tsx'

type AccountInsightSectionProps = {
  address: string
  relations: AccountInsightRelation[]
}

function describeActivity(relation: AccountInsightRelation) {
  const parts: string[] = []

  if (relation.creationOutCount > 0) {
    parts.push(`${relation.creationOutCount} deployment${relation.creationOutCount === 1 ? '' : 's'}`)
  }

  if (relation.creationInCount > 0) {
    parts.push('origin link')
  }

  if (relation.nativeOutCount > 0) {
    parts.push(`${relation.nativeOutCount} native out (${formatEtherString(relation.nativeOutValue)})`)
  }

  if (relation.nativeInCount > 0) {
    parts.push(`${relation.nativeInCount} native in (${formatEtherString(relation.nativeInValue)})`)
  }

  if (relation.tokenOutCount > 0) {
    parts.push(`${relation.tokenOutCount} token out`)
  }

  if (relation.tokenInCount > 0) {
    parts.push(`${relation.tokenInCount} token in`)
  }

  if (relation.invocationOutCount > 0) {
    parts.push(`${relation.invocationOutCount} call out`)
  }

  if (relation.invocationInCount > 0) {
    parts.push(`${relation.invocationInCount} call in`)
  }

  return parts.join(', ')
}

function relationKindLabel(relation: AccountInsightRelation) {
  switch (relation.kind) {
    case 'creation':
      return 'origin'
    case 'value-flow':
      return 'value flow'
    case 'invocation':
      return 'invocation'
  }
}

function truncateGraphLabel(label: string, size: number) {
  return label.length > size ? `${label.slice(0, size - 1)}…` : label
}

function InsightGraphNodeLabel(props: {
  address: string
  x: number
  y: number
  textAnchor: 'start' | 'end'
  selected: boolean
}) {
  const { refreshKey } = useExplorer()
  const label = useAsyncResource(
    async () => getResolvedAddressLabel(props.address),
    [props.address, refreshKey],
    null,
  )
  const primaryLabel = label.loadedOnce
    ? truncateGraphLabel(label.data ?? shortenHex(props.address, 4), 18)
    : '…'
  const secondaryLabel = label.loadedOnce && label.data ? shortenHex(props.address, 4) : null

  return (
    <g>
      <text
        class={`account-insight-node-label ${props.selected ? 'account-insight-node-label-selected' : ''}`.trim()}
        x={props.x}
        y={props.y}
        text-anchor={props.textAnchor}
      >
        {primaryLabel}
      </text>
      {secondaryLabel && (
        <text
          class={`account-insight-node-address ${props.selected ? 'account-insight-node-address-selected' : ''}`.trim()}
          x={props.x}
          y={props.y + 14}
          text-anchor={props.textAnchor}
        >
          {secondaryLabel}
        </text>
      )}
    </g>
  )
}

function InsightGraphCenterLabel(props: { address: string; x: number; y: number }) {
  const { refreshKey } = useExplorer()
  const label = useAsyncResource(
    async () => getResolvedAddressLabel(props.address),
    [props.address, refreshKey],
    null,
  )
  const centerLabel = label.loadedOnce ? label.data : null

  return (
    <>
      <text class="account-insight-node-title account-insight-node-center-copy" x={props.x} y={props.y - 2} text-anchor="middle">
        {centerLabel ? truncateGraphLabel(centerLabel, 14) : 'Current'}
      </text>
      <text class="account-insight-node-subtitle account-insight-node-center-copy" x={props.x} y={props.y + 13} text-anchor="middle">
        {shortenHex(props.address, 4)}
      </text>
    </>
  )
}

function InsightGraph(props: {
  address: string
  relations: AccountInsightRelation[]
  selectedAddress: string | null
  onSelect: (address: string) => void
}) {
  const [zoom, setZoom] = useState(0.88)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragState, setDragState] = useState<{ pointerId: number; x: number; y: number } | null>(null)
  const size = 420
  const center = size / 2
  const radius = 126

  useEffect(() => {
    setZoom(0.88)
    setPan({ x: 0, y: 0 })
  }, [props.address, props.relations])

  function handleZoom(nextZoom: number) {
    setZoom(Math.max(0.7, Math.min(1.4, nextZoom)))
  }

  function handleFit() {
    setZoom(0.88)
    setPan({ x: 0, y: 0 })
  }

  return (
    <div class="account-insight-graph-wrap">
      <div class="account-insight-graph-toolbar">
        <span class="eyebrow">Graph View</span>
        <div class="account-insight-graph-controls">
          <button type="button" onClick={() => handleZoom(zoom - 0.1)}>
            Zoom Out
          </button>
          <button type="button" onClick={handleFit}>
            Fit
          </button>
          <button type="button" onClick={() => handleZoom(zoom + 0.1)}>
            Zoom In
          </button>
        </div>
      </div>
      <div
        class={`account-insight-graph-stage ${dragState ? 'account-insight-graph-stage-panning' : ''}`.trim()}
        onWheel={(event) => {
          event.preventDefault()
          handleZoom(zoom + (event.deltaY < 0 ? 0.08 : -0.08))
        }}
        onPointerDown={(event) => {
          if (event.pointerType === 'mouse' && event.button !== 0) {
            return
          }

          const target = event.target as Element | null

          if (target?.closest('.account-insight-node-group')) {
            return
          }

          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          setDragState({
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
          })
        }}
        onPointerMove={(event) => {
          if (!dragState || dragState.pointerId !== event.pointerId) {
            return
          }

          event.preventDefault()
          const deltaX = event.clientX - dragState.x
          const deltaY = event.clientY - dragState.y
          setPan((current) => ({
            x: current.x + deltaX,
            y: current.y + deltaY,
          }))
          setDragState({
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
          })
        }}
        onPointerUp={(event) => {
          if (!dragState || dragState.pointerId !== event.pointerId) {
            return
          }

          event.currentTarget.releasePointerCapture(event.pointerId)
          setDragState(null)
        }}
        onPointerCancel={(event) => {
          if (!dragState || dragState.pointerId !== event.pointerId) {
            return
          }

          event.currentTarget.releasePointerCapture(event.pointerId)
          setDragState(null)
        }}
      >
        <svg class="account-insight-graph" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Account relationship graph">
          <g transform={`translate(${pan.x} ${pan.y}) translate(${center} ${center}) scale(${zoom}) translate(${-center} ${-center})`}>
            <circle class="account-insight-node account-insight-node-center" cx={center} cy={center} r="28" />
            <InsightGraphCenterLabel address={props.address} x={center} y={center} />

            {props.relations.map((relation, index) => {
              const angle = (-Math.PI / 2) + (index * 2 * Math.PI) / props.relations.length
              const x = center + Math.cos(angle) * radius
              const y = center + Math.sin(angle) * radius
              const labelOffsetX = Math.cos(angle) * 44
              const labelOffsetY = Math.sin(angle) * 44
              const textAnchor = x >= center ? 'start' : 'end'
              const selected = props.selectedAddress === relation.address

              return (
                <g
                  key={relation.address}
                  class={`account-insight-node-group ${selected ? 'account-insight-node-group-selected' : ''}`.trim()}
                  role="button"
                  tabIndex={0}
                  onClick={() => props.onSelect(relation.address)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      props.onSelect(relation.address)
                    }
                  }}
                >
                  <title>
                    {relation.address}: {relation.label}
                  </title>
                  <line
                    class={`account-insight-edge account-insight-edge-${relation.kind} account-insight-edge-${relation.strength} ${selected ? 'account-insight-edge-selected' : ''}`.trim()}
                    x1={center}
                    y1={center}
                    x2={x}
                    y2={y}
                  />
                  <circle
                    class={`account-insight-node account-insight-node-${relation.kind} account-insight-node-${relation.strength} ${selected ? 'account-insight-node-selected' : ''}`.trim()}
                    cx={x}
                    cy={y}
                    r="16"
                  />
                  <text class="account-insight-node-index" x={x} y={y + 4} text-anchor="middle">
                    {index + 1}
                  </text>
                  <InsightGraphNodeLabel
                    address={relation.address}
                    selected={selected}
                    textAnchor={textAnchor}
                    x={x + labelOffsetX}
                    y={y + labelOffsetY - 4}
                  />
                </g>
              )
            })}
          </g>
        </svg>
      </div>
    </div>
  )
}

export function AccountInsightSection(props: AccountInsightSectionProps) {
  const displayedRelations = props.relations.slice(0, 8)
  const [selectedAddress, setSelectedAddress] = useState<string | null>(displayedRelations[0]?.address ?? null)
  const [graphOpen, setGraphOpen] = useState(false)

  useEffect(() => {
    if (displayedRelations.length === 0) {
      setSelectedAddress(null)
      return
    }

    if (!selectedAddress || !displayedRelations.some((relation) => relation.address === selectedAddress)) {
      setSelectedAddress(displayedRelations[0].address)
    }
  }, [displayedRelations, selectedAddress])

  return (
    <PageSection
      title="Insight"
      description="Observed relationships around this address"
      actions={
        displayedRelations.length > 0 ? (
          <div class="panel-header-actions">
            <button
              type="button"
              class={`section-header-toggle ${graphOpen ? 'is-active' : ''}`.trim()}
              onClick={() => setGraphOpen((current) => !current)}
              aria-pressed={graphOpen}
            >
              {graphOpen ? 'Hide graph' : 'Show graph'}
            </button>
          </div>
        ) : undefined
      }
    >
      {displayedRelations.length === 0 ? (
        <EmptyState
          title="No observed relationships"
          body="No direct value flow, invocation, or origin links are currently indexed for this address."
        />
      ) : (
        <>
          <SummaryTable
            className="summary-table-account-insight"
            headers={['Node', 'Relation', 'Activity', 'Evidence', 'Last Seen', 'Example']}
          >
            {displayedRelations.map((relation) => (
              <tr
                key={relation.address}
                class={selectedAddress === relation.address ? 'account-insight-row-selected' : ''}
                onClick={() => setSelectedAddress(relation.address)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setSelectedAddress(relation.address)
                  }
                }}
                tabIndex={0}
              >
                <td>
                  <AddressLink address={relation.address} />
                </td>
                <td>
                  <div class="tx-meta-inline tx-type-inline">
                    <span class={`account-insight-pill account-insight-pill-${relation.kind}`}>{relation.label}</span>
                    <span class={`account-insight-strength account-insight-strength-${relation.strength}`}>
                      {relation.strength}
                    </span>
                    <span class="meta-badge meta-envelope">{relationKindLabel(relation)}</span>
                  </div>
                </td>
                <td>{describeActivity(relation)}</td>
                <td>
                  <div class="account-insight-evidence-list">
                    {relation.supportingEvidence.map((evidence) => (
                      <span class="account-insight-evidence-chip" key={evidence}>
                        {evidence}
                      </span>
                    ))}
                  </div>
                </td>
                <td>{relation.lastSeenBlock === null ? 'n/a' : <BlockLink number={relation.lastSeenBlock} />}</td>
                <td>{relation.sampleTxHash ? <TxLink hash={relation.sampleTxHash} /> : 'n/a'}</td>
              </tr>
            ))}
          </SummaryTable>
          {graphOpen && (
            <>
              <InsightGraph
                address={props.address}
                relations={displayedRelations}
                selectedAddress={selectedAddress}
                onSelect={setSelectedAddress}
              />
              <p class="muted">
                Each edge shows the strongest observed relation first, with supporting evidence listed below.
              </p>
            </>
          )}
        </>
      )}
    </PageSection>
  )
}
