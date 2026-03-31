import type { Abi, Hex } from 'viem'

export type ExplorerStatus = 'idle' | 'connecting' | 'syncing' | 'ready' | 'error'

export type RpcBlock = {
  baseFeePerGas?: Hex | null
  gasLimit: Hex
  gasUsed: Hex
  hash: Hex | null
  miner: Hex
  number: Hex | null
  parentHash: Hex
  size?: Hex
  timestamp: Hex
  transactions: RpcTransaction[]
}

export type RpcTransaction = {
  blockHash: Hex | null
  blockNumber: Hex | null
  from: Hex
  gas: Hex
  gasPrice: Hex | null
  hash: Hex
  input: Hex
  maxFeePerGas?: Hex | null
  maxPriorityFeePerGas?: Hex | null
  nonce: Hex
  to: Hex | null
  transactionIndex: Hex | null
  type: Hex
  value: Hex
}

export type RpcReceipt = {
  blockHash: Hex | null
  blockNumber: Hex | null
  contractAddress: Hex | null
  cumulativeGasUsed: Hex
  effectiveGasPrice?: Hex | null
  from: Hex
  gasUsed: Hex
  logs: RpcLog[]
  status: Hex | null
  to: Hex | null
  transactionHash: Hex
  transactionIndex: Hex | null
  type?: Hex | null
}

export type RpcLog = {
  address: Hex
  blockHash: Hex | null
  blockNumber: Hex | null
  data: Hex
  logIndex: Hex | null
  removed?: boolean
  topics: Hex[]
  transactionHash: Hex | null
  transactionIndex: Hex | null
}

export type BlockRecord = {
  number: number
  hash: Hex
  parentHash: Hex
  timestamp: number
  miner: Hex
  gasLimit: string
  gasUsed: string
  baseFeePerGas: string | null
  size: string | null
  transactionCount: number
}

export type TransactionRecord = {
  hash: Hex
  blockHash: Hex | null
  blockNumber: number | null
  transactionIndex: number | null
  from: Hex
  to: Hex | null
  nonce: number
  type: string
  input: Hex
  value: string
  gas: string
  gasPrice: string | null
  maxFeePerGas: string | null
  maxPriorityFeePerGas: string | null
}

export type ReceiptRecord = {
  txHash: Hex
  blockHash: Hex | null
  blockNumber: number | null
  transactionIndex: number | null
  contractAddress: Hex | null
  from: Hex
  to: Hex | null
  gasUsed: string
  cumulativeGasUsed: string
  effectiveGasPrice: string | null
  status: string | null
  type: string | null
}

export type LogRecord = {
  id?: number
  address: Hex
  blockHash: Hex | null
  blockNumber: number | null
  txHash: Hex | null
  transactionIndex: number | null
  logIndex: number | null
  data: Hex
  topics: Hex[]
  topic0: Hex | null
  removed: boolean
}

export type AbiRecord = {
  address: Hex
  abi: Abi
  source: string
  updatedAt: number
}

export type AddressLabelRecord = {
  address: Hex
  label: string
  updatedAt: number
}

export type MetaRecord = {
  key: string
  value: unknown
}

export type ChainMeta = {
  chainId: number
  clientVersion: string
  latestBlockNumber: number
  latestIndexedBlock: number
  latestIndexedHash: Hex | null
  rpcUrl: string
  syncedAt: number
}

export type ExplorerStats = {
  blockCount: number
  transactionCount: number
  logCount: number
  latestBlockNumber: number | null
}

export type AddressKind = 'wallet' | 'contract'

export type TokenBalance = {
  tokenAddress: Hex
  balance: string
  decimals: number
  symbol: string | null
  name: string | null
  lastUpdatedBlock: number | null
}

export type TokenHolderBalance = {
  holderAddress: Hex
  balance: string
  lastUpdatedBlock: number | null
}

export type Erc20TokenInfo = {
  tokenAddress: Hex
  decimals: number
  symbol: string | null
  name: string | null
  totalSupply: string
}

export type TransactionSummary = {
  hash: Hex
  blockNumber: number | null
  timestamp: number | null
  from: Hex
  to: Hex | null
  value: string
  kind: string
  method: string
  status: 'success' | 'failed' | 'pending' | 'unknown'
  envelope: string
  selector: string | null
  transactionIndex: number | null
}

export type TransactionFailure = {
  message: string
  rawData: Hex | null
  errorName: string | null
  signature: string | null
  args: Array<{ name: string; value: string }>
  replayBlockNumber: number | null
}

export type TokenBalanceEffect = {
  tokenAddress: Hex
  holderAddress: Hex
  decimals: number
  symbol: string | null
  name: string | null
  beforeBalance: string | null
  afterBalance: string | null
  delta: string
  blockNumber: number | null
}

export type DiscoveredContract = {
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
  sources: string[]
}

export type DiscoveredAccount = {
  address: Hex
  firstSeenBlock: number | null
  lastSeenBlock: number | null
  transactionCount: number
}

export type AccountInsightRelationKind = 'creation' | 'value-flow' | 'invocation'

export type AccountInsightRelationStrength = 'strong' | 'moderate' | 'loose'

export type AccountInsightRelation = {
  address: Hex
  kind: AccountInsightRelationKind
  label: string
  strength: AccountInsightRelationStrength
  score: number
  lastSeenBlock: number | null
  transactionCount: number
  invocationInCount: number
  invocationOutCount: number
  nativeInCount: number
  nativeOutCount: number
  nativeInValue: string
  nativeOutValue: string
  tokenInCount: number
  tokenOutCount: number
  creationInCount: number
  creationOutCount: number
  supportingEvidence: string[]
  tokenAddresses: Hex[]
  sampleTxHash: Hex | null
}

export type SearchTarget =
  | { type: 'block'; number: number }
  | { type: 'transaction'; hash: Hex }
  | { type: 'address'; address: Hex }

export type DecodedFunctionCall = {
  functionName: string
  signature: string
  args: Array<{ name: string; value: string }>
}

export type DecodedEvent = {
  eventName: string
  signature: string
  args: Array<{ name: string; value: string; indexed: boolean }>
}

export type RawCallTrace = {
  type?: string
  from?: Hex | null
  to?: Hex | null
  input?: Hex
  output?: Hex
  value?: Hex | string | null
  gas?: Hex | string | null
  gasUsed?: Hex | string | null
  error?: string
  revertReason?: string
  calls?: RawCallTrace[]
}

export type TraceNode = {
  id: string
  type: string
  from: Hex | null
  to: Hex | null
  input: Hex
  output: Hex | null
  value: string | null
  gas: string | null
  gasUsed: string | null
  selector: string | null
  functionName: string | null
  signature: string | null
  args: Array<{ name: string; value: string }>
  error: string | null
  revertReason: string | null
  status: 'success' | 'reverted' | 'failed'
  calls: TraceNode[]
}
