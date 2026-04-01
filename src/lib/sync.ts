import { getAddress, type Hex } from 'viem'
import { createLogger } from './logger.ts'
import {
  getChainInfo,
  getBlockByNumber,
  getReceiptByHash,
  type AnvilClient,
} from './rpc.ts'
import {
  getBlock,
  getChainMeta,
  getLatestBlocks,
  pruneFromBlock,
  putChainMeta,
  storeBlockBundle,
} from './db.ts'
import type {
  BlockRecord,
  ChainMeta,
  LogRecord,
  ReceiptRecord,
  RpcBlock,
  RpcReceipt,
  RpcTransaction,
  TransactionRecord,
} from './types.ts'

const logger = createLogger('sync')

export type SyncProgress =
  | { phase: 'connecting'; message: string }
  | { phase: 'syncing'; message: string }
  | { phase: 'ready'; message: string }

export type SyncResult = {
  changed: boolean
  meta: ChainMeta
}

function quantityToNumber(value: Hex | null | undefined) {
  return value ? Number(value) : null
}

function quantityToString(value: Hex | null | undefined) {
  return value ? BigInt(value).toString() : null
}

function normalizeAddress(value: Hex | null | undefined) {
  return value ? getAddress(value) : null
}

export function normalizeBlock(block: RpcBlock): BlockRecord {
  return {
    number: Number(block.number),
    hash: block.hash as Hex,
    parentHash: block.parentHash,
    timestamp: Number(block.timestamp),
    miner: getAddress(block.miner),
    gasLimit: BigInt(block.gasLimit).toString(),
    gasUsed: BigInt(block.gasUsed).toString(),
    baseFeePerGas: quantityToString(block.baseFeePerGas),
    size: quantityToString(block.size),
    transactionCount: block.transactions.length,
  }
}

export function normalizeTransaction(transaction: RpcTransaction): TransactionRecord {
  return {
    hash: transaction.hash,
    blockHash: transaction.blockHash,
    blockNumber: quantityToNumber(transaction.blockNumber),
    transactionIndex: quantityToNumber(transaction.transactionIndex),
    from: getAddress(transaction.from),
    to: normalizeAddress(transaction.to),
    nonce: Number(transaction.nonce),
    type: BigInt(transaction.type).toString(),
    input: transaction.input,
    value: BigInt(transaction.value).toString(),
    gas: BigInt(transaction.gas).toString(),
    gasPrice: quantityToString(transaction.gasPrice),
    maxFeePerGas: quantityToString(transaction.maxFeePerGas),
    maxPriorityFeePerGas: quantityToString(transaction.maxPriorityFeePerGas),
  }
}

function normalizeReceipt(receipt: RpcReceipt): ReceiptRecord {
  return {
    txHash: receipt.transactionHash,
    blockHash: receipt.blockHash,
    blockNumber: quantityToNumber(receipt.blockNumber),
    transactionIndex: quantityToNumber(receipt.transactionIndex),
    contractAddress: normalizeAddress(receipt.contractAddress),
    from: getAddress(receipt.from),
    to: normalizeAddress(receipt.to),
    gasUsed: BigInt(receipt.gasUsed).toString(),
    cumulativeGasUsed: BigInt(receipt.cumulativeGasUsed).toString(),
    effectiveGasPrice: quantityToString(receipt.effectiveGasPrice),
    status: quantityToString(receipt.status),
    type: quantityToString(receipt.type),
  }
}

function normalizeLogs(receipt: RpcReceipt): LogRecord[] {
  return receipt.logs.map((log) => ({
    address: getAddress(log.address),
    blockHash: log.blockHash,
    blockNumber: quantityToNumber(log.blockNumber),
    txHash: log.transactionHash,
    transactionIndex: quantityToNumber(log.transactionIndex),
    logIndex: quantityToNumber(log.logIndex),
    data: log.data,
    topics: log.topics,
    topic0: log.topics[0] ?? null,
    removed: Boolean(log.removed),
  }))
}

async function recoverFromRewind(client: AnvilClient, latestBlockNumber: number, floorBlock: number = 0) {
  const chainMeta = await getChainMeta()

  if (!chainMeta) {
    return false
  }

  if (chainMeta.latestIndexedBlock > latestBlockNumber) {
    await pruneFromBlock(latestBlockNumber + 1)
  }

  const localHeadNumber = Math.min(chainMeta.latestIndexedBlock, latestBlockNumber)
  const localHead = localHeadNumber >= 0 ? await getBlock(localHeadNumber) : undefined

  if (!localHead) {
    return false
  }

  const remoteHead = await getBlockByNumber(client, localHeadNumber)

  if (remoteHead.hash === localHead.hash) {
    return false
  }

  logger.warn('Detected chain rewind, pruning divergent records', {
    localHead: localHead.hash,
    remoteHead: remoteHead.hash,
    localHeadNumber,
  })

  for (let blockNumber = localHeadNumber; blockNumber >= floorBlock; blockNumber -= 1) {
    const [localBlock, remoteBlock] = await Promise.all([
      getBlock(blockNumber),
      getBlockByNumber(client, blockNumber),
    ])

    if (localBlock && localBlock.hash === remoteBlock.hash) {
      await pruneFromBlock(blockNumber + 1)
      return true
    }
  }

  await pruneFromBlock(floorBlock)
  return true
}

async function persistBlock(client: AnvilClient, rpcBlock: RpcBlock) {
  const block = normalizeBlock(rpcBlock)
  const transactions = rpcBlock.transactions.map(normalizeTransaction)
  const receipts = (
    await Promise.all(rpcBlock.transactions.map((transaction) => getReceiptByHash(client, transaction.hash)))
  ).filter((receipt): receipt is RpcReceipt => receipt !== null)

  const normalizedReceipts = receipts.map(normalizeReceipt)
  const logs = receipts.flatMap(normalizeLogs)

  await storeBlockBundle(block, transactions, normalizedReceipts, logs)

  return {
    block,
    transactions,
    receipts: normalizedReceipts,
    logs,
  }
}

export async function syncChain(
  client: AnvilClient,
  rpcUrl: string,
  userStartBlock?: number | null,
  onProgress?: (progress: SyncProgress) => void,
): Promise<SyncResult> {
  onProgress?.({ phase: 'connecting', message: 'Connecting to Anvil' })

  const info = await getChainInfo(client)
  const forkBlock = Math.max(info.forkConfig?.forkBlockNumber ?? 0, userStartBlock ?? 0)
  const changedByRewind = await recoverFromRewind(client, info.latestBlockNumber, forkBlock)
  const previous = await getChainMeta()
  const latestLocalBlock = (await getLatestBlocks(1))[0]
  const startBlock = Math.max(forkBlock, latestLocalBlock?.number ?? (forkBlock - 1)) + 1

  let latestIndexedBlock = startBlock - 1
  let latestIndexedHash: Hex | null = latestLocalBlock?.hash ?? previous?.latestIndexedHash ?? null
  let changed = changedByRewind

  if (startBlock <= info.latestBlockNumber) {
    for (let blockNumber = startBlock; blockNumber <= info.latestBlockNumber; blockNumber += 1) {
      onProgress?.({
        phase: 'syncing',
        message: `Indexing block ${blockNumber} / ${info.latestBlockNumber}`,
      })

      const rpcBlock = await getBlockByNumber(client, blockNumber)
      const persisted = await persistBlock(client, rpcBlock)
      latestIndexedBlock = persisted.block.number
      latestIndexedHash = persisted.block.hash
      changed = true
    }
  } else {
    latestIndexedBlock = latestLocalBlock?.number ?? (forkBlock - 1)
    latestIndexedHash = latestLocalBlock?.hash ?? null
  }

  const meta: ChainMeta = {
    chainId: info.chainId,
    clientVersion: info.clientVersion,
    latestBlockNumber: info.latestBlockNumber,
    latestIndexedBlock,
    latestIndexedHash,
    rpcUrl,
    syncedAt: Date.now(),
    forkConfig: info.forkConfig ?? null,
  }

  await putChainMeta(meta)

  onProgress?.({
    phase: 'ready',
    message: changed ? `Indexed through block ${latestIndexedBlock}` : 'Chain is up to date',
  })

  return {
    changed,
    meta,
  }
}
