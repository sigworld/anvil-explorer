import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'
import type { Hex } from 'viem'
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  type NodeProps,
  type Node as FlowNode,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { TraceNode } from '../lib/types.ts'
import { getResolvedAddressLabel } from '../lib/db.ts'
import { shortenHex } from '../lib/format.ts'
import { buildTxInteractionGraph, buildFlowGraph, type TxInteraction } from '../lib/tx-interactions.ts'
import { AddressLink, SummaryTable } from './common.tsx'

type TxInteractionSectionProps = {
  trace: TraceNode
  txFrom: Hex
  txTo: Hex | null
}

// --- Custom node component ---

type InteractionNodeData = {
  label: string
  role: string
  address: string
  color: string
  borderColor: string
  isPrimary: boolean
}

function InteractionNode({ data }: NodeProps<FlowNode<InteractionNodeData>>) {
  return (
    <div
      class="tx-flow-node"
      style={{
        background: data.color,
        borderColor: data.borderColor,
        borderWidth: data.isPrimary ? '2px' : '1.5px',
      }}
    >
      <Handle type="target" position={Position.Top} class="tx-flow-handle" />
      <div class="tx-flow-node-role">{data.role}</div>
      <div class="tx-flow-node-label" title={data.address}>{data.label}</div>
      <Handle type="source" position={Position.Bottom} class="tx-flow-handle" />
    </div>
  )
}

const nodeTypes = { interactionNode: InteractionNode }

// --- Edge detail table sub-components ---

function CallTypeBadge(props: { callType: string }) {
  const kindClass =
    props.callType === 'DELEGATECALL'
      ? 'account-insight-pill-architecture'
      : props.callType === 'CREATE' || props.callType === 'CREATE2'
        ? 'account-insight-pill-creation'
        : 'account-insight-pill-invocation'

  return <span class={`account-insight-pill ${kindClass}`}>{props.callType}</span>
}

function StatusBadge(props: { status: TxInteraction['status'] }) {
  const className =
    props.status === 'success'
      ? 'account-insight-strength-strong'
      : props.status === 'reverted'
        ? 'account-insight-strength-moderate'
        : 'account-insight-strength'

  return (
    <span class={`account-insight-strength ${className}`}>
      {props.status}
    </span>
  )
}

// --- Main component ---

export function TxInteractionSection(props: TxInteractionSectionProps) {
  const graph = useMemo(
    () => buildTxInteractionGraph(props.trace, props.txFrom, props.txTo),
    [props.trace, props.txFrom, props.txTo],
  )

  // Resolve address labels for nicer node display
  const [resolvedLabels, setResolvedLabels] = useState<Map<string, string | null>>(new Map())

  useEffect(() => {
    const addresses = [...graph.nodes.keys()]
    let cancelled = false

    Promise.all(
      addresses.map(async (key) => {
        const node = graph.nodes.get(key)

        if (!node) {
          return [key, null] as const
        }

        const label = await getResolvedAddressLabel(node.address)
        return [key, label ?? shortenHex(node.address, 6)] as const
      }),
    ).then((results) => {
      if (!cancelled) {
        setResolvedLabels(new Map(results))
      }
    })

    return () => {
      cancelled = true
    }
  }, [graph.nodes])

  const initialFlow = useMemo(
    () => buildFlowGraph(graph, resolvedLabels),
    [graph, resolvedLabels],
  )

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(initialFlow.nodes)
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState(initialFlow.edges)

  // Sync when the computed graph changes (e.g. labels resolve)
  useEffect(() => {
    setFlowNodes(initialFlow.nodes)
    setFlowEdges(initialFlow.edges)
  }, [initialFlow, setFlowNodes, setFlowEdges])

  const [selectedAddress, setSelectedAddress] = useState<string | null>(null)

  const onNodeClick = useCallback((_event: unknown, node: FlowNode) => {
    const addr = (node.data as InteractionNodeData).address
    setSelectedAddress((prev) =>
      prev?.toLowerCase() === addr.toLowerCase() ? null : addr,
    )
  }, [])

  const filteredEdges = useMemo(() => {
    if (!selectedAddress) {
      return graph.edges
    }

    const selectedLower = selectedAddress.toLowerCase()
    return graph.edges.filter(
      (edge) =>
        edge.from.toLowerCase() === selectedLower ||
        edge.to.toLowerCase() === selectedLower,
    )
  }, [graph.edges, selectedAddress])

  if (graph.nodes.size <= 1) {
    return (
      <div class="empty-state">
        <p class="empty-state-title">No contract interactions</p>
        <p class="empty-state-body">This transaction did not involve multiple contract interactions.</p>
      </div>
    )
  }

  return (
    <div class="tx-interaction-section">
      <div class="tx-flow-container">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          fitView
          minZoom={0.3}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{
            type: 'smoothstep',
          }}
        >
          <Background color="#374151" gap={20} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {filteredEdges.length > 0 && (
        <SummaryTable
          className="summary-table-tx-interactions"
          headers={['From', 'To', 'Type', 'Function', 'Value', 'Status']}
        >
          {filteredEdges.map((edge, index) => (
            <tr key={index}>
              <td>
                <AddressLink address={edge.from} />
              </td>
              <td>
                <AddressLink address={edge.to} />
              </td>
              <td>
                <CallTypeBadge callType={edge.callType} />
              </td>
              <td class="monospace">
                {edge.functionName
                  ? `${edge.functionName}()`
                  : edge.selector
                    ? edge.selector
                    : '-'}
              </td>
              <td class="monospace">
                {edge.value && edge.value !== '0' ? edge.value : '-'}
              </td>
              <td>
                <StatusBadge status={edge.status} />
              </td>
            </tr>
          ))}
        </SummaryTable>
      )}
    </div>
  )
}
