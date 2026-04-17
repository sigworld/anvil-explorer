import dagre from 'dagre'
import type { Hex } from 'viem'
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react'
import type { TraceNode } from './types.ts'
import { shortenHex } from './format.ts'

export type TxInteraction = {
  from: Hex
  to: Hex
  callType: string
  functionName: string | null
  selector: string | null
  value: string | null
  status: 'success' | 'reverted' | 'failed'
}

export type TxInteractionNode = {
  address: Hex
  roles: Set<string>
  callCount: number
  totalValue: bigint
}

export type TxInteractionGraph = {
  nodes: Map<string, TxInteractionNode>
  edges: TxInteraction[]
  primaryAddress: Hex
}

function ensureNode(nodes: Map<string, TxInteractionNode>, address: Hex): TxInteractionNode {
  const key = address.toLowerCase()
  const existing = nodes.get(key)

  if (existing) {
    return existing
  }

  const node: TxInteractionNode = {
    address,
    roles: new Set(),
    callCount: 0,
    totalValue: 0n,
  }
  nodes.set(key, node)
  return node
}

function walkTrace(
  trace: TraceNode,
  nodes: Map<string, TxInteractionNode>,
  edges: TxInteraction[],
) {
  if (!trace.from || !trace.to) {
    for (const child of trace.calls) {
      walkTrace(child, nodes, edges)
    }
    return
  }

  const fromNode = ensureNode(nodes, trace.from)
  const toNode = ensureNode(nodes, trace.to)
  const callType = (trace.type || 'CALL').toUpperCase()

  fromNode.callCount += 1
  toNode.callCount += 1

  if (trace.value && trace.value !== '0') {
    try {
      const valueAmount = BigInt(trace.value)
      fromNode.totalValue += valueAmount
      toNode.totalValue += valueAmount
    } catch {
      // ignore parse errors
    }
  }

  // Assign roles
  if (callType === 'DELEGATECALL') {
    toNode.roles.add('delegate-target')
  } else if (callType === 'CREATE' || callType === 'CREATE2') {
    fromNode.roles.add('creator')
    toNode.roles.add('created')
  } else if (callType === 'STATICCALL') {
    toNode.roles.add('read-target')
  } else {
    toNode.roles.add('call-target')
  }

  edges.push({
    from: trace.from,
    to: trace.to,
    callType,
    functionName: trace.functionName ?? null,
    selector: trace.selector ?? null,
    value: trace.value ?? null,
    status: trace.status,
  })

  for (const child of trace.calls) {
    walkTrace(child, nodes, edges)
  }
}

export function buildTxInteractionGraph(
  trace: TraceNode,
  txFrom: Hex,
  txTo: Hex | null,
): TxInteractionGraph {
  const nodes = new Map<string, TxInteractionNode>()
  const edges: TxInteraction[] = []

  const senderNode = ensureNode(nodes, txFrom)
  senderNode.roles.add('sender')

  if (txTo) {
    const receiverNode = ensureNode(nodes, txTo)
    receiverNode.roles.add('receiver')
  }

  walkTrace(trace, nodes, edges)

  return { nodes, edges, primaryAddress: txFrom }
}

// --- React Flow conversion with dagre layout ---

type DeduplicatedEdge = {
  from: Hex
  to: Hex
  dominantCallType: string
  functions: string[]
  count: number
}

function deduplicateEdges(edges: TxInteraction[]): DeduplicatedEdge[] {
  const grouped = new Map<string, {
    from: Hex
    to: Hex
    callTypes: Map<string, number>
    functions: Set<string>
    count: number
  }>()

  for (const edge of edges) {
    const fromKey = edge.from.toLowerCase()
    const toKey = edge.to.toLowerCase()

    if (fromKey === toKey) {
      continue
    }

    const pairKey = `${fromKey}:${toKey}`
    const existing = grouped.get(pairKey)

    if (existing) {
      existing.count += 1
      existing.callTypes.set(edge.callType, (existing.callTypes.get(edge.callType) ?? 0) + 1)

      if (edge.functionName) {
        existing.functions.add(edge.functionName)
      }
    } else {
      grouped.set(pairKey, {
        from: edge.from,
        to: edge.to,
        callTypes: new Map([[edge.callType, 1]]),
        functions: new Set(edge.functionName ? [edge.functionName] : []),
        count: 1,
      })
    }
  }

  return [...grouped.values()].map((acc) => {
    let dominantType = 'CALL'
    let maxCount = 0

    for (const [type, count] of acc.callTypes) {
      if (count > maxCount) {
        dominantType = type
        maxCount = count
      }
    }

    return {
      from: acc.from,
      to: acc.to,
      dominantCallType: dominantType,
      functions: [...acc.functions],
      count: acc.count,
    }
  })
}

function getNodeColor(node: TxInteractionNode, isPrimary: boolean): string {
  if (isPrimary) {
    return '#374151'
  }

  if (node.roles.has('delegate-target')) {
    return '#7c3aed'
  }

  if (node.roles.has('created')) {
    return '#d97706'
  }

  if (node.roles.has('creator')) {
    return '#d97706'
  }

  return '#0d9488'
}

function getNodeBorderColor(node: TxInteractionNode, isPrimary: boolean): string {
  if (isPrimary) {
    return '#6b7280'
  }

  if (node.roles.has('delegate-target')) {
    return '#8b5cf6'
  }

  if (node.roles.has('created') || node.roles.has('creator')) {
    return '#f59e0b'
  }

  return '#14b8a6'
}

function getEdgeColor(callType: string): string {
  switch (callType) {
    case 'DELEGATECALL':
      return '#8b5cf6'
    case 'CREATE':
    case 'CREATE2':
      return '#f59e0b'
    case 'STATICCALL':
      return '#6b7280'
    default:
      return '#14b8a6'
  }
}

function getEdgeStyle(callType: string): string {
  switch (callType) {
    case 'DELEGATECALL':
      return '5 3'
    case 'STATICCALL':
      return '3 3'
    default:
      return ''
  }
}

function getRoleLabel(node: TxInteractionNode, isPrimary: boolean): string {
  if (isPrimary) {
    return 'sender'
  }

  if (node.roles.has('delegate-target')) {
    return 'delegate'
  }

  if (node.roles.has('created')) {
    return 'created'
  }

  if (node.roles.has('creator')) {
    return 'deployer'
  }

  if (node.roles.has('receiver')) {
    return 'receiver'
  }

  return 'contract'
}

export function buildFlowGraph(
  graph: TxInteractionGraph,
  resolvedLabels?: Map<string, string | null>,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const primaryKey = graph.primaryAddress.toLowerCase()
  const deduped = deduplicateEdges(graph.edges)

  // Build dagre graph for layout
  const g = new dagre.graphlib.Graph()
  g.setGraph({
    rankdir: 'TB',
    nodesep: 120,
    ranksep: 100,
    marginx: 30,
    marginy: 30,
  })
  g.setDefaultEdgeLabel(() => ({}))

  const nodeWidth = 170
  const nodeHeight = 50

  for (const [key, node] of graph.nodes) {
    void node
    g.setNode(key, { width: nodeWidth, height: nodeHeight })
  }

  for (const edge of deduped) {
    const fromKey = edge.from.toLowerCase()
    const toKey = edge.to.toLowerCase()

    if (g.hasNode(fromKey) && g.hasNode(toKey)) {
      g.setEdge(fromKey, toKey)
    }
  }

  dagre.layout(g)

  // Convert to React Flow nodes
  const flowNodes: FlowNode[] = []

  for (const [key, node] of graph.nodes) {
    const dagreNode = g.node(key)

    if (!dagreNode) {
      continue
    }

    const isPrimary = key === primaryKey
    const resolvedLabel = resolvedLabels?.get(key)
    const displayLabel = resolvedLabel || shortenHex(node.address, 6)
    const roleLabel = getRoleLabel(node, isPrimary)

    flowNodes.push({
      id: key,
      position: {
        x: dagreNode.x - nodeWidth / 2,
        y: dagreNode.y - nodeHeight / 2,
      },
      data: {
        label: displayLabel,
        role: roleLabel,
        address: node.address,
        color: getNodeColor(node, isPrimary),
        borderColor: getNodeBorderColor(node, isPrimary),
        isPrimary,
      },
      type: 'interactionNode',
      draggable: true,
    })
  }

  // Convert to React Flow edges
  const flowEdges: FlowEdge[] = deduped.map((edge, index) => {
    const edgeLabel = edge.functions.length > 0
      ? edge.functions.slice(0, 2).map((f) => f.length > 16 ? f.slice(0, 15) + '…' : f).join(', ')
        + (edge.functions.length > 2 ? ' +' + (edge.functions.length - 2) : '')
      : edge.dominantCallType

    return {
      id: `e-${index}`,
      source: edge.from.toLowerCase(),
      target: edge.to.toLowerCase(),
      label: edgeLabel,
      animated: edge.dominantCallType === 'DELEGATECALL',
      style: {
        stroke: getEdgeColor(edge.dominantCallType),
        strokeWidth: Math.min(edge.count + 1, 4),
        strokeDasharray: getEdgeStyle(edge.dominantCallType),
      },
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
    }
  })

  return { nodes: flowNodes, edges: flowEdges }
}
