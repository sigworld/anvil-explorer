import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
} from '@xyflow/react'
import type { EdgeCrossing } from '../lib/tx-interactions.ts'

const ARC_RADIUS = 7

/**
 * Build an SVG path for a smoothstep-style edge (TB layout) that adds small
 * arc jumps wherever the edge crosses another edge.
 */
function buildCrossingPath(
  sourceX: number, sourceY: number,
  targetX: number, targetY: number,
  crossings: EdgeCrossing[],
  borderRadius: number,
): string {
  const midY = (sourceY + targetY) / 2
  const r = Math.min(borderRadius, Math.abs(targetX - sourceX) / 2, Math.abs(midY - sourceY), Math.abs(targetY - midY))
  const goingRight = targetX > sourceX
  const hDir = goingRight ? 1 : -1

  // Classify crossings by segment
  const vTopCrossings: number[] = []   // y values on the vertical segment sourceX, sourceY -> midY
  const hCrossings: number[] = []       // x values on the horizontal segment
  const vBottomCrossings: number[] = [] // y values on the vertical segment targetX, midY -> targetY

  for (const c of crossings) {
    // On top vertical segment?
    if (Math.abs(c.x - sourceX) < 1 && c.y > sourceY && c.y < midY) {
      vTopCrossings.push(c.y)
    }
    // On horizontal segment?
    else if (Math.abs(c.y - midY) < 1) {
      const hMin = Math.min(sourceX, targetX)
      const hMax = Math.max(sourceX, targetX)
      if (c.x > hMin && c.x < hMax) {
        hCrossings.push(c.x)
      }
    }
    // On bottom vertical segment?
    else if (Math.abs(c.x - targetX) < 1 && c.y > midY && c.y < targetY) {
      vBottomCrossings.push(c.y)
    }
  }

  vTopCrossings.sort((a, b) => a - b)
  hCrossings.sort((a, b) => goingRight ? a - b : b - a)
  vBottomCrossings.sort((a, b) => a - b)

  const parts: string[] = [`M ${sourceX} ${sourceY}`]

  // Top vertical segment with crossings
  for (const cy of vTopCrossings) {
    parts.push(`L ${sourceX} ${cy - ARC_RADIUS}`)
    // Arc bulges right
    parts.push(`A ${ARC_RADIUS} ${ARC_RADIUS} 0 0 1 ${sourceX} ${cy + ARC_RADIUS}`)
  }

  // Corner from vertical to horizontal
  if (Math.abs(targetX - sourceX) > 0.5 && r > 0.5) {
    parts.push(`L ${sourceX} ${midY - r}`)
    parts.push(`Q ${sourceX} ${midY} ${sourceX + hDir * r} ${midY}`)
  } else {
    parts.push(`L ${sourceX} ${midY}`)
  }

  // Horizontal segment with crossings
  for (const cx of hCrossings) {
    const approachX = cx - hDir * ARC_RADIUS
    parts.push(`L ${approachX} ${midY}`)
    // Arc bulges up (sweep depends on direction)
    const sweep = goingRight ? 0 : 1
    parts.push(`A ${ARC_RADIUS} ${ARC_RADIUS} 0 0 ${sweep} ${cx + hDir * ARC_RADIUS} ${midY}`)
  }

  // Corner from horizontal to vertical
  if (Math.abs(targetX - sourceX) > 0.5 && r > 0.5) {
    parts.push(`L ${targetX - hDir * r} ${midY}`)
    parts.push(`Q ${targetX} ${midY} ${targetX} ${midY + r}`)
  } else {
    parts.push(`L ${targetX} ${midY}`)
  }

  // Bottom vertical segment with crossings
  for (const cy of vBottomCrossings) {
    parts.push(`L ${targetX} ${cy - ARC_RADIUS}`)
    parts.push(`A ${ARC_RADIUS} ${ARC_RADIUS} 0 0 1 ${targetX} ${cy + ARC_RADIUS}`)
  }

  parts.push(`L ${targetX} ${targetY}`)
  return parts.join(' ')
}

export function CrossingEdge(props: EdgeProps) {
  const crossings = ((props.data as Record<string, unknown>)?.crossings as EdgeCrossing[]) ?? []

  const path = buildCrossingPath(
    props.sourceX, props.sourceY,
    props.targetX, props.targetY,
    crossings,
    8,
  )

  // Compute label position at midpoint of horizontal segment
  const midY = (props.sourceY + props.targetY) / 2
  const labelX = (props.sourceX + props.targetX) / 2
  const labelY = midY
  const ls = props.labelStyle as Record<string, unknown> | undefined

  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        style={props.style}
        markerEnd={props.markerEnd}
        markerStart={props.markerStart}
      />
      {props.label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
              fontSize: (ls?.fontSize as number) ?? 10,
              fontWeight: (ls?.fontWeight as number) ?? 600,
              color: (ls?.fill as string) ?? '#9ca3af',
              background: 'rgba(17, 24, 39, 0.85)',
              padding: '3px 6px',
              borderRadius: '4px',
            }}
            class="nodrag nopan"
          >
            {props.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
