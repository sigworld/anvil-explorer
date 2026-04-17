import { decodeFunctionData, getAbiItem, getAddress, isAddress, type Abi, type Hex } from 'viem'
import { isPrecompileAddress } from './address-labels.ts'
import { getAbi } from './db.ts'
import { mergeAbis } from './decode.ts'
import { getProxyImplementation, type AnvilClient } from './rpc.ts'
import type { RawCallTrace, TraceNode } from './types.ts'

function quantityToString(value: Hex | string | null | undefined) {
  if (!value) {
    return null
  }

  try {
    return BigInt(value).toString()
  } catch {
    return null
  }
}

function normalizeTraceAddress(value: Hex | null | undefined) {
  if (!value || !isAddress(value)) {
    return null
  }

  return getAddress(value)
}

function getSelector(input: Hex | undefined) {
  if (!input || input === '0x' || input.length < 10) {
    return null
  }

  return input.slice(0, 10)
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

function decodeTraceFunction(input: Hex, abi: Abi | null | undefined) {
  if (!abi || input === '0x') {
    return null
  }

  try {
    const decoded = decodeFunctionData({
      abi,
      data: input,
    })

    const values = Array.isArray(decoded.args) ? decoded.args : []
    const abiItem = getAbiItem({
      abi,
      name: input.slice(0, 10) as Hex,
      args: values,
    })
    const inputs = abiItem?.type === 'function' ? abiItem.inputs ?? [] : []
    const args = values.map((value, index) => ({
      name: inputs[index]?.name || `arg${index}`,
      value: stringifyDecodedValue(value),
    }))

    return {
      functionName: decoded.functionName,
      signature: `${decoded.functionName}(${args.map((arg) => arg.name).join(', ')})`,
      args,
    }
  } catch {
    return null
  }
}

async function buildAbiMap(trace: RawCallTrace, client?: AnvilClient) {
  const addresses = new Set<Hex>()

  function visit(node: RawCallTrace | undefined) {
    if (!node) {
      return
    }

    const nextAddress = normalizeTraceAddress(node.to)

    if (nextAddress) {
      addresses.add(nextAddress)
    }

    for (const child of node.calls ?? []) {
      visit(child)
    }
  }

  visit(trace)

  const entries = await Promise.all(
    [...addresses].map(async (address) => {
      const stored = (await getAbi(address))?.abi ?? null

      if (client) {
        const implAddr = await getProxyImplementation(client, address).catch(() => null)
        if (implAddr) {
          const implAbi = (await getAbi(implAddr))?.abi ?? null
          return [address, mergeAbis([stored, implAbi])] as const
        }
      }

      return [address, stored] as const
    }),
  )

  return new Map<Hex, Abi | null>(entries)
}

function normalizeNode(
  node: RawCallTrace,
  abiMap: Map<Hex, Abi | null>,
  path: string,
): TraceNode {
  const to = normalizeTraceAddress(node.to)
  const input = node.input ?? '0x'
  const precompile = isPrecompileAddress(to)
  const selector = precompile ? null : getSelector(input)
  const decoded = to && !precompile ? decodeTraceFunction(input, abiMap.get(to)) : null
  const status = node.revertReason
    ? 'reverted'
    : node.error
      ? 'failed'
      : 'success'

  return {
    id: path,
    type: node.type ?? 'CALL',
    from: normalizeTraceAddress(node.from),
    to,
    input,
    output: node.output ?? null,
    value: quantityToString(node.value),
    gas: quantityToString(node.gas),
    gasUsed: quantityToString(node.gasUsed),
    selector,
    functionName: decoded?.functionName ?? null,
    signature: decoded?.signature ?? null,
    args: decoded?.args ?? [],
    error: node.error ?? null,
    revertReason: node.revertReason ?? null,
    status,
    calls: (node.calls ?? []).map((child, index) => normalizeNode(child, abiMap, `${path}.${index}`)),
  }
}

export async function buildTraceTree(trace: unknown, client?: AnvilClient) {
  const root = trace as RawCallTrace | null

  if (!root || typeof root !== 'object') {
    throw new Error('Trace response was empty or invalid')
  }

  const abiMap = await buildAbiMap(root, client)
  return normalizeNode(root, abiMap, '0')
}
