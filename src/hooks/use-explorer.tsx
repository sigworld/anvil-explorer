import { createContext } from 'preact'
import type { ComponentChildren } from 'preact'
import { useContext } from 'preact/hooks'
import { useEffect, useState } from 'preact/hooks'
import { DEFAULT_ABI_API_URL, syncUploadedAbis } from '../lib/abi-api.ts'
import {
  getExplorerStats,
  resetExplorerData,
} from '../lib/db.ts'
import { createLogger } from '../lib/logger.ts'
import {
  createAnvilClient,
  createSnapshot,
  getTrace,
  mineBlocks,
  revertSnapshot,
  setBalance,
} from '../lib/rpc.ts'
import { syncChain, type SyncProgress } from '../lib/sync.ts'
import type { ChainMeta, ExplorerStats, ExplorerStatus } from '../lib/types.ts'

type ExplorerContextValue = {
  chainMeta: ChainMeta | null
  abiApiUrl: string
  error: string | null
  refreshKey: number
  rpcUrl: string
  setAbiApiUrl: (value: string) => void
  setRpcUrl: (value: string) => void
  snapshots: string[]
  status: ExplorerStatus
  stats: ExplorerStats
  statusMessage: string
  actions: {
    reconnect: () => void
    refresh: () => void
    resetData: () => Promise<void>
    loadTrace: (txHash: `0x${string}`) => Promise<unknown>
    mineBlocks: (count: number) => Promise<void>
    setBalance: (address: string, amountEth: string) => Promise<void>
    createSnapshot: () => Promise<string>
    revertSnapshot: (snapshotId: string) => Promise<boolean>
  }
}

const STORAGE_KEY = 'anvil-explorer.rpc-url'
const ABI_API_STORAGE_KEY = 'anvil-explorer.abi-api-url'
const DEFAULT_URL = 'http://127.0.0.1:8545'
const EMPTY_STATS: ExplorerStats = {
  blockCount: 0,
  transactionCount: 0,
  logCount: 0,
  latestBlockNumber: null,
}

const logger = createLogger('app')

const ExplorerContext = createContext<ExplorerContextValue | null>(null)

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
    left.rpcUrl === right.rpcUrl
  )
}

export function ExplorerProvider(props: { children: ComponentChildren }) {
  const [rpcUrl, setRpcUrl] = useState(() => window.localStorage.getItem(STORAGE_KEY) ?? DEFAULT_URL)
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

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, rpcUrl)
  }, [rpcUrl])

  useEffect(() => {
    window.localStorage.setItem(ABI_API_STORAGE_KEY, abiApiUrl)
  }, [abiApiUrl])

  useEffect(() => {
    let cancelled = false
    const client = createAnvilClient(rpcUrl)
    let hasConnectedOnce = false

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
          const result = await syncChain(client, rpcUrl, applyProgress)

          if (cancelled) {
            return
          }

          setChainMeta((current) => (areChainMetaEqual(current, result.meta) ? current : result.meta))
          await loadStats(result.changed)
          hasConnectedOnce = true
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

          const message =
            caughtError instanceof Error ? caughtError.message : 'Failed to connect to Anvil'
          setError(message)
          setStatus('error')
          setStatusMessage('Waiting to reconnect')
          logger.error('Sync cycle failed', caughtError)
        }

        await wait(2000)
      }
    }

    run()

    return () => {
      cancelled = true
    }
  }, [rpcUrl, connectionVersion])

  useEffect(() => {
    let cancelled = false

    async function run() {
      while (!cancelled) {
        const changed = await syncUploadedAbis(abiApiUrl)

        if (cancelled) {
          return
        }

        if (changed) {
          setRefreshKey((current) => current + 1)
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

  const value: ExplorerContextValue = {
    abiApiUrl,
    chainMeta,
    error,
    refreshKey,
    rpcUrl,
    setAbiApiUrl,
    setRpcUrl,
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
        setConnectionVersion((current) => current + 1)
      },
      async loadTrace(txHash) {
        const client = createAnvilClient(rpcUrl)
        return getTrace(client, txHash)
      },
      async mineBlocks(count) {
        await runAction(async () => {
          const client = createAnvilClient(rpcUrl)
          await mineBlocks(client, count)
        })
      },
      async setBalance(address, amountEth) {
        await runAction(async () => {
          const client = createAnvilClient(rpcUrl)
          await setBalance(client, address, amountEth)
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
