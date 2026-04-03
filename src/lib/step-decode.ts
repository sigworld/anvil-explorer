import {
  decodeErrorResult,
  decodeFunctionData,
  getAbiItem,
  parseAbi,
  type Abi,
  type Hex,
} from 'viem'
import type { OpcodeEntry } from './types.ts'

const CALL_OPS = new Set(['CALL', 'STATICCALL', 'DELEGATECALL', 'CALLCODE'])

const standardErrorAbi = parseAbi([
  'error Error(string)',
  'error Panic(uint256)',
])

const PANIC_CODES: Record<string, string> = {
  '0': 'generic panic',
  '1': 'assertion failed',
  '17': 'arithmetic overflow or underflow',
  '18': 'division or modulo by zero',
  '33': 'invalid enum conversion',
  '34': 'invalid encoded storage byte array',
  '49': 'pop on empty array',
  '50': 'array out-of-bounds access',
  '65': 'memory allocation overflow',
  '81': 'call to uninitialized internal function',
}

export type DecodedStepCall = {
  kind: 'call'
  op: string
  targetAddress: string | null
  value: string | null
  selector: string | null
  functionName: string | null
  args: Array<{ name: string; value: string }>
  rawCalldata: string | null
}

export type DecodedStepReturn = {
  kind: 'return'
  op: string
  data: string | null
  decoded: {
    functionName: string | null
    values: Array<{ name: string; value: string }>
  } | null
}

export type DecodedStepRevert = {
  kind: 'revert'
  op: string
  data: string | null
  errorName: string | null
  signature: string | null
  args: Array<{ name: string; value: string }>
  message: string | null
}

export type DecodedStep = DecodedStepCall | DecodedStepReturn | DecodedStepRevert | null

function readBigInt(value: string | undefined): bigint | null {
  if (!value) return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

function hexWordsToBytes(memory: string[] | undefined): string | null {
  if (!memory || memory.length === 0) return null
  return memory.map((w) => (w.startsWith('0x') ? w.slice(2) : w)).join('')
}

function sliceMemory(memory: string[] | undefined, offset: bigint | null, size: bigint | null): string | null {
  if (offset === null || size === null || offset < 0n || size <= 0n) return null
  if (offset > BigInt(Number.MAX_SAFE_INTEGER) || size > BigInt(Number.MAX_SAFE_INTEGER)) return null

  const bytes = hexWordsToBytes(memory)
  if (!bytes) return null

  const start = Number(offset) * 2
  const end = start + Number(size) * 2
  if (start < 0 || end > bytes.length) return null

  return `0x${bytes.slice(start, end)}`
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return `[${value.map(stringifyValue).join(', ')}]`
  if (value && typeof value === 'object') {
    return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
  }
  return String(value)
}

/**
 * Extract calldata from stack+memory at a CALL-family opcode.
 *
 * CALL stack layout (top→bottom): gas, addr, value, argsOffset, argsLength, retOffset, retLength
 * STATICCALL/DELEGATECALL: gas, addr, argsOffset, argsLength, retOffset, retLength (no value)
 */
function extractCallData(entry: OpcodeEntry): { calldata: string | null; targetAddress: string | null; value: string | null } {
  const stack = entry.stack
  const top = stack.length - 1

  if (entry.op === 'CALL' || entry.op === 'CALLCODE') {
    const addr = stack[top - 1]
    const value = readBigInt(stack[top - 2])
    const argsOffset = readBigInt(stack[top - 3])
    const argsLength = readBigInt(stack[top - 4])
    return {
      calldata: sliceMemory(entry.memory, argsOffset, argsLength),
      targetAddress: addr ?? null,
      value: value !== null && value > 0n ? value.toString() : null,
    }
  }

  // STATICCALL, DELEGATECALL: no value field
  const addr = stack[top - 1]
  const argsOffset = readBigInt(stack[top - 2])
  const argsLength = readBigInt(stack[top - 3])
  return {
    calldata: sliceMemory(entry.memory, argsOffset, argsLength),
    targetAddress: addr ?? null,
    value: null,
  }
}

function extractReturnData(entry: OpcodeEntry): string | null {
  const top = entry.stack.length - 1
  const offset = readBigInt(entry.stack[top])
  const size = readBigInt(entry.stack[top - 1])
  return sliceMemory(entry.memory, offset, size)
}

function tryDecodeCalldata(calldata: string, abiMap: Map<string, Abi>): { functionName: string; args: Array<{ name: string; value: string }> } | null {
  if (!calldata || calldata.length < 10) return null

  for (const abi of abiMap.values()) {
    try {
      const decoded = decodeFunctionData({ abi, data: calldata as Hex })
      const values = Array.isArray(decoded.args) ? decoded.args : []
      const abiItem = getAbiItem({ abi, name: calldata.slice(0, 10) as Hex, args: values })
      const inputs = abiItem?.type === 'function' ? abiItem.inputs ?? [] : []
      return {
        functionName: decoded.functionName,
        args: values.map((v, i) => ({
          name: inputs[i]?.name || `arg${i}`,
          value: stringifyValue(v),
        })),
      }
    } catch {
      continue
    }
  }

  return null
}

function tryDecodeError(data: string, abiMap: Map<string, Abi>): { errorName: string | null; signature: string | null; args: Array<{ name: string; value: string }>; message: string | null } {
  const candidates = [...abiMap.values(), standardErrorAbi]

  for (const abi of candidates) {
    try {
      const decoded = decodeErrorResult({ abi, data: data as Hex })
      const inputNames = 'inputs' in decoded.abiItem
        ? decoded.abiItem.inputs?.map((input: { name?: string }) => input.name || '?') ?? []
        : []
      const args = Array.isArray(decoded.args)
        ? decoded.args.map((value, index) => ({
            name: inputNames[index] || `arg${index}`,
            value: stringifyValue(value),
          }))
        : []

      let message: string | null = null
      if (decoded.errorName === 'Error' && args[0]) {
        message = args[0].value
      } else if (decoded.errorName === 'Panic' && args[0]) {
        const panicLabel = PANIC_CODES[args[0].value]
        if (panicLabel) {
          args[0].value = `${args[0].value} (${panicLabel})`
        }
        message = `panic: ${args[0].value}`
      }

      return {
        errorName: decoded.errorName,
        signature: data.slice(0, 10),
        args,
        message,
      }
    } catch {
      continue
    }
  }

  return { errorName: null, signature: data.length >= 10 ? data.slice(0, 10) : null, args: [], message: null }
}

/**
 * Decode the current step's semantics given the opcode entry and available ABIs.
 * Returns decoded call/return/revert info when applicable, null for plain opcodes.
 */
export function decodeStep(
  entry: OpcodeEntry,
  abiMap: Map<string, Abi>,
): DecodedStep {
  if (CALL_OPS.has(entry.op)) {
    const { calldata, targetAddress, value } = extractCallData(entry)
    const decoded = calldata ? tryDecodeCalldata(calldata, abiMap) : null

    return {
      kind: 'call',
      op: entry.op,
      targetAddress,
      value,
      selector: calldata && calldata.length >= 10 ? calldata.slice(0, 10) : null,
      functionName: decoded?.functionName ?? null,
      args: decoded?.args ?? [],
      rawCalldata: calldata,
    }
  }

  if (entry.op === 'RETURN') {
    const data = extractReturnData(entry)
    return {
      kind: 'return',
      op: entry.op,
      data,
      decoded: null, // Return value decode requires knowing what function was called
    }
  }

  if (entry.op === 'REVERT') {
    const data = extractReturnData(entry)
    const decoded = data && data.length >= 10 ? tryDecodeError(data, abiMap) : null

    return {
      kind: 'revert',
      op: entry.op,
      data,
      errorName: decoded?.errorName ?? null,
      signature: decoded?.signature ?? null,
      args: decoded?.args ?? [],
      message: decoded?.message ?? null,
    }
  }

  return null
}
