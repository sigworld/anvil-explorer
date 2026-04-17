import {
  createPublicClient,
  encodeAbiParameters,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseEther,
  toHex,
  type Hex,
  type PublicClient,
} from 'viem'
import type {
  AddressKind,
  Erc20TokenInfo,
  ForkConfig,
  OpcodeEntry,
  OpcodeTrace,
  TokenBalance,
  TokenHolderBalance,
  RpcBlock,
  RpcReceipt,
  RpcTransaction,
} from './types.ts'

export type AnvilClient = PublicClient

const erc20ReadAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function totalSupply() view returns (uint256)',
])

export function createAnvilClient(rpcUrl: string): AnvilClient {
  return createPublicClient({
    transport: http(rpcUrl),
  })
}

export async function rpcRequest<T>(client: AnvilClient, method: string, params: unknown[] = []) {
  return (client as unknown as { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }).request({
    method,
    params,
  }) as Promise<T>
}

type AnvilNodeInfo = {
  currentBlockNumber: Hex | number
  currentBlockTimestamp: Hex | number
  environment: Record<string, unknown>
  forkConfig?: {
    forkUrl: string
    forkBlockNumber: Hex | number
  } | null
}

export async function getForkConfig(client: AnvilClient): Promise<ForkConfig | null> {
  try {
    const info = await rpcRequest<AnvilNodeInfo>(client, 'anvil_nodeInfo')
    const fc = info?.forkConfig
    if (!fc?.forkBlockNumber) {
      return null
    }
    return {
      forkUrl: fc.forkUrl,
      forkBlockNumber: typeof fc.forkBlockNumber === 'number'
        ? fc.forkBlockNumber
        : Number(BigInt(fc.forkBlockNumber)),
    }
  } catch {
    return null
  }
}

export async function getChainInfo(client: AnvilClient) {
  const [chainIdHex, clientVersion, latestBlockHex, forkConfig] = await Promise.all([
    rpcRequest<Hex>(client, 'eth_chainId'),
    rpcRequest<string>(client, 'web3_clientVersion'),
    rpcRequest<Hex>(client, 'eth_blockNumber'),
    getForkConfig(client),
  ])

  return {
    chainId: Number(chainIdHex),
    clientVersion,
    latestBlockNumber: Number(latestBlockHex),
    forkConfig,
  }
}

export async function getLatestBlockNumber(client: AnvilClient) {
  const blockNumber = await rpcRequest<Hex>(client, 'eth_blockNumber')
  return Number(blockNumber)
}

export async function getBlockByNumber(client: AnvilClient, blockNumber: number) {
  return rpcRequest<RpcBlock>(client, 'eth_getBlockByNumber', [toHex(blockNumber), true])
}

export async function getTransactionByHash(client: AnvilClient, txHash: Hex) {
  return rpcRequest<RpcTransaction | null>(client, 'eth_getTransactionByHash', [txHash])
}

export async function getReceiptByHash(client: AnvilClient, txHash: Hex) {
  return rpcRequest<RpcReceipt | null>(client, 'eth_getTransactionReceipt', [txHash])
}

export async function createSnapshot(client: AnvilClient) {
  return rpcRequest<string>(client, 'evm_snapshot')
}

export async function revertSnapshot(client: AnvilClient, snapshotId: string) {
  return rpcRequest<boolean>(client, 'evm_revert', [snapshotId])
}

export async function mineBlocks(client: AnvilClient, count: number) {
  await rpcRequest(client, 'anvil_mine', [toHex(count)])
}

export async function mintNativeBalance(client: AnvilClient, address: string, amountEth: string) {
  if (!isAddress(address)) {
    throw new Error('Invalid address')
  }

  const checksummed = getAddress(address)
  const currentBalance = await rpcRequest<Hex>(client, 'eth_getBalance', [checksummed, 'latest'])
  const newBalance = BigInt(currentBalance) + parseEther(amountEth)
  await rpcRequest(client, 'anvil_setBalance', [checksummed, toHex(newBalance)])
}

export async function getTrace(client: AnvilClient, txHash: Hex) {
  return rpcRequest<unknown>(client, 'debug_traceTransaction', [
    txHash,
    {
      tracer: 'callTracer',
    },
  ])
}

const OPCODE_JS_TRACER = [
  '{',
  '  data: [], gas: 0,',
  '  step: function(log) {',
  '    var s = log.stack;',
  '    var stack = [];',
  '    for (var i = 0; i < s.length(); i++) stack.push("0x" + s.peek(i).toString(16));',
  '    var addr = null;',
  '    try {',
  '      var a = log.contract.getAddress();',
  '      addr = "0x";',
  '      for (var j = 0; j < a.length; j++) { var b = a[j].toString(16); addr += b.length === 1 ? "0" + b : b; }',
  '    } catch(e) {}',
  '    this.data.push({ pc: log.getPC(), op: log.op.toString(), gas: log.getGas(), gasCost: log.getCost(), depth: log.getDepth(), stack: stack, address: addr });',
  '    this.gas += log.getCost();',
  '  },',
  '  result: function() { return { totalGas: this.gas, entries: this.data }; },',
  '  fault: function() {}',
  '}',
].join('')

type RpcStructLog = {
  pc?: number
  op?: string
  gas?: number | string
  gasCost?: number | string
  depth?: number
  stack?: string[]
  memory?: string[]
  storage?: Record<string, string> | null
  returnData?: string | null
}

type RpcOpcodeTraceResult = {
  gas?: number | string
  structLogs?: RpcStructLog[]
}

function toOptionalHex(value: string | null | undefined) {
  if (!value) {
    return null
  }
  return value.startsWith('0x') ? value : `0x${value}`
}

function toNumberQuantity(value: number | string | undefined) {
  if (typeof value === 'number') {
    return value
  }

  if (!value) {
    return 0
  }

  try {
    return Number(BigInt(value))
  } catch {
    return Number(value) || 0
  }
}

export type OpcodeTraceOptions = {
  enableStorage?: boolean
}

/**
 * When Anvil returns empty/null storage fields in structLogs, derive cumulative
 * storage state from SSTORE and SLOAD opcodes by reading their stack arguments.
 * Mutates entries in place, only filling in entries that lack storage data.
 */
function deriveStorageFromOpcodes(entries: OpcodeEntry[]) {
  // If the RPC already provided storage data, leave it alone.
  if (entries.some((e) => e.storage && Object.keys(e.storage).length > 0)) return

  // Per-depth cumulative storage map (depth → slot → value).
  const storageByDepth = new Map<number, Record<string, string>>()
  let prevDepth = 0

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]

    // When returning to a shallower depth, drop deeper maps
    if (entry.depth < prevDepth) {
      for (const d of [...storageByDepth.keys()]) {
        if (d > entry.depth) storageByDepth.delete(d)
      }
    }
    prevDepth = entry.depth

    const { op, stack } = entry
    if (op !== 'SSTORE' && op !== 'SLOAD') continue

    if (!storageByDepth.has(entry.depth)) {
      storageByDepth.set(entry.depth, {})
    }
    const map = storageByDepth.get(entry.depth)!

    if (op === 'SSTORE' && stack.length >= 2) {
      map[stack[stack.length - 1]] = stack[stack.length - 2]
    } else if (op === 'SLOAD' && stack.length >= 1) {
      const slot = stack[stack.length - 1]
      const next = i + 1 < entries.length ? entries[i + 1] : null
      if (next && next.depth === entry.depth && next.stack.length >= 1) {
        map[slot] = next.stack[next.stack.length - 1]
      } else if (!(slot in map)) {
        map[slot] = '0x0'
      }
    }

    entry.storage = { ...map }
  }
}

export async function getOpcodeTrace(client: AnvilClient, txHash: Hex, options?: OpcodeTraceOptions): Promise<OpcodeTrace> {
  const enableStorage = options?.enableStorage ?? false

  try {
    const result = await rpcRequest<RpcOpcodeTraceResult>(client, 'debug_traceTransaction', [
      txHash,
      {
        disableStorage: !enableStorage,
        disableStack: false,
        enableMemory: true,
        enableReturnData: true,
      },
    ])

    if (Array.isArray(result?.structLogs)) {
      const entries = result.structLogs.map((entry) => ({
        pc: entry.pc ?? 0,
        op: entry.op ?? 'UNKNOWN',
        gas: toNumberQuantity(entry.gas),
        gasCost: toNumberQuantity(entry.gasCost),
        depth: entry.depth ?? 0,
        stack: (entry.stack ?? []).map((item) => toOptionalHex(item) ?? '0x'),
        memory: entry.memory?.map((item) => toOptionalHex(item) ?? '0x'),
        storage: entry.storage ?? undefined,
        returnData: toOptionalHex(entry.returnData ?? null),
      }))

      if (enableStorage) {
        deriveStorageFromOpcodes(entries)
      }

      return {
        totalGas: toNumberQuantity(result.gas) || entries.reduce((sum, entry) => sum + entry.gasCost, 0),
        entries,
      }
    }
  } catch {
    // Fall back to the lightweight tracer below.
  }

  const result = await rpcRequest<OpcodeTrace>(client, 'debug_traceTransaction', [
    txHash,
    { tracer: OPCODE_JS_TRACER },
  ])
  return {
    totalGas: result.totalGas ?? 0,
    entries: result.entries ?? [],
  }
}

export function normalizeAddress(value: string) {
  if (!isAddress(value)) {
    return null
  }

  return getAddress(value)
}

export async function getAddressKind(client: AnvilClient, address: Hex): Promise<AddressKind> {
  const code = await getCode(client, address)
  return code === '0x' ? 'wallet' : 'contract'
}

export async function getCode(client: AnvilClient, address: Hex, blockTag: Hex | 'latest' = 'latest') {
  return rpcRequest<Hex>(client, 'eth_getCode', [address, blockTag])
}

export async function getNativeBalance(client: AnvilClient, address: Hex) {
  const balance = await rpcRequest<Hex>(client, 'eth_getBalance', [address, 'latest'])
  return BigInt(balance).toString()
}

async function readContractValue<T>(
  client: AnvilClient,
  tokenAddress: Hex,
  functionName: 'balanceOf' | 'decimals' | 'symbol' | 'name' | 'totalSupply',
  args: readonly unknown[] = [],
  blockNumber?: bigint,
) {
  return client.readContract({
    address: tokenAddress,
    abi: erc20ReadAbi,
    functionName,
    args,
    blockNumber,
  } as any) as Promise<T>
}

export async function getErc20TokenInfo(
  client: AnvilClient,
  tokenAddress: Hex,
): Promise<Erc20TokenInfo | null> {
  try {
    const [decimals, symbol, name, totalSupply] = await Promise.all([
      readContractValue<number>(client, tokenAddress, 'decimals'),
      readContractValue<string>(client, tokenAddress, 'symbol').catch(() => null),
      readContractValue<string>(client, tokenAddress, 'name').catch(() => null),
      readContractValue<bigint>(client, tokenAddress, 'totalSupply'),
    ])

    return {
      tokenAddress,
      decimals,
      symbol,
      name,
      totalSupply: totalSupply.toString(),
    }
  } catch {
    return null
  }
}

export async function getErc20Balance(
  client: AnvilClient,
  tokenAddress: Hex,
  holderAddress: Hex,
  lastUpdatedBlock: number | null,
): Promise<TokenBalance | null> {
  try {
    const balance = await readContractValue<bigint>(client, tokenAddress, 'balanceOf', [holderAddress])
    const [decimals, symbol, name] = await Promise.all([
      readContractValue<number>(client, tokenAddress, 'decimals').catch(() => 18),
      readContractValue<string>(client, tokenAddress, 'symbol').catch(() => null),
      readContractValue<string>(client, tokenAddress, 'name').catch(() => null),
    ])

    return {
      tokenAddress,
      balance: balance.toString(),
      decimals,
      symbol,
      name,
      lastUpdatedBlock,
    }
  } catch {
    return null
  }
}

export async function getErc20BalanceAtBlock(
  client: AnvilClient,
  tokenAddress: Hex,
  holderAddress: Hex,
  blockNumber: number,
) {
  const balance = await readContractValue<bigint>(
    client,
    tokenAddress,
    'balanceOf',
    [holderAddress],
    BigInt(blockNumber),
  )
  return balance.toString()
}

export async function getErc20HolderBalance(
  client: AnvilClient,
  tokenAddress: Hex,
  holderAddress: Hex,
  lastUpdatedBlock: number | null,
): Promise<TokenHolderBalance | null> {
  try {
    const balance = await readContractValue<bigint>(client, tokenAddress, 'balanceOf', [holderAddress])

    if (balance === 0n) {
      return null
    }

    return {
      holderAddress,
      balance: balance.toString(),
      lastUpdatedBlock,
    }
  } catch {
    return null
  }
}

export async function setStorageAt(client: AnvilClient, address: Hex, slot: Hex, value: Hex) {
  await rpcRequest(client, 'anvil_setStorageAt', [address, slot, value])
}

export async function getStorageAt(client: AnvilClient, address: Hex, slot: Hex): Promise<Hex> {
  return rpcRequest<Hex>(client, 'eth_getStorageAt', [address, slot, 'latest'])
}

type PrestateResult = Record<string, {
  balance?: string
  nonce?: number
  code?: string
  storage?: Record<string, string>
}>

/**
 * Fetch all storage slots for a contract using the prestateTracer.
 * Returns the post-state storage for the given address after the transaction.
 */
export async function getFullContractStorage(
  client: AnvilClient,
  txHash: Hex,
  address: Hex,
): Promise<Record<string, string>> {
  const result = await rpcRequest<PrestateResult>(client, 'debug_traceTransaction', [
    txHash,
    { tracer: 'prestateTracer', tracerConfig: { diffMode: false } },
  ])

  const normalizedTarget = address.toLowerCase()
  for (const [addr, state] of Object.entries(result)) {
    if (addr.toLowerCase() === normalizedTarget && state.storage) {
      return state.storage
    }
  }

  return {}
}

export const ERC1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as Hex
export const ERC1967_BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50' as Hex
export const ERC1967_ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103' as Hex
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export function addressFromSlot(slot: Hex): Hex {
  return ('0x' + slot.slice(26)) as Hex
}

export async function getProxyImplementation(client: AnvilClient, address: Hex): Promise<Hex | null> {
  try {
    const implAddr = addressFromSlot(await getStorageAt(client, address, ERC1967_IMPLEMENTATION_SLOT))
    if (implAddr !== ZERO_ADDRESS) {
      return getAddress(implAddr)
    }

    const beaconAddr = addressFromSlot(await getStorageAt(client, address, ERC1967_BEACON_SLOT))
    if (beaconAddr !== ZERO_ADDRESS) {
      const beaconImplAddr = addressFromSlot(await getStorageAt(client, getAddress(beaconAddr) as Hex, ERC1967_IMPLEMENTATION_SLOT))
      if (beaconImplAddr !== ZERO_ADDRESS) {
        return getAddress(beaconImplAddr)
      }
    }

    return null
  } catch {
    return null
  }
}

export async function dealErc20(
  client: AnvilClient,
  tokenAddress: string,
  recipientAddress: string,
  amount: bigint,
) {
  if (!isAddress(tokenAddress)) throw new Error('Invalid token address')
  if (!isAddress(recipientAddress)) throw new Error('Invalid recipient address')

  const token = getAddress(tokenAddress) as Hex
  const recipient = getAddress(recipientAddress) as Hex
  const balanceBefore = await readContractValue<bigint>(client, token, 'balanceOf', [recipient])
  const targetBalance = balanceBefore + amount

  async function trySlot(storageSlot: Hex): Promise<boolean> {
    const original = await getStorageAt(client, token, storageSlot)
    await setStorageAt(client, token, storageSlot, toHex(targetBalance, { size: 32 }))
    const balance = await readContractValue<bigint>(client, token, 'balanceOf', [recipient])
    if (balance === targetBalance) return true
    await setStorageAt(client, token, storageSlot, original)
    return false
  }

  for (let slot = 0; slot < 20; slot++) {
    const soliditySlot = keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }],
        [recipient, BigInt(slot)],
      ),
    )
    if (await trySlot(soliditySlot)) return

    const vyperSlot = keccak256(
      encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'address' }],
        [BigInt(slot), recipient],
      ),
    )
    if (await trySlot(vyperSlot)) return
  }

  throw new Error('Could not find balanceOf storage slot for this token (tried slots 0–19)')
}
