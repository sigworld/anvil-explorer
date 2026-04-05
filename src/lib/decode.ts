import {
  decodeEventLog,
  decodeFunctionData,
  getAbiItem,
  getAddress,
  isAddress,
  type Abi,
  type Hex,
} from 'viem'
import type { AbiRecord, DecodedEvent, DecodedFunctionCall, LogRecord, TransactionRecord } from './types.ts'

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

function makeSignature(name: string, args: Array<{ name: string }>) {
  const labels = args.map((arg) => arg.name || '?').join(', ')
  return `${name}(${labels})`
}

export function parseAbiInput(source: string): Abi {
  const parsed = JSON.parse(source) as unknown

  if (Array.isArray(parsed)) {
    return parsed as Abi
  }

  if (parsed && typeof parsed === 'object' && 'abi' in parsed && Array.isArray(parsed.abi)) {
    return parsed.abi as Abi
  }

  throw new Error('ABI input must be a JSON ABI array or a Forge artifact object with an abi field')
}

export function normalizeAbiAddress(address: string) {
  if (!isAddress(address)) {
    throw new Error('Invalid contract address')
  }

  return getAddress(address)
}

export function toAbiRecord(address: string, source: string): AbiRecord {
  return {
    address: normalizeAbiAddress(address),
    abi: parseAbiInput(source),
    source,
    updatedAt: Date.now(),
  }
}

export function decodeTransaction(transaction: TransactionRecord, abi: Abi | null | undefined): DecodedFunctionCall | null {
  if (!abi || !transaction.to || transaction.input === '0x') {
    return null
  }

  try {
    const decoded = decodeFunctionData({
      abi,
      data: transaction.input,
    })

    const values = Array.isArray(decoded.args) ? decoded.args : []
    const abiItem = getAbiItem({
      abi,
      name: transaction.input.slice(0, 10) as Hex,
      args: values,
    })
    const inputs = abiItem?.type === 'function' ? abiItem.inputs ?? [] : []
    const args = values.map((value, index) => ({
      name: inputs[index]?.name || `arg${index}`,
      value: stringifyDecodedValue(value),
    }))

    return {
      functionName: decoded.functionName,
      signature: makeSignature(decoded.functionName, args),
      args,
    }
  } catch {
    return null
  }
}

export function mergeAbis(abis: Array<Abi | null | undefined>): Abi {
  const merged: Abi[number][] = []
  const seen = new Set<string>()

  for (const abi of abis) {
    if (!abi) continue
    for (const item of abi) {
      const key = JSON.stringify(item)
      if (!seen.has(key)) {
        seen.add(key)
        merged.push(item)
      }
    }
  }

  return merged as Abi
}

export function decodeLog(log: LogRecord, abi: Abi | null | undefined): DecodedEvent | null {
  if (!abi || !log.topic0 || !log.txHash) {
    return null
  }

  try {
    const decoded = decodeEventLog({
      abi,
      data: log.data,
      topics: [log.topic0, ...log.topics.slice(1)] as [Hex, ...Hex[]],
      strict: false,
    })
    const abiItem = getAbiItem({
      abi,
      name: log.topic0,
    })
    const inputs = abiItem?.type === 'event' ? abiItem.inputs ?? [] : []

    const args = Array.isArray(decoded.args)
      ? decoded.args.map((value, index) => ({
          name: `arg${index}`,
          value: stringifyDecodedValue(value),
          indexed: 'indexed' in (inputs[index] ?? {}) && Boolean(inputs[index]?.indexed),
        }))
      : inputs.length > 0
        ? inputs
            .map((input, index) => {
              const key = input.name || `arg${index}`
              const value = decoded.args?.[key as keyof typeof decoded.args]

              if (typeof value === 'undefined') {
                return null
              }

              return {
                name: key,
                value: stringifyDecodedValue(value),
                indexed: 'indexed' in input && Boolean(input.indexed),
              }
            })
            .filter((arg): arg is { name: string; value: string; indexed: boolean } => Boolean(arg))
        : Object.entries(decoded.args ?? {}).map(([name, value]) => ({
            name,
            value: stringifyDecodedValue(value),
            indexed: false,
          }))

    return {
      eventName: decoded.eventName ?? 'unknown',
      signature: makeSignature(decoded.eventName ?? 'unknown', args),
      args,
    }
  } catch {
    return null
  }
}
