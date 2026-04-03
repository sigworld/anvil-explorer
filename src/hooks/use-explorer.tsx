import { createContext } from 'preact'
import type { ComponentChildren } from 'preact'
import { useContext } from 'preact/hooks'
import { useEffect, useState } from 'preact/hooks'
import { DEFAULT_ABI_API_URL, syncUploadedAbis } from '../lib/abi-api.ts'
import {
  getExplorerStats,
  resetExplorerData,
  resetAllExplorerData,
  setActiveChainScope,
} from '../lib/db.ts'
import { createLogger } from '../lib/logger.ts'
import {
  createAnvilClient,
  createSnapshot,
  dealErc20,
  getOpcodeTrace,
  getTrace,
  mineBlocks,
  mintNativeBalance,
  revertSnapshot,
  type OpcodeTraceOptions,
} from '../lib/rpc.ts'
import { syncChain, type SyncProgress } from '../lib/sync.ts'
import type { ChainMeta, ExplorerEndpoint, ExplorerStats, ExplorerStatus, OpcodeTrace } from '../lib/types.ts'

type ExplorerContextValue = {
  activeEndpointId: string
  endpoints: ExplorerEndpoint[]
  chainMeta: ChainMeta | null
  abiApiUrl: string
  error: string | null
  refreshKey: number
  rpcUrl: string
  startBlock: number | null
  setActiveEndpointId: (id: string) => void
  setAbiApiUrl: (value: string) => void
  saveEndpoint: (input: { id?: string; name: string; rpcUrl: string; startBlock: number | null; color?: string }) => string
  deleteEndpoint: (id: string) => void
  snapshots: string[]
  status: ExplorerStatus
  stats: ExplorerStats
  statusMessage: string
  actions: {
    reconnect: () => void
    refresh: () => void
    resetData: () => Promise<void>
    resetAllData: () => Promise<void>
    loadTrace: (txHash: `0x${string}`) => Promise<unknown>
    loadOpcodeTrace: (txHash: `0x${string}`, options?: OpcodeTraceOptions) => Promise<OpcodeTrace>
    mineBlocks: (count: number) => Promise<void>
    mintNativeBalance: (address: string, amountEth: string) => Promise<void>
    dealErc20: (tokenAddress: string, recipientAddress: string, amount: bigint) => Promise<void>
    createSnapshot: () => Promise<string>
    revertSnapshot: (snapshotId: string) => Promise<boolean>
  }
}

const ENDPOINTS_STORAGE_KEY = 'anvil-explorer.endpoints'
const ACTIVE_ENDPOINT_STORAGE_KEY = 'anvil-explorer.active-endpoint-id'
const LEGACY_RPC_STORAGE_KEY = 'anvil-explorer.rpc-url'
const ABI_API_STORAGE_KEY = 'anvil-explorer.abi-api-url'
const LEGACY_START_BLOCK_STORAGE_KEY = 'anvil-explorer.start-block'
const DEFAULT_URL = 'http://127.0.0.1:8545'
const DEFAULT_ENDPOINT_ID = 'local-default'
const EMPTY_STATS: ExplorerStats = {
  blockCount: 0,
  transactionCount: 0,
  logCount: 0,
  latestBlockNumber: null,
}

const logger = createLogger('app')

const ExplorerContext = createContext<ExplorerContextValue | null>(null)

const ENDPOINT_COLORS = [
  'hsl(210 70% 90%)', 'hsl(150 70% 90%)', 'hsl(30 70% 90%)',
  'hsl(330 70% 90%)', 'hsl(270 70% 90%)', 'hsl(60 70% 90%)',
  'hsl(180 70% 90%)', 'hsl(0 70% 90%)', 'hsl(120 70% 90%)',
  'hsl(300 70% 90%)',
]

function pickColor(index: number): string {
  return ENDPOINT_COLORS[index % ENDPOINT_COLORS.length]
}

function createDefaultEndpoint(): ExplorerEndpoint {
  return { id: DEFAULT_ENDPOINT_ID, name: 'Local Anvil', rpcUrl: DEFAULT_URL, startBlock: null, color: ENDPOINT_COLORS[0] }
}

function parseStoredStartBlock(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function readInitialEndpoints(): ExplorerEndpoint[] {
  const fallback = [createDefaultEndpoint()]
  const stored = window.localStorage.getItem(ENDPOINTS_STORAGE_KEY)

  if (stored) {
    try {
      const parsed = JSON.parse(stored)
      if (!Array.isArray(parsed)) return fallback

      const endpoints = parsed
        .map((item: any, index: number) => {
          if (!item || typeof item !== 'object') return null
          const rpcUrl = typeof item.rpcUrl === 'string' ? item.rpcUrl.trim() : ''
          if (!rpcUrl) return null
          return {
            id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `endpoint-${index + 1}`,
            name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : `Endpoint ${index + 1}`,
            rpcUrl,
            startBlock: typeof item.startBlock === 'number' && Number.isFinite(item.startBlock) && item.startBlock >= 0 ? item.startBlock : null,
            color: typeof item.color === 'string' && item.color.trim() ? item.color.trim() : pickColor(index),
          } as ExplorerEndpoint
        })
        .filter((item: ExplorerEndpoint | null): item is ExplorerEndpoint => item !== null)

      return endpoints.length > 0 ? endpoints : fallback
    } catch {
      return fallback
    }
  }

  const legacyRpcUrl = window.localStorage.getItem(LEGACY_RPC_STORAGE_KEY)?.trim() ?? ''
  const legacyStartBlock = parseStoredStartBlock(window.localStorage.getItem(LEGACY_START_BLOCK_STORAGE_KEY))

  if (!legacyRpcUrl) return fallback

  return [{
    id: DEFAULT_ENDPOINT_ID,
    name: legacyRpcUrl === DEFAULT_URL ? 'Local Anvil' : 'Primary Endpoint',
    rpcUrl: legacyRpcUrl,
    startBlock: legacyStartBlock,
    color: ENDPOINT_COLORS[0],
  }]
}

function createEndpointScopeKey(endpoint: ExplorerEndpoint) {
  return `${endpoint.id}::${endpoint.rpcUrl.trim().toLowerCase()}`
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function areStatsEqual(left: ExplorerStats, right: ExplorerStats) {
  return (
    left.blockCount === right.blockCount &&
    left.transactionCount === right.transactionCount &&
    left.logCount === right.logCount &&
    left.latestBlockNumber === right.latestBlockNumber
  )
}

function areChainMetaEqual(left: ChainMeta | null, right: ChainMeta | null) {
  if (left === right) {
    return true
  }

  if (!left || !right) {
    return false
  }

  return (
    left.chainId === right.chainId &&
    left.clientVersion === right.clientVersion &&
    left.latestBlockNumber === right.latestBlockNumber &&
    left.latestIndexedBlock === right.latestIndexedBlock &&
    left.latestIndexedHash === right.latestIndexedHash &&
    left.rpcUrl === right.rpcUrl &&
    left.forkConfig?.forkBlockNumber === right.forkConfig?.forkBlockNumber
  )
}

export function ExplorerProvider(props: { children: ComponentChildren }) {
  const [endpoints, setEndpoints] = useState<ExplorerEndpoint[]>(readInitialEndpoints)
  const [activeEndpointId, setActiveEndpointIdState] = useState(() => {
    const stored = window.localStorage.getItem(ACTIVE_ENDPOINT_STORAGE_KEY)
    const initial = readInitialEndpoints()
    return stored && initial.some((ep) => ep.id === stored) ? stored : initial[0].id
  })
  const [abiApiUrl, setAbiApiUrl] = useState(
    () => window.localStorage.getItem(ABI_API_STORAGE_KEY) ?? DEFAULT_ABI_API_URL,
  )
  const [status, setStatus] = useState<ExplorerStatus>('idle')
  const [statusMessage, setStatusMessage] = useState('Waiting to connect')
  const [error, setError] = useState<string | null>(null)
  const [chainMeta, setChainMeta] = useState<ChainMeta | null>(null)
  const [stats, setStats] = useState<ExplorerStats>(EMPTY_STATS)
  const [refreshKey, setRefreshKey] = useState(0)
  const [snapshots, setSnapshots] = useState<string[]>([])
  const [connectionVersion, setConnectionVersion] = useState(0)

  const activeEndpoint = endpoints.find((ep) => ep.id === activeEndpointId) ?? endpoints[0] ?? createDefaultEndpoint()
  const rpcUrl = activeEndpoint.rpcUrl
  const startBlock = activeEndpoint.startBlock
  const activeScopeKey = createEndpointScopeKey(activeEndpoint)

  useEffect(() => {
    setActiveChainScope(activeScopeKey)
  }, [activeScopeKey])

  useEffect(() => {
    window.localStorage.setItem(ENDPOINTS_STORAGE_KEY, JSON.stringify(endpoints))
    window.localStorage.removeItem(LEGACY_RPC_STORAGE_KEY)
    window.localStorage.removeItem(LEGACY_START_BLOCK_STORAGE_KEY)
  }, [endpoints])

  useEffect(() => {
    window.localStorage.setItem(ACTIVE_ENDPOINT_STORAGE_KEY, activeEndpointId)
  }, [activeEndpointId])

  useEffect(() => {
    window.localStorage.setItem(ABI_API_STORAGE_KEY, abiApiUrl)
  }, [abiApiUrl])

  useEffect(() => {
    let cancelled = false
    const client = createAnvilClient(rpcUrl)
    let hasConnectedOnce = false
    let consecutiveFailures = 0
    const MAX_CONSECUTIVE_FAILURES = 5

    function applyProgress(progress: SyncProgress) {
      if (cancelled) {
        return
      }

      if (!hasConnectedOnce) {
        setStatus(progress.phase === 'ready' ? 'ready' : progress.phase)
        setStatusMessage(progress.message)
        return
      }

      if (progress.phase === 'syncing') {
        setStatus('syncing')
        setStatusMessage(progress.message)
      }
    }

    async function loadStats(bumpRefreshKey: boolean) {
      const nextStats = await getExplorerStats()

      if (cancelled) {
        return
      }

      setStats((current) => (areStatsEqual(current, nextStats) ? current : nextStats))

      if (bumpRefreshKey) {
        setRefreshKey((current) => current + 1)
      }
    }

    async function run() {
      while (!cancelled) {
        try {
          setError(null)
          const result = await syncChain(client, rpcUrl, startBlock, applyProgress)

          if (cancelled) {
            return
          }

          setChainMeta((current) => (areChainMetaEqual(current, result.meta) ? current : result.meta))
          await loadStats(result.changed)
          hasConnectedOnce = true
          consecutiveFailures = 0
          setStatus('ready')
          setStatusMessage(
            result.changed
              ? `Indexed through block ${result.meta.latestIndexedBlock}`
              : `Watching block ${result.meta.latestBlockNumber}`,
          )
        } catch (caughtError: unknown) {
          if (cancelled) {
            return
          }

          consecutiveFailures++
          const message =
            caughtError instanceof Error ? caughtError.message : 'Failed to connect to Anvil'
          setError(message)
          setStatus('error')
          logger.error('Sync cycle failed', caughtError)

          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            setStatusMessage('Connection failed — use Reconnect to retry')
            return
          }

          setStatusMessage('Waiting to reconnect')
        }

        await wait(2000)
      }
    }

    run()

    return () => {
      cancelled = true
    }
  }, [activeScopeKey, rpcUrl, startBlock, connectionVersion])

  useEffect(() => {
    let cancelled = false
    let consecutiveFailures = 0
    const MAX_CONSECUTIVE_FAILURES = 5

    if (!abiApiUrl.trim()) {
      return
    }

    async function run() {
      while (!cancelled) {
        try {
          const changed = await syncUploadedAbis(abiApiUrl)

          if (cancelled) {
            return
          }

          consecutiveFailures = 0

          if (changed) {
            setRefreshKey((current) => current + 1)
          }
        } catch {
          consecutiveFailures++
          logger.warn(`ABI endpoint failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`)

          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            logger.warn('ABI endpoint polling stopped — save endpoint to retry')
            return
          }
        }

        await wait(3000)
      }
    }

    run()

    return () => {
      cancelled = true
    }
  }, [abiApiUrl])

  async function runAction(action: () => Promise<void>) {
    setStatus('syncing')
    setError(null)

    try {
      await action()
      setConnectionVersion((current) => current + 1)
    } catch (caughtError: unknown) {
      const message = caughtError instanceof Error ? caughtError.message : 'RPC action failed'
      setError(message)
      setStatus('error')
      throw caughtError
    }
  }

  function switchEndpoint(nextId: string) {
    if (!endpoints.some((ep) => ep.id === nextId) || nextId === activeEndpointId) return
    setSnapshots([])
    setChainMeta(null)
    setStats(EMPTY_STATS)
    setError(null)
    setStatus('idle')
    setStatusMessage('Waiting to connect')
    setActiveEndpointIdState(nextId)
    setConnectionVersion((current) => current + 1)
  }

  function saveEndpoint(input: { id?: string; name: string; rpcUrl: string; startBlock: number | null; color?: string }) {
    const rpc = input.rpcUrl.trim()
    const name = input.name.trim()
    if (!rpc) throw new Error('RPC URL is required')

    const endpointId = input.id?.trim() || `endpoint-${Date.now()}`

    // Preserve existing color, use provided color, or pick a new one
    const existing = endpoints.find((ep) => ep.id === endpointId)
    const color = input.color ?? existing?.color ?? pickColor(endpoints.length)

    const nextEndpoint: ExplorerEndpoint = {
      id: endpointId,
      name: name || 'Untitled Endpoint',
      rpcUrl: rpc,
      startBlock: input.startBlock,
      color,
    }

    setEndpoints((current) => {
      const existingIndex = current.findIndex((ep) => ep.id === endpointId)
      if (existingIndex === -1) return [...current, nextEndpoint]
      return current.map((ep) => (ep.id === endpointId ? nextEndpoint : ep))
    })

    if (endpointId === activeEndpointId) {
      setConnectionVersion((current) => current + 1)
    }

    return endpointId
  }

  function deleteEndpoint(endpointId: string) {
    if (endpoints.length <= 1) throw new Error('At least one endpoint must remain')

    const nextActiveId = endpointId === activeEndpointId
      ? endpoints.find((ep) => ep.id !== endpointId)?.id
      : activeEndpointId

    setEndpoints((current) => current.filter((ep) => ep.id !== endpointId))

    if (endpointId === activeEndpointId && nextActiveId) {
      switchEndpoint(nextActiveId)
    }
  }

  const value: ExplorerContextValue = {
    activeEndpointId,
    endpoints,
    abiApiUrl,
    chainMeta,
    error,
    refreshKey,
    rpcUrl,
    startBlock,
    setActiveEndpointId: switchEndpoint,
    setAbiApiUrl,
    saveEndpoint,
    deleteEndpoint,
    snapshots,
    status,
    stats,
    statusMessage,
    actions: {
      reconnect() {
        setConnectionVersion((current) => current + 1)
      },
      refresh() {
        setRefreshKey((current) => current + 1)
      },
      async resetData() {
        await resetExplorerData()
        setSnapshots([])
        setRefreshKey((current) => current + 1)
        setChainMeta(null)
        setStats(EMPTY_STATS)
        setError(null)
        setStatus('idle')
        setStatusMessage('Waiting to connect')
        setConnectionVersion((current) => current + 1)
      },
      async resetAllData() {
        await resetAllExplorerData()
        setSnapshots([])
        setRefreshKey((current) => current + 1)
        setChainMeta(null)
        setStats(EMPTY_STATS)
        setError(null)
        setStatus('idle')
        setStatusMessage('Waiting to connect')
        setConnectionVersion((current) => current + 1)
      },
      async loadTrace(txHash) {
        const client = createAnvilClient(rpcUrl)
        return getTrace(client, txHash)
      },
      async loadOpcodeTrace(txHash, options) {
        const client = createAnvilClient(rpcUrl)
        return getOpcodeTrace(client, txHash, options)
      },
      async mineBlocks(count) {
        await runAction(async () => {
          const client = createAnvilClient(rpcUrl)
          await mineBlocks(client, count)
        })
      },
      async mintNativeBalance(address, amountEth) {
        await runAction(async () => {
          const client = createAnvilClient(rpcUrl)
          await mintNativeBalance(client, address, amountEth)
        })
      },
      async dealErc20(tokenAddress, recipientAddress, amount) {
        await runAction(async () => {
          const client = createAnvilClient(rpcUrl)
          await dealErc20(client, tokenAddress, recipientAddress, amount)
        })
      },
      async createSnapshot() {
        const client = createAnvilClient(rpcUrl)
        const snapshotId = await createSnapshot(client)
        setSnapshots((current) => [snapshotId, ...current])
        return snapshotId
      },
      async revertSnapshot(snapshotId) {
        const client = createAnvilClient(rpcUrl)
        const reverted = await revertSnapshot(client, snapshotId)

        if (reverted) {
          setSnapshots((current) => current.filter((item) => item !== snapshotId))
          setConnectionVersion((current) => current + 1)
        }

        return reverted
      },
    },
  }

  return <ExplorerContext.Provider value={value}>{props.children}</ExplorerContext.Provider>
}

export function useExplorer() {
  const context = useContext(ExplorerContext)

  if (!context) {
    throw new Error('useExplorer must be used inside ExplorerProvider')
  }

  return context
}
