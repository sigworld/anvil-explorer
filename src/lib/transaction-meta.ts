import type { Abi, Hex } from 'viem'
import { getAbi, getBlock, getReceipt } from './db.ts'
import { decodeTransaction, mergeAbis } from './decode.ts'
import { getProxyImplementation, type AnvilClient } from './rpc.ts'
import type { TransactionRecord, TransactionSummary } from './types.ts'

export type AddressActivitySummary = {
  address: TransactionRecord['from']
  count: number
  lastSeenBlock: number | null
}

const KNOWN_SELECTORS: Record<string, { kind: string; method: string }> = {
  '0xa9059cbb': { kind: 'erc20 transfer', method: 'transfer' },
  '0x095ea7b3': { kind: 'erc20 approval', method: 'approve' },
  '0x23b872dd': { kind: 'erc20 transfer', method: 'transferFrom' },
  '0x40c10f19': { kind: 'erc20 mint', method: 'mint' },
  '0x42966c68': { kind: 'erc20 burn', method: 'burn' },
  '0x79cc6790': { kind: 'erc20 burn', method: 'burnFrom' },
}

function getSelector(input: string) {
  return input !== '0x' && input.length >= 10 ? input.slice(0, 10).toLowerCase() : null
}

function getStatus(status: string | null | undefined): TransactionSummary['status'] {
  if (status === '1') {
    return 'success'
  }

  if (status === '0') {
    return 'failed'
  }

  if (typeof status === 'string') {
    return 'pending'
  }

  return 'unknown'
}

function getEnvelope(type: string) {
  switch (type) {
    case '0':
      return 'legacy'
    case '1':
      return 'access list'
    case '2':
      return 'eip-1559'
    case '3':
      return 'blob'
    default:
      return `type-${type}`
  }
}

function classifyKind(transaction: TransactionRecord, method: string | null, selector: string | null) {
  if (!transaction.to) {
    return {
      kind: 'contract deploy',
      method: 'constructor',
    }
  }

  if (transaction.input === '0x') {
    return {
      kind: BigInt(transaction.value) > 0n ? 'native transfer' : 'plain call',
      method: BigInt(transaction.value) > 0n ? 'value transfer' : 'fallback',
    }
  }

  if (method) {
    const lowered = method.toLowerCase()

    if (lowered === 'transfer' || lowered === 'transferfrom') {
      return { kind: 'erc20 transfer', method }
    }

    if (lowered === 'approve') {
      return { kind: 'erc20 approval', method }
    }

    if (lowered.includes('mint')) {
      return { kind: 'erc20 mint', method }
    }

    if (lowered.includes('burn')) {
      return { kind: 'erc20 burn', method }
    }

    return { kind: 'contract call', method }
  }

  if (selector && selector in KNOWN_SELECTORS) {
    return KNOWN_SELECTORS[selector]
  }

  return {
    kind: 'contract call',
    method: selector ?? 'unknown',
  }
}

type ProxyCache = Map<string, Promise<Hex | null>>

function getCachedProxyImpl(client: AnvilClient, address: string, cache: ProxyCache): Promise<Hex | null> {
  const key = address.toLowerCase()
  let pending = cache.get(key)
  if (!pending) {
    pending = getProxyImplementation(client, address as Hex)
    cache.set(key, pending)
  }
  return pending
}

async function buildTransactionSummaryWithTimestamp(
  transaction: TransactionRecord,
  timestamp: number | null,
  client?: AnvilClient,
  proxyCache?: ProxyCache,
): Promise<TransactionSummary> {
  const selector = getSelector(transaction.input)
  const [receipt, abi] = await Promise.all([
    getReceipt(transaction.hash),
    transaction.to ? getAbi(transaction.to) : Promise.resolve(undefined),
  ])

  let implAbi: Abi | undefined
  if (client && transaction.to) {
    const implAddr = proxyCache
      ? await getCachedProxyImpl(client, transaction.to, proxyCache)
      : await getProxyImplementation(client, transaction.to as Hex)
    if (implAddr) {
      implAbi = (await getAbi(implAddr))?.abi
    }
  }

  const effectiveAbi = mergeAbis([abi?.abi, implAbi])
  const decoded = effectiveAbi.length > 0 ? decodeTransaction(transaction, effectiveAbi) : null
  const classified = classifyKind(transaction, decoded?.functionName ?? null, selector)

  return {
    hash: transaction.hash,
    blockNumber: transaction.blockNumber,
    timestamp,
    from: transaction.from,
    to: transaction.to,
    value: transaction.value,
    kind: classified.kind,
    method: decoded?.functionName ?? classified.method,
    status: getStatus(receipt?.status),
    envelope: getEnvelope(transaction.type),
    selector,
    transactionIndex: transaction.transactionIndex,
  }
}

export async function buildTransactionSummary(transaction: TransactionRecord, client?: AnvilClient): Promise<TransactionSummary> {
  const block =
    typeof transaction.blockNumber === 'number' ? await getBlock(transaction.blockNumber) : undefined

  return buildTransactionSummaryWithTimestamp(transaction, block?.timestamp ?? null, client)
}

export async function buildTransactionSummaries(transactions: TransactionRecord[], client?: AnvilClient) {
  const blockNumbers = [...new Set(transactions.map((transaction) => transaction.blockNumber).filter((value): value is number => typeof value === 'number'))]
  const blocks = await Promise.all(blockNumbers.map((blockNumber) => getBlock(blockNumber)))
  const blockTimestampByNumber = new Map(
    blocks
      .filter((block): block is NonNullable<typeof block> => Boolean(block))
      .map((block) => [block.number, block.timestamp] as const),
  )

  const proxyCache: ProxyCache = new Map()

  return Promise.all(
    transactions.map(async (transaction) => {
      const timestamp =
        typeof transaction.blockNumber === 'number'
          ? blockTimestampByNumber.get(transaction.blockNumber) ?? null
          : null

      return buildTransactionSummaryWithTimestamp(transaction, timestamp, client, proxyCache)
    }),
  )
}

function sortTransactionSummariesNewestFirst(left: TransactionSummary, right: TransactionSummary) {
  const blockDelta = (right.blockNumber ?? -1) - (left.blockNumber ?? -1)

  if (blockDelta !== 0) {
    return blockDelta
  }

  const indexDelta = (right.transactionIndex ?? -1) - (left.transactionIndex ?? -1)

  if (indexDelta !== 0) {
    return indexDelta
  }

  return (right.timestamp ?? -1) - (left.timestamp ?? -1)
}

export async function buildFailedTransactionSummaries(transactions: TransactionRecord[], limit = 8) {
  const summaries = await buildTransactionSummaries(transactions)

  return summaries
    .filter((transaction) => transaction.status === 'failed')
    .sort(sortTransactionSummariesNewestFirst)
    .slice(0, limit)
}

export function buildAddressActivitySummaries(
  transactions: TransactionRecord[],
  field: 'from' | 'to',
): AddressActivitySummary[] {
  const activity = new Map<string, AddressActivitySummary>()

  for (const transaction of transactions) {
    const address = field === 'from' ? transaction.from : transaction.to

    if (!address) {
      continue
    }

    const current = activity.get(address)

    if (!current) {
      activity.set(address, {
        address,
        count: 1,
        lastSeenBlock: transaction.blockNumber,
      })
      continue
    }

    current.count += 1

    if (
      typeof transaction.blockNumber === 'number' &&
      (current.lastSeenBlock === null || transaction.blockNumber > current.lastSeenBlock)
    ) {
      current.lastSeenBlock = transaction.blockNumber
    }
  }

  return [...activity.values()].sort((left, right) => {
    const countDelta = right.count - left.count

    if (countDelta !== 0) {
      return countDelta
    }

    const blockDelta = (right.lastSeenBlock ?? -1) - (left.lastSeenBlock ?? -1)

    if (blockDelta !== 0) {
      return blockDelta
    }

    return left.address.localeCompare(right.address)
  })
}
