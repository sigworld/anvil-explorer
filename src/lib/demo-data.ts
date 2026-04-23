import { type Abi, type Hex, encodeFunctionData, parseAbi } from 'viem'
import type {
  AbiRecord,
  BlockRecord,
  ChainMeta,
  ExplorerStats,
  LogRecord,
  OpcodeEntry,
  RawCallTrace,
  ReceiptRecord,
  TransactionRecord,
} from './types.ts'

// ── Addresses ──────────────────────────────────────────────────────────
// Well-known public contract addresses and generic wallets

export const DEMO_ADDRESSES = {
  wbtc: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' as Hex,
  vault: '0x1111111111111111111111111111111111111111' as Hex,
  router: '0x2222222222222222222222222222222222222222' as Hex,
  alice: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B' as Hex,
  bob: '0xBcd4042DE499D14e55001CcbB24a551F3b954096' as Hex,
  custodian: '0xCA35b7d915458EF540aDe6068dFe2F44E8fa733c' as Hex,
  zero: '0x0000000000000000000000000000000000000000' as Hex,
}

const A = DEMO_ADDRESSES

// ── ABIs ───────────────────────────────────────────────────────────────

const ERC20_ABI: Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function mint(address to, uint256 amount)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
])

const VAULT_ABI: Abi = parseAbi([
  'function deposit(uint256 amount)',
  'function withdraw(uint256 amount)',
  'function balanceOf(address account) view returns (uint256)',
  'event Deposit(address indexed sender, uint256 amount)',
  'event Withdrawal(address indexed sender, uint256 amount)',
])

const ROUTER_ABI: Abi = parseAbi([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function addLiquidity(address tokenA, address tokenB, uint256 amountA, uint256 amountB) returns (uint256 liquidity)',
  'event Swap(address indexed sender, uint256 amountIn, uint256 amountOut, address indexed to)',
])

// ── Event topics ───────────────────────────────────────────────────────

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925' as Hex
const DEPOSIT_TOPIC = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c' as Hex
const WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65' as Hex
const SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822' as Hex

function pad32(addr: Hex): Hex {
  return `0x${addr.slice(2).toLowerCase().padStart(64, '0')}` as Hex
}

function uint256Hex(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, '0')}` as Hex
}

// ── Deterministic hashes ───────────────────────────────────────────────

const BASE_TS = Math.floor(Date.now() / 1000) - 240

function blockTs(index: number) {
  return BASE_TS + index * 12
}

function fakeHash(seed: number): Hex {
  const hex = seed.toString(16).padStart(8, '0')
  return `0x${hex.repeat(8)}` as Hex
}

function fakeTxHash(blockSeed: number, txIndex: number): Hex {
  const hex = ((blockSeed * 100) + txIndex).toString(16).padStart(8, '0')
  return `0xaa${hex.repeat(7).slice(0, 62)}` as Hex
}

// ── WBTC uses 8 decimals ──────────────────────────────────────────────

const WBTC_UNIT = 100000000n // 1 WBTC = 10^8 satoshi

function encodeErc20(fn: string, args: unknown[]): Hex {
  return encodeFunctionData({ abi: ERC20_ABI, functionName: fn, args } as any)
}

function encodeVault(fn: string, args: unknown[]): Hex {
  return encodeFunctionData({ abi: VAULT_ABI, functionName: fn, args } as any)
}

function encodeRouter(fn: string, args: unknown[]): Hex {
  return encodeFunctionData({ abi: ROUTER_ABI, functionName: fn, args } as any)
}

// ── Blocks ─────────────────────────────────────────────────────────────

const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

export function createDemoBlocks(): BlockRecord[] {
  return [
    { number: 0, hash: fakeHash(0), parentHash: ZERO_HASH, timestamp: blockTs(0), miner: A.zero, gasLimit: '30000000', gasUsed: '0', baseFeePerGas: '1000000000', size: '537', transactionCount: 0 },
    { number: 1, hash: fakeHash(1), parentHash: fakeHash(0), timestamp: blockTs(1), miner: A.zero, gasLimit: '30000000', gasUsed: '1200000', baseFeePerGas: '1000000000', size: '2048', transactionCount: 1 },
    { number: 2, hash: fakeHash(2), parentHash: fakeHash(1), timestamp: blockTs(2), miner: A.zero, gasLimit: '30000000', gasUsed: '900000', baseFeePerGas: '875000000', size: '1836', transactionCount: 1 },
    { number: 3, hash: fakeHash(3), parentHash: fakeHash(2), timestamp: blockTs(3), miner: A.zero, gasLimit: '30000000', gasUsed: '850000', baseFeePerGas: '875000000', size: '1700', transactionCount: 1 },
    { number: 4, hash: fakeHash(4), parentHash: fakeHash(3), timestamp: blockTs(4), miner: A.zero, gasLimit: '30000000', gasUsed: '52000', baseFeePerGas: '850000000', size: '720', transactionCount: 1 },
    { number: 5, hash: fakeHash(5), parentHash: fakeHash(4), timestamp: blockTs(5), miner: A.zero, gasLimit: '30000000', gasUsed: '42000', baseFeePerGas: '850000000', size: '680', transactionCount: 2 },
    { number: 6, hash: fakeHash(6), parentHash: fakeHash(5), timestamp: blockTs(6), miner: A.zero, gasLimit: '30000000', gasUsed: '46000', baseFeePerGas: '812500000', size: '700', transactionCount: 1 },
    { number: 7, hash: fakeHash(7), parentHash: fakeHash(6), timestamp: blockTs(7), miner: A.zero, gasLimit: '30000000', gasUsed: '95000', baseFeePerGas: '812500000', size: '900', transactionCount: 1 },
    { number: 8, hash: fakeHash(8), parentHash: fakeHash(7), timestamp: blockTs(8), miner: A.zero, gasLimit: '30000000', gasUsed: '52000', baseFeePerGas: '750000000', size: '700', transactionCount: 1 },
    { number: 9, hash: fakeHash(9), parentHash: fakeHash(8), timestamp: blockTs(9), miner: A.zero, gasLimit: '30000000', gasUsed: '180000', baseFeePerGas: '750000000', size: '1200', transactionCount: 1 },
    { number: 10, hash: fakeHash(10), parentHash: fakeHash(9), timestamp: blockTs(10), miner: A.zero, gasLimit: '30000000', gasUsed: '116000', baseFeePerGas: '700000000', size: '1100', transactionCount: 2 },
    { number: 11, hash: fakeHash(11), parentHash: fakeHash(10), timestamp: blockTs(11), miner: A.zero, gasLimit: '30000000', gasUsed: '28000', baseFeePerGas: '700000000', size: '650', transactionCount: 1 },
    { number: 12, hash: fakeHash(12), parentHash: fakeHash(11), timestamp: blockTs(12), miner: A.zero, gasLimit: '30000000', gasUsed: '52000', baseFeePerGas: '700000000', size: '700', transactionCount: 1 },
  ]
}

// ── Transactions ───────────────────────────────────────────────────────

export function createDemoTransactions(): TransactionRecord[] {
  return [
    // Block 1: Deploy WBTC
    { hash: fakeTxHash(1, 0), blockHash: fakeHash(1), blockNumber: 1, transactionIndex: 0, from: A.custodian, to: null, nonce: 0, type: '2', input: '0x60806040523480156100105760' as Hex, value: '0', gas: '1500000', gasPrice: null, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000' },
    // Block 2: Deploy vault
    { hash: fakeTxHash(2, 0), blockHash: fakeHash(2), blockNumber: 2, transactionIndex: 0, from: A.custodian, to: null, nonce: 1, type: '2', input: '0x60806040526040516200' as Hex, value: '0', gas: '1000000', gasPrice: null, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000' },
    // Block 3: Deploy router
    { hash: fakeTxHash(3, 0), blockHash: fakeHash(3), blockNumber: 3, transactionIndex: 0, from: A.custodian, to: null, nonce: 2, type: '2', input: '0x60806040526101006040' as Hex, value: '0', gas: '1200000', gasPrice: null, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000' },
    // Block 4: Custodian mints 5 WBTC to Alice
    { hash: fakeTxHash(4, 0), blockHash: fakeHash(4), blockNumber: 4, transactionIndex: 0, from: A.custodian, to: A.wbtc, nonce: 3, type: '2', input: encodeErc20('mint', [A.alice, 5n * WBTC_UNIT]), value: '0', gas: '80000', gasPrice: null, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000' },
    // Block 5: Alice sends 1 ETH to Bob + Custodian mints 3 WBTC to Bob
    { hash: fakeTxHash(5, 0), blockHash: fakeHash(5), blockNumber: 5, transactionIndex: 0, from: A.alice, to: A.bob, nonce: 0, type: '2', input: '0x' as Hex, value: '1000000000000000000', gas: '21000', gasPrice: null, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000' },
    { hash: fakeTxHash(5, 1), blockHash: fakeHash(5), blockNumber: 5, transactionIndex: 1, from: A.custodian, to: A.wbtc, nonce: 4, type: '2', input: encodeErc20('mint', [A.bob, 3n * WBTC_UNIT]), value: '0', gas: '80000', gasPrice: null, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000' },
    // Block 6: Alice approves vault to spend WBTC
    { hash: fakeTxHash(6, 0), blockHash: fakeHash(6), blockNumber: 6, transactionIndex: 0, from: A.alice, to: A.wbtc, nonce: 1, type: '2', input: encodeErc20('approve', [A.vault, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')]), value: '0', gas: '46000', gasPrice: null, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000' },
    // Block 7: Alice deposits 2 WBTC into vault (nested: vault → wbtc.transferFrom)
    { hash: fakeTxHash(7, 0), blockHash: fakeHash(7), blockNumber: 7, transactionIndex: 0, from: A.alice, to: A.vault, nonce: 2, type: '2', input: encodeVault('deposit', [2n * WBTC_UNIT]), value: '0', gas: '120000', gasPrice: null, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000' },
    // Block 8: Alice transfers 1 WBTC to Bob
    { hash: fakeTxHash(8, 0), blockHash: fakeHash(8), blockNumber: 8, transactionIndex: 0, from: A.alice, to: A.wbtc, nonce: 3, type: '2', input: encodeErc20('transfer', [A.bob, 1n * WBTC_UNIT]), value: '0', gas: '65000', gasPrice: null, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000' },
    // Block 9: Bob swaps 2 WBTC via router (nested: router → wbtc.transferFrom → vault.deposit → wbtc.transferFrom)
    { hash: fakeTxHash(9, 0), blockHash: fakeHash(9), blockNumber: 9, transactionIndex: 0, from: A.bob, to: A.router, nonce: 0, type: '2', input: encodeRouter('swapExactTokensForTokens', [2n * WBTC_UNIT, 1n * WBTC_UNIT, [A.wbtc, A.vault], A.bob, BigInt(Math.floor(Date.now() / 1000) + 3600)]), value: '0', gas: '250000', gasPrice: null, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000' },
    // Block 10: Bob sends 0.5 ETH to custodian + Alice withdraws 1 WBTC from vault
    { hash: fakeTxHash(10, 0), blockHash: fakeHash(10), blockNumber: 10, transactionIndex: 0, from: A.bob, to: A.custodian, nonce: 1, type: '2', input: '0x' as Hex, value: '500000000000000000', gas: '21000', gasPrice: null, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000' },
    { hash: fakeTxHash(10, 1), blockHash: fakeHash(10), blockNumber: 10, transactionIndex: 1, from: A.alice, to: A.vault, nonce: 4, type: '2', input: encodeVault('withdraw', [1n * WBTC_UNIT]), value: '0', gas: '120000', gasPrice: null, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000' },
    // Block 11: Alice tries to transfer 10 WBTC (only has ~2) — FAILS
    { hash: fakeTxHash(11, 0), blockHash: fakeHash(11), blockNumber: 11, transactionIndex: 0, from: A.alice, to: A.wbtc, nonce: 5, type: '2', input: encodeErc20('transfer', [A.bob, 10n * WBTC_UNIT]), value: '0', gas: '65000', gasPrice: null, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000' },
    // Block 12: Custodian mints 2 WBTC to Alice
    { hash: fakeTxHash(12, 0), blockHash: fakeHash(12), blockNumber: 12, transactionIndex: 0, from: A.custodian, to: A.wbtc, nonce: 5, type: '2', input: encodeErc20('mint', [A.alice, 2n * WBTC_UNIT]), value: '0', gas: '80000', gasPrice: null, maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000' },
  ]
}

// ── Receipts ───────────────────────────────────────────────────────────

export function createDemoReceipts(): ReceiptRecord[] {
  return [
    { txHash: fakeTxHash(1, 0), blockHash: fakeHash(1), blockNumber: 1, transactionIndex: 0, contractAddress: A.wbtc, from: A.custodian, to: null, gasUsed: '1100000', cumulativeGasUsed: '1100000', effectiveGasPrice: '1000001000', status: '1', type: '2' },
    { txHash: fakeTxHash(2, 0), blockHash: fakeHash(2), blockNumber: 2, transactionIndex: 0, contractAddress: A.vault, from: A.custodian, to: null, gasUsed: '850000', cumulativeGasUsed: '850000', effectiveGasPrice: '876001000', status: '1', type: '2' },
    { txHash: fakeTxHash(3, 0), blockHash: fakeHash(3), blockNumber: 3, transactionIndex: 0, contractAddress: A.router, from: A.custodian, to: null, gasUsed: '800000', cumulativeGasUsed: '800000', effectiveGasPrice: '876001000', status: '1', type: '2' },
    { txHash: fakeTxHash(4, 0), blockHash: fakeHash(4), blockNumber: 4, transactionIndex: 0, contractAddress: null, from: A.custodian, to: A.wbtc, gasUsed: '52000', cumulativeGasUsed: '52000', effectiveGasPrice: '851001000', status: '1', type: '2' },
    { txHash: fakeTxHash(5, 0), blockHash: fakeHash(5), blockNumber: 5, transactionIndex: 0, contractAddress: null, from: A.alice, to: A.bob, gasUsed: '21000', cumulativeGasUsed: '21000', effectiveGasPrice: '851001000', status: '1', type: '2' },
    { txHash: fakeTxHash(5, 1), blockHash: fakeHash(5), blockNumber: 5, transactionIndex: 1, contractAddress: null, from: A.custodian, to: A.wbtc, gasUsed: '52000', cumulativeGasUsed: '73000', effectiveGasPrice: '851001000', status: '1', type: '2' },
    { txHash: fakeTxHash(6, 0), blockHash: fakeHash(6), blockNumber: 6, transactionIndex: 0, contractAddress: null, from: A.alice, to: A.wbtc, gasUsed: '46000', cumulativeGasUsed: '46000', effectiveGasPrice: '813501000', status: '1', type: '2' },
    { txHash: fakeTxHash(7, 0), blockHash: fakeHash(7), blockNumber: 7, transactionIndex: 0, contractAddress: null, from: A.alice, to: A.vault, gasUsed: '95000', cumulativeGasUsed: '95000', effectiveGasPrice: '813501000', status: '1', type: '2' },
    { txHash: fakeTxHash(8, 0), blockHash: fakeHash(8), blockNumber: 8, transactionIndex: 0, contractAddress: null, from: A.alice, to: A.wbtc, gasUsed: '52000', cumulativeGasUsed: '52000', effectiveGasPrice: '751001000', status: '1', type: '2' },
    { txHash: fakeTxHash(9, 0), blockHash: fakeHash(9), blockNumber: 9, transactionIndex: 0, contractAddress: null, from: A.bob, to: A.router, gasUsed: '175000', cumulativeGasUsed: '175000', effectiveGasPrice: '751001000', status: '1', type: '2' },
    { txHash: fakeTxHash(10, 0), blockHash: fakeHash(10), blockNumber: 10, transactionIndex: 0, contractAddress: null, from: A.bob, to: A.custodian, gasUsed: '21000', cumulativeGasUsed: '21000', effectiveGasPrice: '701001000', status: '1', type: '2' },
    { txHash: fakeTxHash(10, 1), blockHash: fakeHash(10), blockNumber: 10, transactionIndex: 1, contractAddress: null, from: A.alice, to: A.vault, gasUsed: '95000', cumulativeGasUsed: '116000', effectiveGasPrice: '701001000', status: '1', type: '2' },
    { txHash: fakeTxHash(11, 0), blockHash: fakeHash(11), blockNumber: 11, transactionIndex: 0, contractAddress: null, from: A.alice, to: A.wbtc, gasUsed: '28000', cumulativeGasUsed: '28000', effectiveGasPrice: '701001000', status: '0', type: '2' },
    { txHash: fakeTxHash(12, 0), blockHash: fakeHash(12), blockNumber: 12, transactionIndex: 0, contractAddress: null, from: A.custodian, to: A.wbtc, gasUsed: '52000', cumulativeGasUsed: '52000', effectiveGasPrice: '701001000', status: '1', type: '2' },
  ]
}

// ── Logs ────────────────────────────────────────────────────────────────

export function createDemoLogs(): LogRecord[] {
  return [
    // Block 4: Mint 5 WBTC to Alice
    { address: A.wbtc, blockHash: fakeHash(4), blockNumber: 4, txHash: fakeTxHash(4, 0), transactionIndex: 0, logIndex: 0, data: uint256Hex(5n * WBTC_UNIT), topics: [TRANSFER_TOPIC, pad32(A.zero), pad32(A.alice)], topic0: TRANSFER_TOPIC, removed: false },
    // Block 5: Mint 3 WBTC to Bob
    { address: A.wbtc, blockHash: fakeHash(5), blockNumber: 5, txHash: fakeTxHash(5, 1), transactionIndex: 1, logIndex: 0, data: uint256Hex(3n * WBTC_UNIT), topics: [TRANSFER_TOPIC, pad32(A.zero), pad32(A.bob)], topic0: TRANSFER_TOPIC, removed: false },
    // Block 6: Approval(alice → vault, max)
    { address: A.wbtc, blockHash: fakeHash(6), blockNumber: 6, txHash: fakeTxHash(6, 0), transactionIndex: 0, logIndex: 0, data: uint256Hex(BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')), topics: [APPROVAL_TOPIC, pad32(A.alice), pad32(A.vault)], topic0: APPROVAL_TOPIC, removed: false },
    // Block 7: Deposit — Transfer(alice → vault, 2 WBTC)
    { address: A.wbtc, blockHash: fakeHash(7), blockNumber: 7, txHash: fakeTxHash(7, 0), transactionIndex: 0, logIndex: 0, data: uint256Hex(2n * WBTC_UNIT), topics: [TRANSFER_TOPIC, pad32(A.alice), pad32(A.vault)], topic0: TRANSFER_TOPIC, removed: false },
    // Block 7: Deposit event
    { address: A.vault, blockHash: fakeHash(7), blockNumber: 7, txHash: fakeTxHash(7, 0), transactionIndex: 0, logIndex: 1, data: uint256Hex(2n * WBTC_UNIT), topics: [DEPOSIT_TOPIC, pad32(A.alice)], topic0: DEPOSIT_TOPIC, removed: false },
    // Block 8: Transfer(alice → bob, 1 WBTC)
    { address: A.wbtc, blockHash: fakeHash(8), blockNumber: 8, txHash: fakeTxHash(8, 0), transactionIndex: 0, logIndex: 0, data: uint256Hex(1n * WBTC_UNIT), topics: [TRANSFER_TOPIC, pad32(A.alice), pad32(A.bob)], topic0: TRANSFER_TOPIC, removed: false },
    // Block 9: Router swap — Transfer(bob → router, 2 WBTC)
    { address: A.wbtc, blockHash: fakeHash(9), blockNumber: 9, txHash: fakeTxHash(9, 0), transactionIndex: 0, logIndex: 0, data: uint256Hex(2n * WBTC_UNIT), topics: [TRANSFER_TOPIC, pad32(A.bob), pad32(A.router)], topic0: TRANSFER_TOPIC, removed: false },
    // Block 9: Router swap — Transfer(router → vault, 2 WBTC)
    { address: A.wbtc, blockHash: fakeHash(9), blockNumber: 9, txHash: fakeTxHash(9, 0), transactionIndex: 0, logIndex: 1, data: uint256Hex(2n * WBTC_UNIT), topics: [TRANSFER_TOPIC, pad32(A.router), pad32(A.vault)], topic0: TRANSFER_TOPIC, removed: false },
    // Block 9: Deposit event from vault
    { address: A.vault, blockHash: fakeHash(9), blockNumber: 9, txHash: fakeTxHash(9, 0), transactionIndex: 0, logIndex: 2, data: uint256Hex(2n * WBTC_UNIT), topics: [DEPOSIT_TOPIC, pad32(A.router)], topic0: DEPOSIT_TOPIC, removed: false },
    // Block 9: Swap event from router
    { address: A.router, blockHash: fakeHash(9), blockNumber: 9, txHash: fakeTxHash(9, 0), transactionIndex: 0, logIndex: 3, data: uint256Hex(2n * WBTC_UNIT) + uint256Hex(2n * WBTC_UNIT).slice(2) as Hex, topics: [SWAP_TOPIC, pad32(A.bob), pad32(A.bob)], topic0: SWAP_TOPIC, removed: false },
    // Block 10: Withdrawal(alice, 1 WBTC)
    { address: A.vault, blockHash: fakeHash(10), blockNumber: 10, txHash: fakeTxHash(10, 1), transactionIndex: 1, logIndex: 0, data: uint256Hex(1n * WBTC_UNIT), topics: [WITHDRAWAL_TOPIC, pad32(A.alice)], topic0: WITHDRAWAL_TOPIC, removed: false },
    // Block 10: Transfer(vault → alice, 1 WBTC)
    { address: A.wbtc, blockHash: fakeHash(10), blockNumber: 10, txHash: fakeTxHash(10, 1), transactionIndex: 1, logIndex: 1, data: uint256Hex(1n * WBTC_UNIT), topics: [TRANSFER_TOPIC, pad32(A.vault), pad32(A.alice)], topic0: TRANSFER_TOPIC, removed: false },
    // Block 12: Mint 2 WBTC to Alice
    { address: A.wbtc, blockHash: fakeHash(12), blockNumber: 12, txHash: fakeTxHash(12, 0), transactionIndex: 0, logIndex: 0, data: uint256Hex(2n * WBTC_UNIT), topics: [TRANSFER_TOPIC, pad32(A.zero), pad32(A.alice)], topic0: TRANSFER_TOPIC, removed: false },
  ]
}

// ── ABI records ────────────────────────────────────────────────────────

export function createDemoAbis(): AbiRecord[] {
  const now = Date.now()
  return [
    { address: A.wbtc, abi: ERC20_ABI, source: 'demo', updatedAt: now },
    { address: A.vault, abi: VAULT_ABI, source: 'demo', updatedAt: now },
    { address: A.router, abi: ROUTER_ABI, source: 'demo', updatedAt: now },
  ]
}

// ── Mock call traces ───────────────────────────────────────────────────

const DEMO_TX_BY_HASH = new Map(createDemoTransactions().map((tx) => [tx.hash, tx]))

export function getDemoTrace(txHash: Hex): RawCallTrace | null {
  // Block 7: vault.deposit(2 WBTC) → wbtc.transferFrom(alice, vault, 2) + wbtc.balanceOf(vault)
  if (txHash === fakeTxHash(7, 0)) {
    return {
      type: 'CALL', from: A.alice, to: A.vault,
      input: encodeVault('deposit', [2n * WBTC_UNIT]),
      output: '0x' as Hex,
      value: '0x0', gas: '0x1d4c0', gasUsed: '0x17318',
      calls: [
        {
          type: 'CALL', from: A.vault, to: A.wbtc,
          input: encodeErc20('transferFrom', [A.alice, A.vault, 2n * WBTC_UNIT]),
          output: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
          value: '0x0', gas: '0x15f90', gasUsed: '0xb4e8',
        },
        {
          type: 'STATICCALL', from: A.vault, to: A.wbtc,
          input: encodeErc20('balanceOf', [A.vault]),
          output: uint256Hex(2n * WBTC_UNIT),
          value: '0x0', gas: '0xa028', gasUsed: '0x9c4',
        },
      ],
    }
  }

  // Block 9: router.swap → wbtc.transferFrom(bob, router) → vault.deposit → wbtc.transferFrom(router, vault)
  if (txHash === fakeTxHash(9, 0)) {
    return {
      type: 'CALL', from: A.bob, to: A.router,
      input: encodeRouter('swapExactTokensForTokens', [2n * WBTC_UNIT, 1n * WBTC_UNIT, [A.wbtc, A.vault], A.bob, BigInt(Math.floor(Date.now() / 1000) + 3600)]),
      output: '0x' as Hex,
      value: '0x0', gas: '0x3d090', gasUsed: '0x2ab98',
      calls: [
        {
          type: 'CALL', from: A.router, to: A.wbtc,
          input: encodeErc20('transferFrom', [A.bob, A.router, 2n * WBTC_UNIT]),
          output: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
          value: '0x0', gas: '0x30d40', gasUsed: '0xb4e8',
        },
        {
          type: 'CALL', from: A.router, to: A.vault,
          input: encodeVault('deposit', [2n * WBTC_UNIT]),
          output: '0x' as Hex,
          value: '0x0', gas: '0x249f0', gasUsed: '0x17318',
          calls: [
            {
              type: 'CALL', from: A.vault, to: A.wbtc,
              input: encodeErc20('transferFrom', [A.router, A.vault, 2n * WBTC_UNIT]),
              output: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
              value: '0x0', gas: '0x1adb0', gasUsed: '0xb4e8',
            },
            {
              type: 'STATICCALL', from: A.vault, to: A.wbtc,
              input: encodeErc20('balanceOf', [A.vault]),
              output: uint256Hex(4n * WBTC_UNIT),
              value: '0x0', gas: '0xa028', gasUsed: '0x9c4',
            },
          ],
        },
        {
          type: 'STATICCALL', from: A.router, to: A.wbtc,
          input: encodeErc20('balanceOf', [A.bob]),
          output: uint256Hex(2n * WBTC_UNIT),
          value: '0x0', gas: '0x7530', gasUsed: '0x9c4',
        },
      ],
    }
  }

  // Block 10 tx 1: vault.withdraw(1 WBTC) → wbtc.transfer(alice, 1)
  if (txHash === fakeTxHash(10, 1)) {
    return {
      type: 'CALL', from: A.alice, to: A.vault,
      input: encodeVault('withdraw', [1n * WBTC_UNIT]),
      output: '0x' as Hex,
      value: '0x0', gas: '0x1d4c0', gasUsed: '0x14820',
      calls: [
        {
          type: 'CALL', from: A.vault, to: A.wbtc,
          input: encodeErc20('transfer', [A.alice, 1n * WBTC_UNIT]),
          output: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
          value: '0x0', gas: '0x13880', gasUsed: '0x9c40',
        },
      ],
    }
  }

  // Block 11: Failed transfer — reverted
  if (txHash === fakeTxHash(11, 0)) {
    return {
      type: 'CALL', from: A.alice, to: A.wbtc,
      input: encodeErc20('transfer', [A.bob, 10n * WBTC_UNIT]),
      output: '0x' as Hex,
      value: '0x0', gas: '0xfde8', gasUsed: '0x6d60',
      error: 'execution reverted',
      revertReason: 'ERC20: transfer amount exceeds balance',
    }
  }

  // Generic single-level trace for remaining transactions
  const tx = DEMO_TX_BY_HASH.get(txHash)
  if (!tx) return null

  return {
    type: tx.to ? 'CALL' : 'CREATE',
    from: tx.from,
    to: tx.to,
    input: tx.input,
    output: tx.to ? '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex : '0x6080604052' as Hex,
    value: tx.value === '0' ? '0x0' : `0x${BigInt(tx.value).toString(16)}`,
    gas: `0x${BigInt(tx.gas).toString(16)}`,
    gasUsed: '0xc350',
  }
}

// ── Realistic opcode traces ────────────────────────────────────────────

// ERC-20 transfer: function dispatch → load balance → check → subtract → add → emit LOG3 → return
function erc20TransferOpcodes(contractAddr: string, depth: number, senderSlot: string, recipientSlot: string, amount: string, senderBalance: string): OpcodeEntry[] {
  const ca = contractAddr.toLowerCase()
  const newSenderBal = `0x${(BigInt(senderBalance) - BigInt(amount)).toString(16)}`
  return [
    // Function dispatch
    { pc: 0, op: 'PUSH1', gas: 65000, gasCost: 3, depth, stack: [], address: ca },
    { pc: 2, op: 'PUSH1', gas: 64997, gasCost: 3, depth, stack: ['0x80'], address: ca },
    { pc: 4, op: 'MSTORE', gas: 64994, gasCost: 12, depth, stack: ['0x80', '0x40'], address: ca },
    { pc: 5, op: 'CALLVALUE', gas: 64982, gasCost: 2, depth, stack: [], address: ca },
    { pc: 6, op: 'ISZERO', gas: 64980, gasCost: 3, depth, stack: ['0x0'], address: ca },
    { pc: 7, op: 'PUSH2', gas: 64977, gasCost: 3, depth, stack: ['0x1'], address: ca },
    { pc: 10, op: 'JUMPI', gas: 64974, gasCost: 10, depth, stack: ['0x1', '0x12'], address: ca },
    { pc: 18, op: 'JUMPDEST', gas: 64964, gasCost: 1, depth, stack: [], address: ca },
    { pc: 19, op: 'PUSH1', gas: 64963, gasCost: 3, depth, stack: [], address: ca },
    { pc: 21, op: 'CALLDATASIZE', gas: 64960, gasCost: 2, depth, stack: ['0x4'], address: ca },
    { pc: 22, op: 'LT', gas: 64958, gasCost: 3, depth, stack: ['0x4', '0x44'], address: ca },
    { pc: 23, op: 'PUSH2', gas: 64955, gasCost: 3, depth, stack: ['0x0'], address: ca },
    { pc: 26, op: 'JUMPI', gas: 64952, gasCost: 10, depth, stack: ['0x0', '0x80'], address: ca },
    // Load selector
    { pc: 27, op: 'PUSH1', gas: 64942, gasCost: 3, depth, stack: [], address: ca },
    { pc: 29, op: 'CALLDATALOAD', gas: 64939, gasCost: 3, depth, stack: ['0x0'], address: ca },
    { pc: 30, op: 'PUSH1', gas: 64936, gasCost: 3, depth, stack: ['0xa9059cbb00000000000000000000000000000000000000000000000000000000'], address: ca },
    { pc: 32, op: 'SHR', gas: 64933, gasCost: 3, depth, stack: ['0xa9059cbb00000000000000000000000000000000000000000000000000000000', '0xe0'], address: ca },
    { pc: 33, op: 'DUP1', gas: 64930, gasCost: 3, depth, stack: ['0xa9059cbb'], address: ca },
    { pc: 34, op: 'PUSH4', gas: 64927, gasCost: 3, depth, stack: ['0xa9059cbb', '0xa9059cbb'], address: ca },
    { pc: 39, op: 'EQ', gas: 64924, gasCost: 3, depth, stack: ['0xa9059cbb', '0xa9059cbb', '0xa9059cbb'], address: ca },
    { pc: 40, op: 'PUSH2', gas: 64921, gasCost: 3, depth, stack: ['0x1'], address: ca },
    { pc: 43, op: 'JUMPI', gas: 64918, gasCost: 10, depth, stack: ['0x1', '0x100'], address: ca },
    // _transfer: load sender balance (SLOAD)
    { pc: 256, op: 'JUMPDEST', gas: 64908, gasCost: 1, depth, stack: [], address: ca },
    { pc: 260, op: 'CALLER', gas: 64907, gasCost: 2, depth, stack: [], address: ca },
    { pc: 270, op: 'PUSH32', gas: 64900, gasCost: 3, depth, stack: [], address: ca },
    { pc: 303, op: 'SLOAD', gas: 64897, gasCost: 2100, depth, stack: [senderSlot], address: ca },
    // Check balance >= amount
    { pc: 304, op: 'DUP1', gas: 62797, gasCost: 3, depth, stack: [senderBalance], address: ca },
    { pc: 305, op: 'PUSH32', gas: 62794, gasCost: 3, depth, stack: [senderBalance, senderBalance], address: ca },
    { pc: 338, op: 'DUP2', gas: 62791, gasCost: 3, depth, stack: [senderBalance, amount], address: ca },
    { pc: 339, op: 'LT', gas: 62788, gasCost: 3, depth, stack: [senderBalance, amount, senderBalance], address: ca },
    { pc: 340, op: 'ISZERO', gas: 62785, gasCost: 3, depth, stack: ['0x0'], address: ca },
    { pc: 341, op: 'PUSH2', gas: 62782, gasCost: 3, depth, stack: ['0x1'], address: ca },
    { pc: 344, op: 'JUMPI', gas: 62779, gasCost: 10, depth, stack: ['0x1', '0x180'], address: ca },
    // Subtract from sender
    { pc: 384, op: 'JUMPDEST', gas: 62769, gasCost: 1, depth, stack: [], address: ca },
    { pc: 385, op: 'SUB', gas: 62768, gasCost: 3, depth, stack: [senderBalance, amount], address: ca },
    { pc: 386, op: 'SSTORE', gas: 62765, gasCost: 5000, depth, stack: [senderSlot, newSenderBal], address: ca },
    // Load recipient balance
    { pc: 400, op: 'PUSH32', gas: 57765, gasCost: 3, depth, stack: [], address: ca },
    { pc: 433, op: 'SLOAD', gas: 57762, gasCost: 2100, depth, stack: [recipientSlot], address: ca },
    // Add to recipient
    { pc: 434, op: 'ADD', gas: 55662, gasCost: 3, depth, stack: ['0x0', amount], address: ca },
    { pc: 435, op: 'SSTORE', gas: 55659, gasCost: 20000, depth, stack: [recipientSlot, amount], address: ca },
    // Emit Transfer event (LOG3)
    { pc: 450, op: 'PUSH32', gas: 35659, gasCost: 3, depth, stack: [], address: ca },
    { pc: 483, op: 'PUSH1', gas: 35656, gasCost: 3, depth, stack: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'], address: ca },
    { pc: 485, op: 'PUSH1', gas: 35653, gasCost: 3, depth, stack: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x20'], address: ca },
    { pc: 487, op: 'LOG3', gas: 35650, gasCost: 1756, depth, stack: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x20', '0x80'], address: ca },
    // Return true
    { pc: 500, op: 'PUSH1', gas: 33894, gasCost: 3, depth, stack: [], address: ca },
    { pc: 502, op: 'MSTORE', gas: 33891, gasCost: 3, depth, stack: ['0x1', '0x80'], address: ca },
    { pc: 503, op: 'PUSH1', gas: 33888, gasCost: 3, depth, stack: [], address: ca },
    { pc: 505, op: 'PUSH1', gas: 33885, gasCost: 3, depth, stack: ['0x20'], address: ca },
    { pc: 507, op: 'RETURN', gas: 33882, gasCost: 0, depth, stack: ['0x20', '0x80'], address: ca },
  ]
}

export function getDemoOpcodeTrace(txHash: Hex): { totalGas: number; entries: OpcodeEntry[] } | null {
  const wbtcAddr = A.wbtc.toLowerCase()
  const vaultAddr = A.vault.toLowerCase()

  // Block 8: transfer(bob, 1 WBTC) — full ERC-20 transfer flow
  if (txHash === fakeTxHash(8, 0)) {
    return {
      totalGas: 52000,
      entries: erc20TransferOpcodes(wbtcAddr, 1, '0x3', '0x7', '0x5f5e100', '0x11e1a300'),
    }
  }

  // Block 7: vault.deposit(2 WBTC) — depth 1 vault logic + depth 2 wbtc.transferFrom
  if (txHash === fakeTxHash(7, 0)) {
    const vaultOps: OpcodeEntry[] = [
      // Vault: function dispatch
      { pc: 0, op: 'PUSH1', gas: 120000, gasCost: 3, depth: 1, stack: [], address: vaultAddr },
      { pc: 2, op: 'PUSH1', gas: 119997, gasCost: 3, depth: 1, stack: ['0x80'], address: vaultAddr },
      { pc: 4, op: 'MSTORE', gas: 119994, gasCost: 12, depth: 1, stack: ['0x80', '0x40'], address: vaultAddr },
      { pc: 5, op: 'CALLVALUE', gas: 119982, gasCost: 2, depth: 1, stack: [], address: vaultAddr },
      { pc: 6, op: 'ISZERO', gas: 119980, gasCost: 3, depth: 1, stack: ['0x0'], address: vaultAddr },
      { pc: 10, op: 'JUMPI', gas: 119977, gasCost: 10, depth: 1, stack: ['0x1', '0x12'], address: vaultAddr },
      // Load selector, match deposit(uint256) = 0xb6b55f25
      { pc: 18, op: 'JUMPDEST', gas: 119967, gasCost: 1, depth: 1, stack: [], address: vaultAddr },
      { pc: 19, op: 'CALLDATALOAD', gas: 119966, gasCost: 3, depth: 1, stack: ['0x0'], address: vaultAddr },
      { pc: 20, op: 'PUSH1', gas: 119963, gasCost: 3, depth: 1, stack: ['0xb6b55f2500000000000000000000000000000000000000000000000000000000'], address: vaultAddr },
      { pc: 22, op: 'SHR', gas: 119960, gasCost: 3, depth: 1, stack: ['0xb6b55f2500000000000000000000000000000000000000000000000000000000', '0xe0'], address: vaultAddr },
      { pc: 23, op: 'PUSH4', gas: 119957, gasCost: 3, depth: 1, stack: ['0xb6b55f25'], address: vaultAddr },
      { pc: 28, op: 'EQ', gas: 119954, gasCost: 3, depth: 1, stack: ['0xb6b55f25', '0xb6b55f25'], address: vaultAddr },
      { pc: 29, op: 'PUSH2', gas: 119951, gasCost: 3, depth: 1, stack: ['0x1'], address: vaultAddr },
      { pc: 32, op: 'JUMPI', gas: 119948, gasCost: 10, depth: 1, stack: ['0x1', '0x80'], address: vaultAddr },
      // Load deposit amount from calldata
      { pc: 128, op: 'JUMPDEST', gas: 119938, gasCost: 1, depth: 1, stack: [], address: vaultAddr },
      { pc: 129, op: 'PUSH1', gas: 119937, gasCost: 3, depth: 1, stack: [], address: vaultAddr },
      { pc: 131, op: 'CALLDATALOAD', gas: 119934, gasCost: 3, depth: 1, stack: ['0x4'], address: vaultAddr },
      // Build CALL to wbtc.transferFrom(msg.sender, address(this), amount)
      { pc: 140, op: 'PUSH1', gas: 119500, gasCost: 3, depth: 1, stack: [], address: vaultAddr },
      { pc: 142, op: 'PUSH1', gas: 119497, gasCost: 3, depth: 1, stack: ['0x0'], address: vaultAddr },
      { pc: 160, op: 'CALL', gas: 115000, gasCost: 8700, depth: 1, stack: ['0x0', '0x0', '0x0', '0x64', '0x80', '0x20', '0x0'], address: vaultAddr },
    ]

    // Depth 2: inside WBTC.transferFrom — full ERC-20 execution
    const wbtcOps = erc20TransferOpcodes(wbtcAddr, 2, '0x5', '0xa', '0xbebc200', '0x1dcd6500')

    // Back to vault: update depositor balance, emit Deposit
    const vaultFinish: OpcodeEntry[] = [
      { pc: 161, op: 'ISZERO', gas: 55000, gasCost: 3, depth: 1, stack: ['0x1'], address: vaultAddr },
      { pc: 162, op: 'PUSH2', gas: 54997, gasCost: 3, depth: 1, stack: ['0x0'], address: vaultAddr },
      // Load depositor shares
      { pc: 170, op: 'SLOAD', gas: 54990, gasCost: 2100, depth: 1, stack: ['0x1'], address: vaultAddr },
      { pc: 171, op: 'ADD', gas: 52890, gasCost: 3, depth: 1, stack: ['0x0', '0xbebc200'], address: vaultAddr },
      { pc: 172, op: 'SSTORE', gas: 52887, gasCost: 20000, depth: 1, stack: ['0x1', '0xbebc200'], address: vaultAddr },
      // Emit Deposit event (LOG2)
      { pc: 180, op: 'PUSH32', gas: 32887, gasCost: 3, depth: 1, stack: [], address: vaultAddr },
      { pc: 213, op: 'LOG2', gas: 32884, gasCost: 1125, depth: 1, stack: ['0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c', '0x20', '0x80'], address: vaultAddr },
      { pc: 220, op: 'STOP', gas: 31759, gasCost: 0, depth: 1, stack: [], address: vaultAddr },
    ]

    return {
      totalGas: 95000,
      entries: [...vaultOps, ...wbtcOps, ...vaultFinish],
    }
  }

  // Block 11: Failed transfer — REVERT after balance check
  if (txHash === fakeTxHash(11, 0)) {
    return {
      totalGas: 28000,
      entries: [
        { pc: 0, op: 'PUSH1', gas: 65000, gasCost: 3, depth: 1, stack: [], address: wbtcAddr },
        { pc: 2, op: 'PUSH1', gas: 64997, gasCost: 3, depth: 1, stack: ['0x80'], address: wbtcAddr },
        { pc: 4, op: 'MSTORE', gas: 64994, gasCost: 12, depth: 1, stack: ['0x80', '0x40'], address: wbtcAddr },
        { pc: 5, op: 'CALLVALUE', gas: 64982, gasCost: 2, depth: 1, stack: [], address: wbtcAddr },
        { pc: 6, op: 'ISZERO', gas: 64980, gasCost: 3, depth: 1, stack: ['0x0'], address: wbtcAddr },
        { pc: 7, op: 'PUSH2', gas: 64977, gasCost: 3, depth: 1, stack: ['0x1'], address: wbtcAddr },
        { pc: 10, op: 'JUMPI', gas: 64974, gasCost: 10, depth: 1, stack: ['0x1', '0x12'], address: wbtcAddr },
        { pc: 18, op: 'JUMPDEST', gas: 64964, gasCost: 1, depth: 1, stack: [], address: wbtcAddr },
        // Selector dispatch
        { pc: 19, op: 'CALLDATALOAD', gas: 64963, gasCost: 3, depth: 1, stack: ['0x0'], address: wbtcAddr },
        { pc: 20, op: 'PUSH1', gas: 64960, gasCost: 3, depth: 1, stack: ['0xa9059cbb00000000000000000000000000000000000000000000000000000000'], address: wbtcAddr },
        { pc: 22, op: 'SHR', gas: 64957, gasCost: 3, depth: 1, stack: ['0xa9059cbb00000000000000000000000000000000000000000000000000000000', '0xe0'], address: wbtcAddr },
        { pc: 23, op: 'PUSH4', gas: 64954, gasCost: 3, depth: 1, stack: ['0xa9059cbb'], address: wbtcAddr },
        { pc: 28, op: 'EQ', gas: 64951, gasCost: 3, depth: 1, stack: ['0xa9059cbb', '0xa9059cbb'], address: wbtcAddr },
        { pc: 29, op: 'PUSH2', gas: 64948, gasCost: 3, depth: 1, stack: ['0x1'], address: wbtcAddr },
        { pc: 32, op: 'JUMPI', gas: 64945, gasCost: 10, depth: 1, stack: ['0x1', '0x100'], address: wbtcAddr },
        // Load sender balance
        { pc: 256, op: 'JUMPDEST', gas: 64935, gasCost: 1, depth: 1, stack: [], address: wbtcAddr },
        { pc: 260, op: 'CALLER', gas: 64934, gasCost: 2, depth: 1, stack: [], address: wbtcAddr },
        { pc: 303, op: 'SLOAD', gas: 64930, gasCost: 2100, depth: 1, stack: ['0x3'], address: wbtcAddr },
        // balance = 0xbebc200 (2 WBTC), amount = 0x3b9aca00 (10 WBTC) → balance < amount!
        { pc: 304, op: 'DUP1', gas: 62830, gasCost: 3, depth: 1, stack: ['0xbebc200'], address: wbtcAddr },
        { pc: 305, op: 'PUSH32', gas: 62827, gasCost: 3, depth: 1, stack: ['0xbebc200', '0xbebc200'], address: wbtcAddr },
        { pc: 338, op: 'DUP2', gas: 62824, gasCost: 3, depth: 1, stack: ['0xbebc200', '0x3b9aca00'], address: wbtcAddr },
        { pc: 339, op: 'LT', gas: 62821, gasCost: 3, depth: 1, stack: ['0xbebc200', '0x3b9aca00', '0xbebc200'], address: wbtcAddr },
        { pc: 340, op: 'ISZERO', gas: 62818, gasCost: 3, depth: 1, stack: ['0x1'], address: wbtcAddr },
        { pc: 341, op: 'PUSH2', gas: 62815, gasCost: 3, depth: 1, stack: ['0x0'], address: wbtcAddr },
        // balance < amount → ISZERO returns 0 → no jump → falls through to REVERT
        { pc: 344, op: 'JUMPI', gas: 62812, gasCost: 10, depth: 1, stack: ['0x0', '0x180'], address: wbtcAddr },
        // Prepare revert data: "ERC20: transfer amount exceeds balance"
        { pc: 345, op: 'PUSH32', gas: 62802, gasCost: 3, depth: 1, stack: [], address: wbtcAddr },
        { pc: 378, op: 'PUSH1', gas: 62799, gasCost: 3, depth: 1, stack: ['0x08c379a000000000000000000000000000000000000000000000000000000000'], address: wbtcAddr },
        { pc: 380, op: 'MSTORE', gas: 62796, gasCost: 6, depth: 1, stack: ['0x08c379a000000000000000000000000000000000000000000000000000000000', '0x80'], address: wbtcAddr },
        { pc: 395, op: 'REVERT', gas: 37000, gasCost: 0, depth: 1, stack: ['0x64', '0x80'], address: wbtcAddr },
      ],
    }
  }

  // Block 9: Router swap — multi-depth trace
  if (txHash === fakeTxHash(9, 0)) {
    const routerAddr = A.router.toLowerCase()
    const routerDispatch: OpcodeEntry[] = [
      { pc: 0, op: 'PUSH1', gas: 250000, gasCost: 3, depth: 1, stack: [], address: routerAddr },
      { pc: 2, op: 'PUSH1', gas: 249997, gasCost: 3, depth: 1, stack: ['0x80'], address: routerAddr },
      { pc: 4, op: 'MSTORE', gas: 249994, gasCost: 12, depth: 1, stack: ['0x80', '0x40'], address: routerAddr },
      { pc: 5, op: 'CALLVALUE', gas: 249982, gasCost: 2, depth: 1, stack: [], address: routerAddr },
      { pc: 6, op: 'ISZERO', gas: 249980, gasCost: 3, depth: 1, stack: ['0x0'], address: routerAddr },
      { pc: 10, op: 'JUMPI', gas: 249977, gasCost: 10, depth: 1, stack: ['0x1', '0x12'], address: routerAddr },
      { pc: 18, op: 'JUMPDEST', gas: 249967, gasCost: 1, depth: 1, stack: [], address: routerAddr },
      { pc: 19, op: 'CALLDATALOAD', gas: 249966, gasCost: 3, depth: 1, stack: ['0x0'], address: routerAddr },
      { pc: 20, op: 'PUSH1', gas: 249963, gasCost: 3, depth: 1, stack: ['0x38ed173900000000000000000000000000000000000000000000000000000000'], address: routerAddr },
      { pc: 22, op: 'SHR', gas: 249960, gasCost: 3, depth: 1, stack: ['0x38ed173900000000000000000000000000000000000000000000000000000000', '0xe0'], address: routerAddr },
    ]
    // Router calls wbtc.transferFrom(bob, router)
    const call1: OpcodeEntry[] = [
      { pc: 100, op: 'PUSH1', gas: 230000, gasCost: 3, depth: 1, stack: [], address: routerAddr },
      { pc: 110, op: 'CALL', gas: 225000, gasCost: 8700, depth: 1, stack: ['0x0', '0x0', '0x0', '0x64', '0x80', '0x20', '0x0'], address: routerAddr },
    ]
    const wbtcTransfer1 = erc20TransferOpcodes(wbtcAddr, 2, '0x7', '0xc', '0xbebc200', '0x17d78400')
    // Router calls vault.deposit(2 WBTC)
    const call2: OpcodeEntry[] = [
      { pc: 111, op: 'ISZERO', gas: 170000, gasCost: 3, depth: 1, stack: ['0x1'], address: routerAddr },
      { pc: 200, op: 'CALL', gas: 165000, gasCost: 8700, depth: 1, stack: ['0x0', '0x0', '0x0', '0x24', '0x100', '0x0', '0x0'], address: routerAddr },
    ]
    // Depth 2: vault.deposit
    const vaultDeposit: OpcodeEntry[] = [
      { pc: 0, op: 'PUSH1', gas: 150000, gasCost: 3, depth: 2, stack: [], address: vaultAddr },
      { pc: 2, op: 'PUSH1', gas: 149997, gasCost: 3, depth: 2, stack: ['0x80'], address: vaultAddr },
      { pc: 4, op: 'MSTORE', gas: 149994, gasCost: 12, depth: 2, stack: ['0x80', '0x40'], address: vaultAddr },
      { pc: 50, op: 'CALLDATALOAD', gas: 149500, gasCost: 3, depth: 2, stack: ['0x4'], address: vaultAddr },
      { pc: 60, op: 'CALL', gas: 145000, gasCost: 8700, depth: 2, stack: ['0x0', '0x0', '0x0', '0x64', '0x80', '0x20', '0x0'], address: vaultAddr },
    ]
    // Depth 3: wbtc.transferFrom inside vault.deposit
    const wbtcTransfer2 = erc20TransferOpcodes(wbtcAddr, 3, '0xc', '0xa', '0xbebc200', '0xbebc200')
    // Vault finish
    const vaultFinish: OpcodeEntry[] = [
      { pc: 61, op: 'SLOAD', gas: 90000, gasCost: 2100, depth: 2, stack: ['0x2'], address: vaultAddr },
      { pc: 62, op: 'ADD', gas: 87900, gasCost: 3, depth: 2, stack: ['0xbebc200', '0xbebc200'], address: vaultAddr },
      { pc: 63, op: 'SSTORE', gas: 87897, gasCost: 5000, depth: 2, stack: ['0x2', '0x17d78400'], address: vaultAddr },
      { pc: 70, op: 'LOG2', gas: 82897, gasCost: 1125, depth: 2, stack: ['0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c', '0x20', '0x80'], address: vaultAddr },
      { pc: 80, op: 'STOP', gas: 81772, gasCost: 0, depth: 2, stack: [], address: vaultAddr },
    ]
    // Router finish
    const routerFinish: OpcodeEntry[] = [
      { pc: 201, op: 'ISZERO', gas: 75000, gasCost: 3, depth: 1, stack: ['0x1'], address: routerAddr },
      { pc: 210, op: 'LOG3', gas: 74000, gasCost: 1756, depth: 1, stack: ['0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822', '0x40', '0x80'], address: routerAddr },
      { pc: 220, op: 'STOP', gas: 72244, gasCost: 0, depth: 1, stack: [], address: routerAddr },
    ]

    return {
      totalGas: 175000,
      entries: [...routerDispatch, ...call1, ...wbtcTransfer1, ...call2, ...vaultDeposit, ...wbtcTransfer2, ...vaultFinish, ...routerFinish],
    }
  }

  // Minimal trace for other transactions
  return {
    totalGas: 21000,
    entries: [
      { pc: 0, op: 'PUSH1', gas: 65000, gasCost: 3, depth: 1, stack: [] },
      { pc: 2, op: 'PUSH1', gas: 64997, gasCost: 3, depth: 1, stack: ['0x80'] },
      { pc: 4, op: 'MSTORE', gas: 64994, gasCost: 12, depth: 1, stack: ['0x80', '0x40'] },
      { pc: 5, op: 'STOP', gas: 64982, gasCost: 0, depth: 1, stack: [] },
    ],
  }
}

// ── Chain meta / stats ─────────────────────────────────────────────────

export function createDemoChainMeta(): ChainMeta {
  return {
    chainId: 31337,
    clientVersion: 'anvil/v0.2.0 (demo)',
    latestBlockNumber: 12,
    latestIndexedBlock: 12,
    latestIndexedHash: fakeHash(12),
    rpcUrl: 'demo://anvil-explorer',
    syncedAt: Date.now(),
    forkConfig: null,
  }
}

export function createDemoStats(): ExplorerStats {
  return {
    blockCount: 13,
    transactionCount: 14,
    logCount: 13,
    latestBlockNumber: 12,
  }
}

// ── Address classification ─────────────────────────────────────────────

const DEMO_CONTRACTS = new Set<string>([
  A.wbtc.toLowerCase(),
  A.vault.toLowerCase(),
  A.router.toLowerCase(),
])

export function isDemoContract(address: string): boolean {
  return DEMO_CONTRACTS.has(address.toLowerCase())
}
