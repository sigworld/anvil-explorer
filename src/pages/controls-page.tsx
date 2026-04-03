import { useEffect, useRef, useState } from 'preact/hooks'
import { parseUnits } from 'viem'
import { ErrorState, PageSection } from '../components/common.tsx'
import { useExplorer } from '../hooks/use-explorer.tsx'
import { usePageMeta } from '../hooks/use-page-meta.ts'
import { createAnvilClient, getErc20TokenInfo } from '../lib/rpc.ts'
import type { Erc20TokenInfo } from '../lib/types.ts'

type RouteProps = { path?: string }

const ENDPOINT_COLOR_OPTIONS = [
  'hsl(210 70% 90%)', 'hsl(150 70% 90%)', 'hsl(30 70% 90%)',
  'hsl(330 70% 90%)', 'hsl(270 70% 90%)', 'hsl(60 70% 90%)',
  'hsl(180 70% 90%)', 'hsl(0 70% 90%)', 'hsl(120 70% 90%)',
  'hsl(300 70% 90%)',
]

export function ControlsPage(_: RouteProps) {
  usePageMeta('Controls', 'Control your local Anvil node — mine blocks, adjust time, manage snapshots, impersonate accounts, and configure RPC endpoints.')
  const {
    actions,
    activeEndpointId,
    chainMeta,
    deleteEndpoint,
    endpoints,
    rpcUrl,
    saveEndpoint,
    setActiveEndpointId,
    snapshots,
  } = useExplorer()

  const [mineCount, setMineCount] = useState('1')
  const [balanceAddress, setBalanceAddress] = useState('')
  const [balanceEth, setBalanceEth] = useState('100')
  const [erc20Token, setErc20Token] = useState('')
  const [erc20Recipient, setErc20Recipient] = useState('')
  const [erc20Amount, setErc20Amount] = useState('1000')
  const [erc20TokenInfo, setErc20TokenInfo] = useState<Erc20TokenInfo | null>(null)
  const [erc20TokenLoading, setErc20TokenLoading] = useState(false)
  const [erc20MintLoading, setErc20MintLoading] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Endpoint modal state: null = closed, string = editing that id, 'new' = creating
  const [modalEndpointId, setModalEndpointId] = useState<string | null>(null)
  const [endpointNameDraft, setEndpointNameDraft] = useState('')
  const [rpcDraft, setRpcDraft] = useState('')
  const [startBlockDraft, setStartBlockDraft] = useState('')
  const [colorDraft, setColorDraft] = useState('')

  const [mintTab, setMintTab] = useState<'native' | 'erc20'>('native')
  const [armedAction, setArmedAction] = useState<string | null>(null)
  const [modalOrigin, setModalOrigin] = useState<{ x: number; y: number } | null>(null)

  const dialogRef = useRef<HTMLDialogElement | null>(null)

  useEffect(() => {
    if (modalEndpointId === null) {
      dialogRef.current?.close()
      return
    }
    if (modalEndpointId === 'new') {
      setEndpointNameDraft(`Endpoint ${endpoints.length + 1}`)
      setRpcDraft('http://127.0.0.1:8545')
      setStartBlockDraft('')
      setColorDraft('')
    } else {
      const ep = endpoints.find((e) => e.id === modalEndpointId)
      if (ep) {
        setEndpointNameDraft(ep.name)
        setRpcDraft(ep.rpcUrl)
        setStartBlockDraft(ep.startBlock !== null ? String(ep.startBlock) : '')
        setColorDraft(ep.color)
      }
    }
    dialogRef.current?.showModal()
  }, [modalEndpointId, endpoints])

  async function run(action: () => Promise<void>) {
    setError(null)
    try {
      await action()
    } catch (caughtError: unknown) {
      setError(caughtError instanceof Error ? caughtError.message : 'Control call failed')
    }
  }

  function parseStartBlockDraft(value: string): number | null {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const parsed = Number.parseInt(trimmed, 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }

  function handleEndpointSubmit(event: Event) {
    event.preventDefault()
    try {
      const endpointId = saveEndpoint({
        id: modalEndpointId !== 'new' ? modalEndpointId ?? undefined : undefined,
        name: endpointNameDraft,
        rpcUrl: rpcDraft,
        startBlock: parseStartBlockDraft(startBlockDraft),
        color: colorDraft || undefined,
      })
      if (endpointId !== activeEndpointId) {
        setActiveEndpointId(endpointId)
      }
      setResult(`Saved endpoint "${endpointNameDraft.trim() || 'Untitled Endpoint'}"`)
      setModalEndpointId(null)
    } catch (caughtError: unknown) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to save endpoint')
    }
  }

  function handleDeleteEndpoint() {
    const targetId = modalEndpointId
    if (!targetId || targetId === 'new') return
    const target = endpoints.find((ep) => ep.id === targetId)
    try {
      deleteEndpoint(targetId)
      setResult(`Removed endpoint "${target?.name ?? targetId}"`)
      setModalEndpointId(null)
    } catch (caughtError: unknown) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to remove endpoint')
    }
  }

  function openEndpointModal(id: string, event: MouseEvent) {
    setModalOrigin({ x: event.clientX, y: event.clientY })
    setModalEndpointId(id)
  }

  function handleDangerAction(key: string, action: () => void) {
    if (armedAction === key) {
      setArmedAction(null)
      action()
    } else {
      setArmedAction(key)
    }
  }

  const isEditing = modalEndpointId !== null && modalEndpointId !== 'new'

  return (
    <>
      {result && <p class="success-copy">{result}</p>}
      {error && <ErrorState message={error} />}

      <div class="config-layout">

        {/* Left column: Endpoints + Reset */}
        <div class="config-left-col">
          <PageSection
            title="Endpoints"
            description="Manage RPC endpoints"
            actions={<button type="button" onClick={(e) => openEndpointModal('new', e)}>+ New</button>}
          >
            <div class="endpoint-tiles">
              {endpoints.map((endpoint) => {
                const isActive = endpoint.id === activeEndpointId
                return (
                  <button
                    type="button"
                    key={endpoint.id}
                    class={`endpoint-tile ${isActive ? 'is-active' : ''}`.trim()}
                    onClick={(e) => openEndpointModal(endpoint.id, e)}
                  >
                    {endpoint.color && <span class="endpoint-tile-color" style={{ background: endpoint.color }} />}
                    <span class="endpoint-tile-name">{endpoint.name}</span>
                    <span class="endpoint-tile-url mono">{endpoint.rpcUrl}</span>
                    <span class="endpoint-tile-meta">
                      {endpoint.startBlock !== null ? `Start: ${endpoint.startBlock}` : 'Start: genesis'}
                      {isActive && <span class="endpoint-tile-badge">active</span>}
                    </span>
                  </button>
                )
              })}
            </div>
          </PageSection>

          <div class="reset-row">
            <button
              type="button"
              class={`danger-button ${armedAction === 'reset-current' ? 'danger-button-armed' : ''}`}
              onBlur={() => { if (armedAction === 'reset-current') setArmedAction(null) }}
              onClick={() =>
                handleDangerAction('reset-current', () => {
                  run(async () => {
                    await actions.resetData()
                    setResult('Cleared current chain data')
                  })
                })
              }
            >
              {armedAction === 'reset-current' ? 'Confirm Reset' : 'Reset Current Chain'}
            </button>
            <button
              type="button"
              class={`danger-button ${armedAction === 'reset-all' ? 'danger-button-armed' : ''}`}
              onBlur={() => { if (armedAction === 'reset-all') setArmedAction(null) }}
              onClick={() =>
                handleDangerAction('reset-all', () => {
                  run(async () => {
                    await actions.resetAllData()
                    setResult('Cleared all explorer data')
                  })
                })
              }
            >
              {armedAction === 'reset-all' ? 'Confirm Reset All' : 'Reset All Chains'}
            </button>
          </div>
        </div>

        {/* Right column: Minting | Mining+Snapshots */}
        <div class="config-right-col">
          <div class="config-right-top">
            <PageSection title="Token Minting" description="Add native ETH or deal ERC-20 tokens">
              <div class="mint-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  class={`mint-tab ${mintTab === 'native' ? 'mint-tab-active' : ''}`}
                  aria-selected={mintTab === 'native'}
                  onClick={() => setMintTab('native')}
                >
                  Native
                </button>
                <button
                  type="button"
                  role="tab"
                  class={`mint-tab ${mintTab === 'erc20' ? 'mint-tab-active' : ''}`}
                  aria-selected={mintTab === 'erc20'}
                  onClick={() => setMintTab('erc20')}
                >
                  ERC-20
                </button>
              </div>

              {mintTab === 'native' ? (
                <div class="stack-form" role="tabpanel">
                  <label>
                    <span class="field-label">Address</span>
                    <input
                      value={balanceAddress}
                      onInput={(event) => setBalanceAddress(event.currentTarget.value)}
                      placeholder="0x..."
                    />
                  </label>
                  <label>
                    <span class="field-label">Amount (ETH)</span>
                    <input
                      value={balanceEth}
                      onInput={(event) => setBalanceEth(event.currentTarget.value)}
                      placeholder="100"
                    />
                  </label>
                  <button
                    onClick={() =>
                      run(async () => {
                        await actions.mintNativeBalance(balanceAddress, balanceEth)
                        setResult(`Minted ${balanceEth} ETH to ${balanceAddress}`)
                      })
                    }
                  >
                    Mint
                  </button>
                </div>
              ) : (
                <div class="stack-form" role="tabpanel">
                  <label>
                    <span class="field-label">Token Contract</span>
                    <div class="input-with-action">
                      <input
                        value={erc20Token}
                        onInput={(event) => {
                          setErc20Token(event.currentTarget.value)
                          setErc20TokenInfo(null)
                        }}
                        placeholder="Token contract address"
                      />
                      <button
                        type="button"
                        disabled={erc20TokenLoading}
                        onClick={async () => {
                          setErc20TokenLoading(true)
                          setErc20TokenInfo(null)
                          try {
                            const client = createAnvilClient(rpcUrl)
                            const info = await getErc20TokenInfo(client, erc20Token as `0x${string}`)
                            setErc20TokenInfo(info)
                            if (!info) setError('Could not read token info — is this a valid ERC20?')
                          } catch {
                            setError('Failed to fetch token info')
                          } finally {
                            setErc20TokenLoading(false)
                          }
                        }}
                      >
                        {erc20TokenLoading ? 'Loading…' : 'Lookup'}
                      </button>
                    </div>
                  </label>
                  {erc20TokenInfo && (
                    <p class="muted">
                      {erc20TokenInfo.symbol ?? erc20TokenInfo.name ?? 'Unknown token'} — {erc20TokenInfo.decimals} decimals
                    </p>
                  )}
                  <label>
                    <span class="field-label">Recipient</span>
                    <input
                      value={erc20Recipient}
                      onInput={(event) => setErc20Recipient(event.currentTarget.value)}
                      placeholder="Recipient address"
                    />
                  </label>
                  <label>
                    <span class="field-label">Amount</span>
                    <input
                      value={erc20Amount}
                      onInput={(event) => setErc20Amount(event.currentTarget.value)}
                      placeholder="Amount (human-readable)"
                    />
                  </label>
                  <button
                    disabled={erc20MintLoading}
                    onClick={() => {
                      setErc20MintLoading(true)
                      run(async () => {
                        const decimals = erc20TokenInfo?.decimals ?? 18
                        const amount = parseUnits(erc20Amount, decimals)
                        await actions.dealErc20(erc20Token, erc20Recipient, amount)
                        const label = erc20TokenInfo?.symbol ?? 'tokens'
                        setResult(`Minted ${erc20Amount} ${label} to ${erc20Recipient}`)
                      }).finally(() => setErc20MintLoading(false))
                    }}
                  >
                    {erc20MintLoading ? 'Minting…' : 'Mint'}
                  </button>
                </div>
              )}
            </PageSection>

            <div class="config-chain-col">
              <PageSection title="Mine Blocks" description="anvil_mine + resync">
                <div class="mine-row">
                  <button type="button" class="mine-step" onClick={() => setMineCount(String(Math.max(1, (Number.parseInt(mineCount, 10) || 1) - 1)))}>-</button>
                  <input
                    class="mine-input"
                    value={mineCount}
                    onInput={(event) => setMineCount(event.currentTarget.value)}
                    type="number"
                    min="1"
                  />
                  <button type="button" class="mine-step" onClick={() => setMineCount(String((Number.parseInt(mineCount, 10) || 1) + 1))}>+</button>
                  <button
                    onClick={() =>
                      run(async () => {
                        await actions.mineBlocks(Number.parseInt(mineCount, 10) || 1)
                        setResult(`Mined ${mineCount} block(s)`)
                      })
                    }
                  >
                    Mine
                  </button>
                </div>
              </PageSection>

              <PageSection title="Snapshots" description="Chain rewinds are reconciled into IndexedDB">
                <button
                  onClick={() =>
                    run(async () => {
                      const nextSnapshotId = await actions.createSnapshot()
                      setResult(`Created snapshot ${nextSnapshotId}`)
                    })
                  }
                >
                  Create Snapshot
                </button>

                {snapshots.length > 0 && (
                  <div class="snapshot-rows">
                    {snapshots.map((item) => (
                      <div key={item} class="snapshot-row">
                        <code>{item}</code>
                        <button
                          type="button"
                          onClick={() =>
                            run(async () => {
                              const reverted = await actions.revertSnapshot(item)
                              setResult(reverted ? `Reverted snapshot ${item}` : `Snapshot ${item} rejected`)
                            })
                          }
                        >
                          Revert
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </PageSection>
            </div>
          </div>
        </div>
      </div>

      {/* ── Endpoint modal ── */}
      <dialog
        ref={dialogRef}
        class="endpoint-modal"
        onClose={() => setModalEndpointId(null)}
        onClick={(e) => { if (e.target === dialogRef.current) setModalEndpointId(null) }}
      >
        <form
          class="endpoint-modal-form"
          onSubmit={handleEndpointSubmit}
          style={modalOrigin ? { position: 'absolute', left: `clamp(8px, ${modalOrigin.x}px, calc(100vw - 448px))`, top: `clamp(8px, ${modalOrigin.y}px, calc(100vh - 420px))` } : undefined}
        >
          <h3>{isEditing ? 'Edit Endpoint' : 'New Endpoint'}</h3>
          <label>
            <span class="field-label">Endpoint Name</span>
            <input value={endpointNameDraft} onInput={(e) => setEndpointNameDraft(e.currentTarget.value)} />
          </label>
          <label>
            <span class="field-label">RPC URL</span>
            <input value={rpcDraft} onInput={(e) => setRpcDraft(e.currentTarget.value)} placeholder="http://127.0.0.1:8545" />
          </label>
          <label>
            <span class="field-label">Start Block</span>
            <input
              value={startBlockDraft}
              onInput={(e) => setStartBlockDraft(e.currentTarget.value)}
              placeholder={chainMeta?.forkConfig ? String(chainMeta.forkConfig.forkBlockNumber) : '0'}
              type="number"
              min="0"
            />
          </label>
          <div>
            <span class="field-label">Color</span>
            <div class="endpoint-color-swatches">
              {ENDPOINT_COLOR_OPTIONS.map((c) => (
                <button
                  key={c}
                  type="button"
                  class={`endpoint-color-swatch ${colorDraft === c ? 'is-active' : ''}`.trim()}
                  style={{ background: c }}
                  onClick={() => setColorDraft(c)}
                  aria-label={`Select color ${c}`}
                />
              ))}
            </div>
          </div>
          <div class="endpoint-modal-actions">
            <button type="submit">{isEditing ? 'Save & Connect' : 'Add & Connect'}</button>
            {isEditing && (
              <button type="button" onClick={handleDeleteEndpoint} disabled={endpoints.length <= 1} class="danger-button">
                Remove
              </button>
            )}
            <button type="button" onClick={() => setModalEndpointId(null)}>Cancel</button>
          </div>
        </form>
      </dialog>
    </>
  )
}
