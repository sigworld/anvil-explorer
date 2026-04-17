import { useEffect, useState } from 'preact/hooks'
import { formatEtherString } from '../lib/format.ts'
import type { ContractArchitecture } from '../lib/contract-architecture.ts'
import { architectureKindLabel } from '../lib/contract-architecture.ts'
import type { AccountInsightRelation } from '../lib/types.ts'
import { AddressLink, BlockLink, PageSection, SummaryTable, TxLink } from './common.tsx'
import { RelationGraph, type RelationGraphNode } from './relation-graph.tsx'

type AccountInsightSectionProps = {
  address: string
  relations: AccountInsightRelation[]
  architecture?: ContractArchitecture | null
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

  if (relation.kind === 'architecture' && parts.length === 0) {
    return relation.label
  }

  return parts.join(', ')
}

function relationKindLabel(relation: AccountInsightRelation) {
  switch (relation.kind) {
    case 'architecture':
      return 'architecture'
    case 'creation':
      return 'origin'
    case 'value-flow':
      return 'value flow'
    case 'invocation':
      return 'invocation'
  }
}

function toGraphNodes(relations: AccountInsightRelation[]): RelationGraphNode[] {
  return relations.map((relation) => ({
    address: relation.address,
    kind: relation.kind,
    label: relation.label,
    strength: relation.strength,
    role: relation.architectureRole ?? null,
  }))
}

export function AccountInsightSection(props: AccountInsightSectionProps) {
  const displayedRelations = props.relations.slice(0, 8)
  const [selectedAddress, setSelectedAddress] = useState<string | null>(displayedRelations[0]?.address ?? null)
  const [graphOpen, setGraphOpen] = useState(false)
  const archLabel = props.architecture ? architectureKindLabel(props.architecture.kind) : null

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
      title={
        archLabel
          ? <span>Insight <span class="account-insight-arch-badge">{archLabel}</span></span>
          : 'Insight'
      }
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
        <div class="empty-state">
          <p class="empty-state-title">No observed relationships</p>
          <p class="empty-state-body">No direct value flow, invocation, or origin links are currently indexed for this address.</p>
        </div>
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
                    {relation.architectureRole && (
                      <span class="account-insight-role-badge">{relation.architectureRole}</span>
                    )}
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
              <RelationGraph
                centerAddress={props.address}
                nodes={toGraphNodes(displayedRelations)}
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
