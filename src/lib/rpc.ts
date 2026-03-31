import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  parseAbi,
  parseEther,
  toHex,
  type Hex,
  type PublicClient,
} from 'viem'
import type {
  AddressKind,
  Erc20TokenInfo,
  TokenBalance,
  TokenHolderBalance,
  RpcBlock,
  RpcReceipt,
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

export async function getChainInfo(client: AnvilClient) {
  const [chainIdHex, clientVersion, latestBlockHex] = await Promise.all([
    rpcRequest<Hex>(client, 'eth_chainId'),
    rpcRequest<string>(client, 'web3_clientVersion'),
    rpcRequest<Hex>(client, 'eth_blockNumber'),
  ])

  return {
    chainId: Number(chainIdHex),
    clientVersion,
    latestBlockNumber: Number(latestBlockHex),
  }
}

export async function getLatestBlockNumber(client: AnvilClient) {
  const blockNumber = await rpcRequest<Hex>(client, 'eth_blockNumber')
  return Number(blockNumber)
}

export async function getBlockByNumber(client: AnvilClient, blockNumber: number) {
  return rpcRequest<RpcBlock>(client, 'eth_getBlockByNumber', [toHex(blockNumber), true])
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

export async function setBalance(client: AnvilClient, address: string, amountEth: string) {
  if (!isAddress(address)) {
    throw new Error('Invalid address')
  }

  await rpcRequest(client, 'anvil_setBalance', [getAddress(address), toHex(parseEther(amountEth))])
}

export async function getTrace(client: AnvilClient, txHash: Hex) {
  return rpcRequest<unknown>(client, 'debug_traceTransaction', [
    txHash,
    {
      tracer: 'callTracer',
    },
  ])
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
