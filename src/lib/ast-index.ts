import type { SourceAstNode } from './types.ts'

export type SrcLocation = {
  start: number
  length: number
  fileIndex: number
}

export type AstInterval = {
  nodeType: string
  name: string | null
  start: number
  length: number
  end: number
  depth: number
}

export type AstContext = {
  contract: AstInterval | null
  declaration: AstInterval | null
  functionLike: AstInterval | null
  statement: AstInterval | null
}

const STATEMENT_NODE_TYPES = new Set([
  'EmitStatement',
  'ExpressionStatement',
  'ForStatement',
  'IfStatement',
  'InlineAssembly',
  'PlaceholderStatement',
  'Return',
  'ReturnStatement',
  'RevertStatement',
  'TryStatement',
  'UncheckedBlock',
  'VariableDeclarationStatement',
  'WhileStatement',
  'DoWhileStatement',
  'YulAssignment',
  'YulBlock',
  'YulBreak',
  'YulContinue',
  'YulExpressionStatement',
  'YulForLoop',
  'YulIf',
  'YulLeave',
  'YulSwitch',
  'YulVariableDeclaration',
])

const DECLARATION_NODE_TYPES = new Set([
  'ContractDefinition',
  'EnumDefinition',
  'ErrorDefinition',
  'EventDefinition',
  'ModifierDefinition',
  'StructDefinition',
  'UserDefinedValueTypeDefinition',
  'VariableDeclaration',
])

const FUNCTION_NODE_TYPES = new Set([
  'FunctionDefinition',
  'ModifierDefinition',
  'YulFunctionDefinition',
])

export function parseSrc(src: string): SrcLocation | null {
  const [startText, lengthText, fileIndexText] = src.split(':')
  const start = Number.parseInt(startText ?? '', 10)
  const length = Number.parseInt(lengthText ?? '', 10)
  const fileIndex = Number.parseInt(fileIndexText ?? '', 10)

  if (!Number.isFinite(start) || !Number.isFinite(length) || !Number.isFinite(fileIndex)) {
    return null
  }

  return { start, length, fileIndex }
}

function extractNodeName(node: SourceAstNode): string | null {
  if (typeof node.name === 'string' && node.name.length > 0) {
    return node.name
  }
  if (typeof node.kind === 'string' && node.kind.length > 0) {
    return node.kind
  }
  if (typeof node.operator === 'string' && node.operator.length > 0) {
    return node.operator
  }
  return null
}

function isAstNode(value: unknown): value is SourceAstNode {
  return !!value &&
    typeof value === 'object' &&
    typeof (value as { nodeType?: unknown }).nodeType === 'string' &&
    typeof (value as { src?: unknown }).src === 'string'
}

function isStatementNode(nodeType: string) {
  return STATEMENT_NODE_TYPES.has(nodeType) || nodeType.endsWith('Statement')
}

function isDeclarationNode(nodeType: string) {
  return DECLARATION_NODE_TYPES.has(nodeType)
}

function containsRange(node: AstInterval, start: number, end: number) {
  return start >= node.start && end <= node.end
}

export function buildAstIntervals(root: SourceAstNode | null | undefined, sourceId?: number): AstInterval[] {
  if (!root) {
    return []
  }

  const result: AstInterval[] = []
  const seen = new WeakSet<object>()

  function visit(value: unknown, depth: number) {
    if (!value || typeof value !== 'object') {
      return
    }

    if (seen.has(value as object)) {
      return
    }
    seen.add(value as object)

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth)
      }
      return
    }

    if (isAstNode(value)) {
      const parsed = parseSrc(value.src)
      if (parsed && (sourceId === undefined || parsed.fileIndex === sourceId)) {
        result.push({
          nodeType: value.nodeType,
          name: extractNodeName(value),
          start: parsed.start,
          length: parsed.length,
          end: parsed.start + parsed.length,
          depth,
        })
      }
      for (const nested of Object.values(value)) {
        visit(nested, depth + 1)
      }
      return
    }

    for (const nested of Object.values(value as Record<string, unknown>)) {
      visit(nested, depth)
    }
  }

  visit(root, 0)
  result.sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start
    }
    if (left.end !== right.end) {
      return right.end - left.end
    }
    return left.depth - right.depth
  })
  return result
}

function deepestMatch(intervals: AstInterval[], predicate: (node: AstInterval) => boolean, start: number, end: number) {
  let match: AstInterval | null = null
  for (const interval of intervals) {
    if (!predicate(interval) || !containsRange(interval, start, end)) {
      continue
    }
    if (!match || interval.depth >= match.depth) {
      match = interval
    }
  }
  return match
}

export function findAstContext(intervals: AstInterval[], start: number, length: number): AstContext {
  const end = start + Math.max(length, 0)
  return {
    contract: deepestMatch(intervals, (node) => node.nodeType === 'ContractDefinition', start, end),
    declaration: deepestMatch(intervals, (node) => isDeclarationNode(node.nodeType), start, end),
    functionLike: deepestMatch(intervals, (node) => FUNCTION_NODE_TYPES.has(node.nodeType), start, end),
    statement: deepestMatch(intervals, (node) => isStatementNode(node.nodeType), start, end),
  }
}

export function formatAstLabel(node: AstInterval | null) {
  if (!node) {
    return 'n/a'
  }
  return node.name ? `${node.nodeType}: ${node.name}` : node.nodeType
}
