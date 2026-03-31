import { decodeErrorResult, parseAbi, toHex, type Abi, type Hex } from 'viem'
import { rpcRequest, type AnvilClient } from './rpc.ts'
import type { TransactionFailure, TransactionRecord } from './types.ts'

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

function stringifyDecodedValue(value: unknown): string {
  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyDecodedValue(item)).join(', ')}]`
  }

  if (value && typeof value === 'object') {
    return JSON.stringify(
      value,
      (_, current) => (typeof current === 'bigint' ? current.toString() : current),
      2,
    )
  }

  return String(value)
}

function isHexData(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value)
}

function findHexData(value: unknown, depth = 0): Hex | null {
  if (depth > 6 || value === null || typeof value === 'undefined') {
    return null
  }

  if (isHexData(value) && value.length >= 10) {
    return value
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findHexData(item, depth + 1)
      if (found) {
        return found
      }
    }
  }

  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    for (const key of ['data', 'cause', 'details', 'shortMessage', 'message']) {
      const found = findHexData(object[key], depth + 1)
      if (found) {
        return found
      }
    }

    for (const nestedValue of Object.values(object)) {
      const found = findHexData(nestedValue, depth + 1)
      if (found) {
        return found
      }
    }
  }

  return null
}

function extractErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error
  }

  if (error && typeof error === 'object') {
    const object = error as Record<string, unknown>
    for (const key of ['details', 'message', 'shortMessage']) {
      const value = object[key]
      if (typeof value === 'string' && value.trim()) {
        return value
      }
    }

    if (object.cause) {
      return extractErrorMessage(object.cause)
    }
  }

  if (error instanceof Error) {
    return error.message
  }

  return 'Execution reverted'
}

function normalizeMessage(message: string) {
  return message.replace(/^execution reverted:\s*/i, '').trim()
}

function decodeFailureData(data: Hex, abi: Abi | null | undefined) {
  const candidates = [abi, standardErrorAbi].filter((item): item is Abi => Boolean(item))

  for (const candidate of candidates) {
    try {
      const decoded = decodeErrorResult({
        abi: candidate,
        data,
      })

      const inputNames =
        'inputs' in decoded.abiItem
          ? decoded.abiItem.inputs?.map((input: { name?: string }) => input.name || '?') ?? []
          : []
      const args = Array.isArray(decoded.args)
        ? decoded.args.map((value, index) => ({
            name: inputNames[index] || `arg${index}`,
            value: stringifyDecodedValue(value),
          }))
        : []

      if (decoded.errorName === 'Panic' && args[0]) {
        const panicLabel = PANIC_CODES[args[0].value]
        if (panicLabel) {
          args[0].value = `${args[0].value} (${panicLabel})`
        }
      }

      return {
        errorName: decoded.errorName,
        signature: data.slice(0, 10),
        args,
      }
    } catch {
      continue
    }
  }

  return {
    errorName: null,
    signature: data.slice(0, 10),
    args: [],
  }
}

export async function inspectTransactionFailure(
  client: AnvilClient,
  transaction: TransactionRecord,
  abi: Abi | null | undefined,
): Promise<TransactionFailure | null> {
  const replayBlockNumber = transaction.blockNumber === null ? null : Math.max(0, transaction.blockNumber - 1)

  try {
    await rpcRequest(client, 'eth_call', [
      {
        from: transaction.from,
        to: transaction.to,
        data: transaction.input,
        value: toHex(BigInt(transaction.value)),
        gas: toHex(BigInt(transaction.gas)),
      },
      replayBlockNumber === null ? 'latest' : toHex(replayBlockNumber),
    ])

    return null
  } catch (error: unknown) {
    const rawData = findHexData(error)
    const decoded = rawData ? decodeFailureData(rawData, abi) : null
    const fallbackMessage = normalizeMessage(extractErrorMessage(error))

    return {
      message:
        decoded?.errorName === 'Error' && decoded.args[0]
          ? decoded.args[0].value
          : decoded?.errorName === 'Panic'
            ? `panic: ${decoded.args[0]?.value ?? 'unknown'}`
            : fallbackMessage,
      rawData,
      errorName: decoded?.errorName ?? null,
      signature: decoded?.signature ?? null,
      args: decoded?.args ?? [],
      replayBlockNumber,
    }
  }
}
