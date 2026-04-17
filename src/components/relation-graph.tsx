import { useCallback, useEffect, useMemo } from 'preact/hooks'
import dagre from 'dagre'
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
  type Edge as FlowEdge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { getResolvedAddressLabel } from '../lib/db.ts'
import { useFlowFullscreen } from '../hooks/use-fullscreen.ts'
import { computeEdgeCrossings } from '../lib/tx-interactions.ts'
import { CrossingEdge } from './crossing-edge.tsx'
import { FullscreenButton } from './fullscreen-button.tsx'
import { shortenHex } from '../lib/format.ts'
import { useAsyncResource } from '../hooks/use-async-resource.ts'
import { useExplorer } from '../hooks/use-explorer.tsx'

export type RelationGraphNode = {
  address: string
  kind: string
  label: string
  strength: 'strong' | 'moderate' | 'loose'
  role?: string | null
}

export type RelationGraphProps = {
  centerAddress: string
  nodes: RelationGraphNode[]
  selectedAddress: string | null
  onSelect: (address: string) => void
}

// --- Color helpers ---

function getKindColor(kind: string): { bg: string; border: string; edge: string } {
  switch (kind) {
    case 'architecture':
      return { bg: '#7c3aed', border: '#8b5cf6', edge: '#8b5cf6' }
    case 'creation':
      return { bg: '#d97706', border: '#f59e0b', edge: '#f59e0b' }
    case 'value-flow':
      return { bg: '#0d9488', border: '#14b8a6', edge: '#14b8a6' }
    case 'invocation':
    default:
      return { bg: '#2563eb', border: '#3b82f6', edge: '#3b82f6' }
  }
}

function getStrengthOpacity(strength: string): number {
  switch (strength) {
    case 'strong':
      return 1
    case 'moderate':
      return 0.7
    default:
      return 0.5
  }
}

// --- Custom node components ---

type InsightNodeData = {
  label: string
  secondaryLabel: string | null
  address: string
  isCenter: boolean
  kind: string
  role: string | null
  selected: boolean
  color: string
  borderColor: string
}

function InsightNode({ data }: NodeProps<FlowNode<InsightNodeData>>) {
  if (data.isCenter) {
    return (
      <div
        class="relation-flow-node relation-flow-node-center"
        style={{
          borderColor: '#6b7280',
        }}
      >
        <Handle type="source" position={Position.Top} class="tx-flow-handle" />
        <Handle type="source" position={Position.Bottom} class="tx-flow-handle" />
        <Handle type="source" position={Position.Left} class="tx-flow-handle" />
        <Handle type="source" position={Position.Right} class="tx-flow-handle" />
        <div class="relation-flow-node-label">{data.label}</div>
        {data.secondaryLabel && (
          <div class="relation-flow-node-address">{data.secondaryLabel}</div>
        )}
      </div>
    )
  }

  return (
    <div
      class={`relation-flow-node relation-flow-node-${data.kind} ${data.selected ? 'relation-flow-node-selected' : ''}`.trim()}
      style={{
        background: data.color,
        borderColor: data.borderColor,
        opacity: getStrengthOpacity('strong'),
      }}
    >
      <Handle type="target" position={Position.Top} class="tx-flow-handle" />
      <Handle type="target" position={Position.Bottom} class="tx-flow-handle" />
      <Handle type="target" position={Position.Left} class="tx-flow-handle" />
      <Handle type="target" position={Position.Right} class="tx-flow-handle" />
      {data.role && <div class="relation-flow-node-role">{data.role}</div>}
      <div class="relation-flow-node-label">{data.label}</div>
      {data.secondaryLabel && (
        <div class="relation-flow-node-address">{data.secondaryLabel}</div>
      )}
    </div>
  )
}

const nodeTypes = { insightNode: InsightNode }
const edgeTypes = { crossingEdge: CrossingEdge }

// --- Dagre layout ---

const NODE_WIDTH = 160
const NODE_HEIGHT = 50

function buildInsightFlowGraph(
  centerAddress: string,
  nodes: RelationGraphNode[],
  resolvedLabels: Map<string, string | null>,
  selectedAddress: string | null,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const centerKey = centerAddress.toLowerCase()
  const centerLabel = resolvedLabels.get(centerKey)

  // Build dagre graph
  const g = new dagre.graphlib.Graph()
  g.setGraph({
    rankdir: 'TB',
    nodesep: 100,
    ranksep: 90,
    marginx: 30,
    marginy: 30,
  })
  g.setDefaultEdgeLabel(() => ({}))

  // Add center node
  g.setNode(centerKey, { width: NODE_WIDTH, height: NODE_HEIGHT })

  // Add peripheral nodes and edges
  for (const node of nodes) {
    const key = node.address.toLowerCase()
    if (key !== centerKey) {
      g.setNode(key, { width: NODE_WIDTH, height: NODE_HEIGHT })
      g.setEdge(centerKey, key)
    }
  }

  dagre.layout(g)

  // Convert to React Flow nodes
  const flowNodes: FlowNode[] = []
  const flowEdges: FlowEdge[] = []

  const centerDagre = g.node(centerKey)
  if (centerDagre) {
    flowNodes.push({
      id: centerKey,
      position: {
        x: centerDagre.x - NODE_WIDTH / 2,
        y: centerDagre.y - NODE_HEIGHT / 2,
      },
      data: {
        label: centerLabel ?? shortenHex(centerAddress, 6),
        secondaryLabel: centerLabel ? shortenHex(centerAddress, 4) : null,
        address: centerAddress,
        isCenter: true,
        kind: 'center',
        role: null,
        selected: false,
        color: '#374151',
        borderColor: '#6b7280',
      },
      type: 'insightNode',
      draggable: true,
    })
  }

  nodes.forEach((node, index) => {
    const key = node.address.toLowerCase()
    const dagreNode = g.node(key)
    if (!dagreNode) return

    const colors = getKindColor(node.kind)
    const resolvedLabel = resolvedLabels.get(key)
    const displayLabel = resolvedLabel ?? shortenHex(node.address, 6)
    const selected = selectedAddress === node.address

    flowNodes.push({
      id: key,
      position: {
        x: dagreNode.x - NODE_WIDTH / 2,
        y: dagreNode.y - NODE_HEIGHT / 2,
      },
      data: {
        label: displayLabel,
        secondaryLabel: resolvedLabel ? shortenHex(node.address, 4) : null,
        address: node.address,
        isCenter: false,
        kind: node.kind,
        role: node.role ?? null,
        selected,
        color: colors.bg,
        borderColor: colors.border,
      },
      type: 'insightNode',
      draggable: true,
    })

    flowEdges.push({
      id: `e-${index}`,
      source: centerKey,
      target: key,
      type: 'smoothstep',
      style: {
        stroke: colors.edge,
        strokeWidth: node.strength === 'strong' ? 2.5 : node.strength === 'moderate' ? 2 : 1.5,
        opacity: getStrengthOpacity(node.strength),
      },
      label: node.label,
      labelStyle: {
        fontSize: 10,
        fontWeight: 600,
        fill: '#9ca3af',
      },
      labelBgStyle: {
        fill: 'rgba(17, 24, 39, 0.85)',
        fillOpacity: 0.85,
      },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
      animated: node.kind === 'architecture',
    })
  })

  // Detect edge crossings and upgrade affected edges to crossingEdge type
  const edgeDescriptors = flowEdges.map((fe) => {
    const sn = g.node(fe.source)
    const tn = g.node(fe.target)
    return { sourceX: sn?.x ?? 0, sourceY: sn?.y ?? 0, targetX: tn?.x ?? 0, targetY: tn?.y ?? 0 }
  })
  const crossingsResult = computeEdgeCrossings(edgeDescriptors, NODE_HEIGHT)
  for (const [i, crossings] of crossingsResult) {
    flowEdges[i] = { ...flowEdges[i], type: 'crossingEdge', data: { crossings } }
  }

  return { nodes: flowNodes, edges: flowEdges }
}

// --- Main component ---

export function RelationGraph(props: RelationGraphProps) {
  const { refreshKey } = useExplorer()

  // Resolve labels for all addresses
  const allAddresses = useMemo(() => {
    const set = new Set<string>()
    set.add(props.centerAddress)
    for (const node of props.nodes) {
      set.add(node.address)
    }
    return [...set]
  }, [props.centerAddress, props.nodes])

  const labelsResource = useAsyncResource(
    async () => {
      const entries: Record<string, string | null> = {}
      await Promise.all(
        allAddresses.map(async (addr) => {
          const label = await getResolvedAddressLabel(addr)
          entries[addr.toLowerCase()] = label ?? null
        }),
      )
      return entries
    },
    [allAddresses, refreshKey],
    {} as Record<string, string | null>,
  )

  const resolvedLabels = useMemo(() => {
    const data = labelsResource.data
    if (!data) return new Map<string, string | null>()
    return new Map(Object.entries(data))
  }, [labelsResource.data])

  const initialFlow = useMemo(
    () => buildInsightFlowGraph(props.centerAddress, props.nodes, resolvedLabels, props.selectedAddress),
    [props.centerAddress, props.nodes, resolvedLabels, props.selectedAddress],
  )

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(initialFlow.nodes)
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState(initialFlow.edges)

  useEffect(() => {
    setFlowNodes(initialFlow.nodes)
    setFlowEdges(initialFlow.edges)
  }, [initialFlow, setFlowNodes, setFlowEdges])

  const onNodeClick = useCallback((_event: unknown, node: FlowNode) => {
    const data = node.data as InsightNodeData
    if (!data.isCenter) {
      props.onSelect(data.address)
    }
  }, [props.onSelect])

  const { fullscreen, toggle: toggleFullscreen, onInit: onFlowInit } = useFlowFullscreen()

  return (
    <div class={`relation-flow-container${fullscreen ? ' flow-fullscreen' : ''}`}>
      <FullscreenButton fullscreen={fullscreen} onClick={toggleFullscreen} />
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onInit={onFlowInit}
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
  )
}
