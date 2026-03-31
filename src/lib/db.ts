import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { getAddress, type Hex } from 'viem'
import { getDefaultAddressLabel } from './address-labels.ts'
import type {
  AccountInsightRelation,
  AbiRecord,
  AddressLabelRecord,
  BlockRecord,
  ChainMeta,
  DiscoveredAccount,
  DiscoveredContract,
  ExplorerStats,
  LogRecord,
  MetaRecord,
  ReceiptRecord,
  TransactionRecord,
} from './types.ts'

const DB_NAME = 'anvil-explorer'
const DB_VERSION = 2
const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

interface ExplorerDbSchema extends DBSchema {
  abis: {
    key: string
    value: AbiRecord
  }
  blocks: {
    key: number
    value: BlockRecord
    indexes: {
      hash: string
      timestamp: number
    }
  }
  labels: {
    key: string
    value: AddressLabelRecord
  }
  logs: {
    key: number
    value: LogRecord
    indexes: {
      address: string
      blockNumber: number
      topic0: string
      txHash: string
    }
  }
  meta: {
    key: string
    value: MetaRecord
  }
  receipts: {
    key: string
    value: ReceiptRecord
    indexes: {
      blockNumber: number
      contractAddress: string
    }
  }
  transactions: {
    key: string
    value: TransactionRecord
    indexes: {
      blockNumber: number
      from: string
      to: string
    }
  }
}

let dbPromise: Promise<IDBPDatabase<ExplorerDbSchema>> | undefined

async function collectFromCursor<T>(request: Promise<any>, limit: number) {
  const values: T[] = []
  let cursor = await request

  while (cursor && values.length < limit) {
    values.push(cursor.value as T)
    cursor = await cursor.continue()
  }

  return values
}

export async function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<ExplorerDbSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('blocks')) {
          const blocks = db.createObjectStore('blocks', { keyPath: 'number' })
          blocks.createIndex('hash', 'hash', { unique: true })
          blocks.createIndex('timestamp', 'timestamp')
        }

        if (!db.objectStoreNames.contains('transactions')) {
          const transactions = db.createObjectStore('transactions', { keyPath: 'hash' })
          transactions.createIndex('from', 'from')
          transactions.createIndex('to', 'to')
          transactions.createIndex('blockNumber', 'blockNumber')
        }

        if (!db.objectStoreNames.contains('receipts')) {
          const receipts = db.createObjectStore('receipts', { keyPath: 'txHash' })
          receipts.createIndex('contractAddress', 'contractAddress')
          receipts.createIndex('blockNumber', 'blockNumber')
        }

        if (!db.objectStoreNames.contains('logs')) {
          const logs = db.createObjectStore('logs', {
            keyPath: 'id',
            autoIncrement: true,
          })
          logs.createIndex('address', 'address')
          logs.createIndex('topic0', 'topic0')
          logs.createIndex('blockNumber', 'blockNumber')
          logs.createIndex('txHash', 'txHash')
        }

        if (!db.objectStoreNames.contains('abis')) {
          db.createObjectStore('abis', { keyPath: 'address' })
        }

        if (!db.objectStoreNames.contains('labels')) {
          db.createObjectStore('labels', { keyPath: 'address' })
        }

        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' })
        }
      },
    })
  }

  return dbPromise
}

export async function putMeta(key: string, value: unknown) {
  const db = await getDb()
  await db.put('meta', { key, value })
}

export async function getMeta<T>(key: string) {
  const db = await getDb()
  const record = await db.get('meta', key)
  return (record?.value as T | undefined) ?? undefined
}

export async function putChainMeta(meta: ChainMeta) {
  await putMeta('chainMeta', meta)
}

export async function getChainMeta() {
  return getMeta<ChainMeta>('chainMeta')
}

export async function clearChainMeta() {
  const db = await getDb()
  await db.delete('meta', 'chainMeta')
}

export async function storeBlockBundle(
  block: BlockRecord,
  transactions: TransactionRecord[],
  receipts: ReceiptRecord[],
  logs: LogRecord[],
) {
  const db = await getDb()
  const tx = db.transaction(['blocks', 'transactions', 'receipts', 'logs'], 'readwrite')

  await tx.objectStore('blocks').put(block)

  for (const transaction of transactions) {
    await tx.objectStore('transactions').put(transaction)
  }

  for (const receipt of receipts) {
    await tx.objectStore('receipts').put(receipt)
  }

  for (const log of logs) {
    await tx.objectStore('logs').put(log)
  }

  await tx.done
}

export async function pruneFromBlock(startBlock: number) {
  const db = await getDb()
  const tx = db.transaction(['blocks', 'transactions', 'receipts', 'logs'], 'readwrite')
  const lowerBound = IDBKeyRange.lowerBound(startBlock)

  let blockCursor = await tx.objectStore('blocks').openCursor(lowerBound)
  while (blockCursor) {
    await blockCursor.delete()
    blockCursor = await blockCursor.continue()
  }

  let transactionCursor = await tx.objectStore('transactions').index('blockNumber').openCursor(lowerBound)
  while (transactionCursor) {
    const hash = transactionCursor.primaryKey as string
    await tx.objectStore('receipts').delete(hash)
    await transactionCursor.delete()
    transactionCursor = await transactionCursor.continue()
  }

  let logCursor = await tx.objectStore('logs').index('blockNumber').openCursor(lowerBound)
  while (logCursor) {
    await logCursor.delete()
    logCursor = await logCursor.continue()
  }

  await tx.done
}

export async function getLatestBlocks(limit: number) {
  const db = await getDb()
  return collectFromCursor<BlockRecord>(db.transaction('blocks').store.openCursor(null, 'prev'), limit)
}

export async function getBlock(number: number) {
  const db = await getDb()
  return db.get('blocks', number)
}

export async function getBlockByHash(hash: string) {
  const db = await getDb()
  return db.getFromIndex('blocks', 'hash', hash)
}

export async function getTransaction(hash: string) {
  const db = await getDb()
  return db.get('transactions', hash)
}

export async function getTransactionsByBlock(blockNumber: number) {
  const db = await getDb()
  return db.getAllFromIndex('transactions', 'blockNumber', blockNumber)
}

export async function getTransactionsForAddress(address: string, limit = 50) {
  const db = await getDb()
  const [sent, received] = await Promise.all([
    collectFromCursor<TransactionRecord>(
      db.transaction('transactions').store.index('from').openCursor(address, 'prev'),
      limit,
    ),
    collectFromCursor<TransactionRecord>(
      db.transaction('transactions').store.index('to').openCursor(address, 'prev'),
      limit,
    ),
  ])

  const combined = [...sent, ...received]
  const deduped = new Map(combined.map((item) => [item.hash, item]))
  return [...deduped.values()]
    .sort((left, right) => (right.blockNumber ?? -1) - (left.blockNumber ?? -1))
    .slice(0, limit)
}

export async function getTransactionsForAccountInvolvement(address: string, limit = 50) {
  const db = await getDb()
  const [directTransactions, transferLogs] = await Promise.all([
    getTransactionsForAddress(address, limit),
    db.getAllFromIndex('logs', 'topic0', ERC20_TRANSFER_TOPIC),
  ])

  const involvedTxHashes = new Set<string>(directTransactions.map((transaction) => transaction.hash))

  for (const log of transferLogs) {
    const fromAddress = topicToAddress(log.topics[1])
    const toAddress = topicToAddress(log.topics[2])

    if (fromAddress !== address && toAddress !== address) {
      continue
    }

    if (log.txHash) {
      involvedTxHashes.add(log.txHash)
    }
  }

  const fetchedTransactions = await Promise.all(
    [...involvedTxHashes].map(async (hash) => db.get('transactions', hash)),
  )

  return fetchedTransactions
    .filter((transaction): transaction is TransactionRecord => transaction !== undefined)
    .sort((left, right) => {
      const blockDelta = (right.blockNumber ?? -1) - (left.blockNumber ?? -1)
      if (blockDelta !== 0) {
        return blockDelta
      }

      return (right.transactionIndex ?? -1) - (left.transactionIndex ?? -1)
    })
    .slice(0, limit)
}

export async function getLatestTransactions(limit: number) {
  const db = await getDb()
  return collectFromCursor<TransactionRecord>(
    db.transaction('transactions').store.index('blockNumber').openCursor(null, 'prev'),
    limit,
  )
}

export async function getTransactionsInLatestBlockWindow(blockCount: number, limit = Number.MAX_SAFE_INTEGER) {
  if (blockCount <= 0 || limit <= 0) {
    return []
  }

  const recentBlocks = await getLatestBlocks(blockCount)

  if (recentBlocks.length === 0) {
    return []
  }

  const highestBlock = recentBlocks[0].number
  const lowestBlock = recentBlocks[recentBlocks.length - 1].number
  const db = await getDb()

  return collectFromCursor<TransactionRecord>(
    db.transaction('transactions').store.index('blockNumber').openCursor(IDBKeyRange.bound(lowestBlock, highestBlock), 'prev'),
    limit,
  )
}

export async function getReceipt(txHash: string) {
  const db = await getDb()
  return db.get('receipts', txHash)
}

export async function getLogsByTxHash(txHash: string) {
  const db = await getDb()
  return db.getAllFromIndex('logs', 'txHash', txHash)
}

export async function getRecentLogs(limit: number) {
  const db = await getDb()
  return collectFromCursor<LogRecord>(db.transaction('logs').store.index('blockNumber').openCursor(null, 'prev'), limit)
}

export async function getLogsForAddress(address: string, limit = 100) {
  const db = await getDb()
  return collectFromCursor<LogRecord>(
    db.transaction('logs').store.index('address').openCursor(address, 'prev'),
    limit,
  )
}

function topicToAddress(topic: Hex | undefined) {
  if (!topic || topic.length !== 66) {
    return null
  }

  return getAddress(`0x${topic.slice(-40)}`)
}

export async function getDiscoveredErc20ContractsForAddress(address: string) {
  const db = await getDb()
  const transferLogs = await db.getAllFromIndex('logs', 'topic0', ERC20_TRANSFER_TOPIC)
  const discovered = new Map<string, number | null>()

  for (const log of transferLogs) {
    const fromAddress = topicToAddress(log.topics[1])
    const toAddress = topicToAddress(log.topics[2])

    if (fromAddress !== address && toAddress !== address) {
      continue
    }

    const previous = discovered.get(log.address)
    if (typeof previous === 'number' && typeof log.blockNumber === 'number' && previous >= log.blockNumber) {
      continue
    }

    discovered.set(log.address, log.blockNumber)
  }

  return [...discovered.entries()]
    .map(([tokenAddress, lastUpdatedBlock]) => ({
      tokenAddress: tokenAddress as Hex,
      lastUpdatedBlock,
    }))
    .sort((left, right) => (right.lastUpdatedBlock ?? -1) - (left.lastUpdatedBlock ?? -1))
}

export async function getDiscoveredHoldersForErc20Contract(tokenAddress: string) {
  const db = await getDb()
  const emittedLogs = await db.getAllFromIndex('logs', 'address', tokenAddress)
  const holders = new Map<string, number | null>()

  for (const log of emittedLogs) {
    if (log.topic0 !== ERC20_TRANSFER_TOPIC) {
      continue
    }

    const fromAddress = topicToAddress(log.topics[1])
    const toAddress = topicToAddress(log.topics[2])

    for (const candidate of [fromAddress, toAddress]) {
      if (!candidate || candidate === '0x0000000000000000000000000000000000000000') {
        continue
      }

      const previous = holders.get(candidate)
      if (typeof previous === 'number' && typeof log.blockNumber === 'number' && previous >= log.blockNumber) {
        continue
      }

      holders.set(candidate, log.blockNumber)
    }
  }

  return [...holders.entries()]
    .map(([holderAddress, lastUpdatedBlock]) => ({
      holderAddress: holderAddress as Hex,
      lastUpdatedBlock,
    }))
    .sort((left, right) => (right.lastUpdatedBlock ?? -1) - (left.lastUpdatedBlock ?? -1))
}

export async function getDiscoveredContracts(limit = 200): Promise<DiscoveredContract[]> {
  const db = await getDb()
  const [transactions, receipts, logs, abis, blocks] = await Promise.all([
    db.getAll('transactions'),
    db.getAll('receipts'),
    db.getAll('logs'),
    db.getAll('abis'),
    db.getAll('blocks'),
  ])
  const transactionByHash = new Map(transactions.map((transaction) => [transaction.hash, transaction] as const))
  const blockByNumber = new Map(blocks.map((block) => [block.number, block] as const))

  const discovered = new Map<
    string,
    {
      address: Hex
      lastSeenBlock: number | null
      lastSeenTimestamp: number | null
      callCount: number
      logCount: number
      deployerAddress: Hex | null
      deploymentTxHash: Hex | null
      deploymentBlockNumber: number | null
      deploymentTimestamp: number | null
      deploymentInput: Hex | null
      deploymentGasUsed: string | null
      deploymentGasPrice: string | null
      sources: Set<string>
    }
  >()

  function ensure(address: Hex) {
    const current = discovered.get(address)
    if (current) {
      return current
    }

    const next = {
      address,
      lastSeenBlock: null,
      lastSeenTimestamp: null,
      callCount: 0,
      logCount: 0,
      deployerAddress: null,
      deploymentTxHash: null,
      deploymentBlockNumber: null,
      deploymentTimestamp: null,
      deploymentInput: null,
      deploymentGasUsed: null,
      deploymentGasPrice: null,
      sources: new Set<string>(),
    }
    discovered.set(address, next)
    return next
  }

  function markSeen(address: Hex, blockNumber: number | null, source: string) {
    const current = ensure(address)
    current.sources.add(source)

    if (typeof blockNumber === 'number' && (current.lastSeenBlock === null || blockNumber > current.lastSeenBlock)) {
      current.lastSeenBlock = blockNumber
      current.lastSeenTimestamp = blockByNumber.get(blockNumber)?.timestamp ?? null
    }
  }

  for (const transaction of transactions) {
    if (!transaction.to) {
      continue
    }

    const current = ensure(transaction.to)
    current.callCount += 1
    markSeen(transaction.to, transaction.blockNumber, 'called')
  }

  for (const receipt of receipts) {
    if (!receipt.contractAddress) {
      continue
    }

    const current = ensure(receipt.contractAddress)
    const transaction = transactionByHash.get(receipt.txHash)
    const deploymentBlockNumber = receipt.blockNumber ?? transaction?.blockNumber ?? null
    const shouldReplaceDeployment =
      current.deploymentBlockNumber === null ||
      (typeof deploymentBlockNumber === 'number' && deploymentBlockNumber >= current.deploymentBlockNumber)

    markSeen(receipt.contractAddress, deploymentBlockNumber, 'deployed')

    if (shouldReplaceDeployment) {
      current.deployerAddress = transaction?.from ?? receipt.from
      current.deploymentTxHash = receipt.txHash
      current.deploymentBlockNumber = deploymentBlockNumber
      current.deploymentTimestamp =
        typeof deploymentBlockNumber === 'number'
          ? (blockByNumber.get(deploymentBlockNumber)?.timestamp ?? null)
          : null
      current.deploymentInput = transaction?.input ?? null
      current.deploymentGasUsed = receipt.gasUsed
      current.deploymentGasPrice = receipt.effectiveGasPrice ?? transaction?.gasPrice ?? null
    }
  }

  for (const log of logs) {
    const current = ensure(log.address)
    current.logCount += 1
    markSeen(log.address, log.blockNumber, log.topic0 === ERC20_TRANSFER_TOPIC ? 'erc20-logs' : 'logs')
  }

  for (const abi of abis) {
    markSeen(abi.address, null, 'abi')
  }

  return [...discovered.values()]
    .map((item) => ({
      address: item.address,
      lastSeenBlock: item.lastSeenBlock,
      lastSeenTimestamp: item.lastSeenTimestamp,
      callCount: item.callCount,
      logCount: item.logCount,
      deployerAddress: item.deployerAddress,
      deploymentTxHash: item.deploymentTxHash,
      deploymentBlockNumber: item.deploymentBlockNumber,
      deploymentTimestamp: item.deploymentTimestamp,
      deploymentInput: item.deploymentInput,
      deploymentGasUsed: item.deploymentGasUsed,
      deploymentGasPrice: item.deploymentGasPrice,
      sources: [...item.sources].sort(),
    }))
    .sort((left, right) => {
      const blockDelta = (right.lastSeenBlock ?? -1) - (left.lastSeenBlock ?? -1)
      if (blockDelta !== 0) {
        return blockDelta
      }

      const callDelta = right.callCount - left.callCount
      if (callDelta !== 0) {
        return callDelta
      }

      return right.logCount - left.logCount
    })
    .slice(0, limit)
}

export async function getDiscoveredAccounts(limit = Number.MAX_SAFE_INTEGER): Promise<DiscoveredAccount[]> {
  const db = await getDb()
  const [transactions, logs] = await Promise.all([db.getAll('transactions'), db.getAll('logs')])
  const discovered = new Map<
    string,
    {
      address: Hex
      firstSeenBlock: number | null
      lastSeenBlock: number | null
      transactionCount: number
      involvedTxHashes: Set<string>
    }
  >()

  function ensure(address: Hex) {
    const current = discovered.get(address)

    if (current) {
      return current
    }

    const next = {
      address,
      firstSeenBlock: null,
      lastSeenBlock: null,
      transactionCount: 0,
      involvedTxHashes: new Set<string>(),
    }
    discovered.set(address, next)
    return next
  }

  function markSeen(address: Hex, blockNumber: number | null) {
    const current = ensure(address)

    if (typeof blockNumber === 'number' && (current.firstSeenBlock === null || blockNumber < current.firstSeenBlock)) {
      current.firstSeenBlock = blockNumber
    }

    if (typeof blockNumber === 'number' && (current.lastSeenBlock === null || blockNumber > current.lastSeenBlock)) {
      current.lastSeenBlock = blockNumber
    }

    return current
  }

  for (const transaction of transactions) {
    const fromAccount = markSeen(transaction.from, transaction.blockNumber)
    fromAccount.involvedTxHashes.add(transaction.hash)

    if (transaction.to && transaction.to !== transaction.from) {
      const toAccount = markSeen(transaction.to, transaction.blockNumber)
      toAccount.involvedTxHashes.add(transaction.hash)
    }
  }

  for (const log of logs) {
    if (log.topic0 !== ERC20_TRANSFER_TOPIC) {
      continue
    }

    const fromAddress = topicToAddress(log.topics[1])
    const toAddress = topicToAddress(log.topics[2])

    for (const accountAddress of [fromAddress, toAddress]) {
      if (!accountAddress || accountAddress === '0x0000000000000000000000000000000000000000') {
        continue
      }

      const account = markSeen(accountAddress, log.blockNumber)

      if (log.txHash) {
        account.involvedTxHashes.add(log.txHash)
      }
    }
  }

  return [...discovered.values()]
    .map((item) => ({
      address: item.address,
      firstSeenBlock: item.firstSeenBlock,
      lastSeenBlock: item.lastSeenBlock,
      transactionCount: item.involvedTxHashes.size,
    }))
    .sort((left, right) => {
      const txDelta = right.transactionCount - left.transactionCount
      if (txDelta !== 0) {
        return txDelta
      }

      return (right.lastSeenBlock ?? -1) - (left.lastSeenBlock ?? -1)
    })
    .slice(0, limit)
}

type AccountInsightAccumulator = {
  address: Hex
  lastSeenBlock: number | null
  txHashes: Set<string>
  invocationInCount: number
  invocationOutCount: number
  nativeInCount: number
  nativeOutCount: number
  nativeInValue: bigint
  nativeOutValue: bigint
  tokenInCount: number
  tokenOutCount: number
  creationInCount: number
  creationOutCount: number
  tokenAddresses: Set<Hex>
  sampleTxHash: Hex | null
}

function getInsightStrength(score: number, evidenceCount: number): AccountInsightRelation['strength'] {
  if (score >= 6 || (score >= 4 && evidenceCount >= 2)) {
    return 'strong'
  }

  if (score >= 3) {
    return 'moderate'
  }

  return 'loose'
}

function getInsightPriority(kind: AccountInsightRelation['kind']) {
  switch (kind) {
    case 'creation':
      return 0
    case 'value-flow':
      return 1
    case 'invocation':
      return 2
  }
}

export async function getAccountInsight(address: string, limit = 8): Promise<AccountInsightRelation[]> {
  const db = await getDb()
  const [transactions, logs, receipts] = await Promise.all([
    db.getAll('transactions'),
    db.getAll('logs'),
    db.getAll('receipts'),
  ])
  const relations = new Map<string, AccountInsightAccumulator>()

  function ensure(counterparty: Hex) {
    const current = relations.get(counterparty)

    if (current) {
      return current
    }

    const next: AccountInsightAccumulator = {
      address: counterparty,
      lastSeenBlock: null,
      txHashes: new Set<string>(),
      invocationInCount: 0,
      invocationOutCount: 0,
      nativeInCount: 0,
      nativeOutCount: 0,
      nativeInValue: 0n,
      nativeOutValue: 0n,
      tokenInCount: 0,
      tokenOutCount: 0,
      creationInCount: 0,
      creationOutCount: 0,
      tokenAddresses: new Set<Hex>(),
      sampleTxHash: null,
    }
    relations.set(counterparty, next)
    return next
  }

  function markSeen(current: AccountInsightAccumulator, blockNumber: number | null, txHash?: Hex | null) {
    if (typeof blockNumber === 'number' && (current.lastSeenBlock === null || blockNumber > current.lastSeenBlock)) {
      current.lastSeenBlock = blockNumber
    }

    if (txHash) {
      current.txHashes.add(txHash)

      if (!current.sampleTxHash) {
        current.sampleTxHash = txHash
      }
    }
  }

  for (const transaction of transactions) {
    if (transaction.from === address && transaction.to && transaction.to !== address) {
      const relation = ensure(transaction.to)
      markSeen(relation, transaction.blockNumber, transaction.hash)

      if (transaction.input !== '0x') {
        relation.invocationOutCount += 1
      }

      if (BigInt(transaction.value) > 0n) {
        relation.nativeOutCount += 1
        relation.nativeOutValue += BigInt(transaction.value)
      }

      continue
    }

    if (transaction.to === address && transaction.from !== address) {
      const relation = ensure(transaction.from)
      markSeen(relation, transaction.blockNumber, transaction.hash)

      if (transaction.input !== '0x') {
        relation.invocationInCount += 1
      }

      if (BigInt(transaction.value) > 0n) {
        relation.nativeInCount += 1
        relation.nativeInValue += BigInt(transaction.value)
      }
    }
  }

  for (const log of logs) {
    if (log.topic0 !== ERC20_TRANSFER_TOPIC) {
      continue
    }

    const fromAddress = topicToAddress(log.topics[1])
    const toAddress = topicToAddress(log.topics[2])

    if (fromAddress === address && toAddress && toAddress !== address && toAddress !== ZERO_ADDRESS) {
      const relation = ensure(toAddress)
      relation.tokenOutCount += 1
      relation.tokenAddresses.add(log.address)
      markSeen(relation, log.blockNumber, log.txHash)
      continue
    }

    if (toAddress === address && fromAddress && fromAddress !== address && fromAddress !== ZERO_ADDRESS) {
      const relation = ensure(fromAddress)
      relation.tokenInCount += 1
      relation.tokenAddresses.add(log.address)
      markSeen(relation, log.blockNumber, log.txHash)
    }
  }

  for (const receipt of receipts) {
    if (!receipt.contractAddress || receipt.contractAddress === ZERO_ADDRESS) {
      continue
    }

    if (receipt.from === address && receipt.contractAddress !== address) {
      const relation = ensure(receipt.contractAddress)
      relation.creationOutCount += 1
      markSeen(relation, receipt.blockNumber, receipt.txHash)
      continue
    }

    if (receipt.contractAddress === address && receipt.from !== address) {
      const relation = ensure(receipt.from)
      relation.creationInCount += 1
      markSeen(relation, receipt.blockNumber, receipt.txHash)
    }
  }

  return [...relations.values()]
    .map((relation) => {
      const supportingEvidence: string[] = []
      const hasCreation = relation.creationInCount > 0 || relation.creationOutCount > 0
      const hasValueFlow =
        relation.nativeInCount > 0 ||
        relation.nativeOutCount > 0 ||
        relation.tokenInCount > 0 ||
        relation.tokenOutCount > 0
      const hasInvocation = relation.invocationInCount > 0 || relation.invocationOutCount > 0

      if (hasCreation) {
        supportingEvidence.push('contract creation')
      }

      if (relation.nativeInCount > 0 || relation.nativeOutCount > 0) {
        supportingEvidence.push('native value flow')
      }

      if (relation.tokenInCount > 0 || relation.tokenOutCount > 0) {
        supportingEvidence.push('erc20 transfers')
      }

      if (hasInvocation) {
        supportingEvidence.push('direct calls')
      }

      let kind: AccountInsightRelation['kind']
      let label: string

      if (hasCreation) {
        kind = 'creation'
        label = relation.creationOutCount > 0 && relation.creationInCount === 0
          ? 'created'
          : relation.creationInCount > 0 && relation.creationOutCount === 0
            ? 'created by'
            : 'shares origin with'
      } else if (hasValueFlow) {
        kind = 'value-flow'
        label = relation.nativeOutCount + relation.tokenOutCount > 0 && relation.nativeInCount + relation.tokenInCount === 0
          ? 'funds'
          : relation.nativeInCount + relation.tokenInCount > 0 && relation.nativeOutCount + relation.tokenOutCount === 0
            ? 'funded by'
            : 'moves value with'
      } else {
        kind = 'invocation'
        label = relation.invocationOutCount > 0 && relation.invocationInCount === 0
          ? 'uses'
          : relation.invocationInCount > 0 && relation.invocationOutCount === 0
            ? 'used by'
            : 'interacts with'
      }

      const score =
        relation.creationInCount * 4 +
        relation.creationOutCount * 4 +
        relation.nativeInCount +
        relation.nativeOutCount +
        relation.tokenInCount +
        relation.tokenOutCount +
        relation.invocationInCount +
        relation.invocationOutCount +
        relation.tokenAddresses.size

      return {
        address: relation.address,
        kind,
        label,
        strength: getInsightStrength(score, supportingEvidence.length),
        score,
        lastSeenBlock: relation.lastSeenBlock,
        transactionCount: relation.txHashes.size,
        invocationInCount: relation.invocationInCount,
        invocationOutCount: relation.invocationOutCount,
        nativeInCount: relation.nativeInCount,
        nativeOutCount: relation.nativeOutCount,
        nativeInValue: relation.nativeInValue.toString(),
        nativeOutValue: relation.nativeOutValue.toString(),
        tokenInCount: relation.tokenInCount,
        tokenOutCount: relation.tokenOutCount,
        creationInCount: relation.creationInCount,
        creationOutCount: relation.creationOutCount,
        supportingEvidence,
        tokenAddresses: [...relation.tokenAddresses],
        sampleTxHash: relation.sampleTxHash,
      }
    })
    .sort((left, right) => {
      const priorityDelta = getInsightPriority(left.kind) - getInsightPriority(right.kind)

      if (priorityDelta !== 0) {
        return priorityDelta
      }

      const scoreDelta = right.score - left.score

      if (scoreDelta !== 0) {
        return scoreDelta
      }

      return (right.lastSeenBlock ?? -1) - (left.lastSeenBlock ?? -1)
    })
    .slice(0, limit)
}

export async function getAbi(address: string) {
  const db = await getDb()
  return db.get('abis', address)
}

export async function listAbis() {
  const db = await getDb()
  return db.getAll('abis')
}

export async function upsertAbi(record: AbiRecord) {
  const db = await getDb()
  await db.put('abis', record)
}

export async function deleteAbi(address: string) {
  const db = await getDb()
  await db.delete('abis', address)
}

export async function getAddressLabel(address: string) {
  const db = await getDb()
  return db.get('labels', address)
}

export async function upsertAddressLabel(address: string, label: string) {
  const db = await getDb()
  await db.put('labels', {
    address: getAddress(address),
    label,
    updatedAt: Date.now(),
  })
}

export async function deleteAddressLabel(address: string) {
  const db = await getDb()
  await db.delete('labels', address)
}

export async function getResolvedAddressLabel(address: string | null | undefined) {
  if (!address) {
    return null
  }

  const manual = await getAddressLabel(address)
  return manual?.label ?? getDefaultAddressLabel(address)
}

export async function getExplorerStats(): Promise<ExplorerStats> {
  const db = await getDb()
  const [blockCount, transactionCount, logCount, latestBlock] = await Promise.all([
    db.count('blocks'),
    db.count('transactions'),
    db.count('logs'),
    getLatestBlocks(1),
  ])

  return {
    blockCount,
    transactionCount,
    logCount,
    latestBlockNumber: latestBlock[0]?.number ?? null,
  }
}

export async function resetExplorerData() {
  const db = await getDb()
  await Promise.all([
    db.clear('blocks'),
    db.clear('transactions'),
    db.clear('receipts'),
    db.clear('logs'),
    db.clear('abis'),
    db.clear('labels'),
    db.clear('meta'),
  ])
}
