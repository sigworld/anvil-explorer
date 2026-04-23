import {
  getDb,
  putChainMeta,
  setActiveChainScope,
  storeBlockBundle,
} from './db.ts'
import {
  createDemoAbis,
  createDemoBlocks,
  createDemoChainMeta,
  createDemoLogs,
  createDemoReceipts,
  createDemoTransactions,
} from './demo-data.ts'
import type { ExplorerEndpoint } from './types.ts'

export const DEMO_ENDPOINT_ID = '__demo__'
export const DEMO_RPC_URL = 'demo://anvil-explorer'
export const DEMO_ENDPOINT: ExplorerEndpoint = {
  id: DEMO_ENDPOINT_ID,
  name: 'Demo Mode',
  rpcUrl: DEMO_RPC_URL,
  startBlock: null,
  color: 'hsl(45 90% 88%)',
}

export function isDemoMode(endpointId: string): boolean {
  return endpointId === DEMO_ENDPOINT_ID
}

export function isDemoUrl(): boolean {
  return new URLSearchParams(window.location.search).has('demo')
}

export function clearDemoParam() {
  const url = new URL(window.location.href)
  url.searchParams.delete('demo')
  window.history.replaceState({}, '', url.toString())
}

/**
 * Seeds IndexedDB with demo data if not already seeded for this scope.
 */
export async function seedDemoData(): Promise<void> {
  const scopeKey = `${DEMO_ENDPOINT_ID}::${DEMO_RPC_URL.trim().toLowerCase()}`
  setActiveChainScope(scopeKey)

  const db = await getDb()
  const blockCount = await db.count('blocks')
  if (blockCount > 0) return

  const blocks = createDemoBlocks()
  const transactions = createDemoTransactions()
  const receipts = createDemoReceipts()
  const logs = createDemoLogs()

  for (const block of blocks) {
    const blockTxs = transactions.filter((tx) => tx.blockNumber === block.number)
    const blockReceipts = receipts.filter((r) => r.blockNumber === block.number)
    const blockLogs = logs.filter((l) => l.blockNumber === block.number)
    await storeBlockBundle(block, blockTxs, blockReceipts, blockLogs)
  }

  // Seed ABIs so calldata and log decoding works
  const abis = createDemoAbis()
  await Promise.all(abis.map((abi) => db.put('abis', abi)))

  await putChainMeta(createDemoChainMeta())
}
