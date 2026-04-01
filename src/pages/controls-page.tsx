import { useState } from 'preact/hooks'
import { ErrorState, PageSection } from '../components/common.tsx'
import { useExplorer } from '../hooks/use-explorer.tsx'

type RouteProps = { path?: string }

export function ControlsPage(_: RouteProps) {
  const { actions, snapshots } = useExplorer()
  const [mineCount, setMineCount] = useState('1')
  const [balanceAddress, setBalanceAddress] = useState('')
  const [balanceEth, setBalanceEth] = useState('100')
  const [snapshotId, setSnapshotId] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run(action: () => Promise<void>) {
    setError(null)

    try {
      await action()
    } catch (caughtError: unknown) {
      setError(caughtError instanceof Error ? caughtError.message : 'Control call failed')
    }
  }

  return (
    <>
      <PageSection title="Reset Explorer Data" description="Clear IndexedDB stores and restart indexing from the beginning">
        <button
          class="danger-button"
          onClick={() =>
            run(async () => {
              await actions.resetData()
              setResult('Cleared IndexedDB stores')
            })
          }
        >
          Reset IndexedDB
        </button>
      </PageSection>

      {result && <p class="success-copy">{result}</p>}
      {error && <ErrorState message={error} />}

      <div class="controls-grid">
        <PageSection title="Mine Blocks" description="Call anvil_mine and trigger a resync">
          <div class="inline-controls">
            <input value={mineCount} onInput={(event) => setMineCount(event.currentTarget.value)} />
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

        <PageSection title="Set Balance" description="Call anvil_setBalance for a local test account">
          <div class="stack-form">
            <input
              value={balanceAddress}
              onInput={(event) => setBalanceAddress(event.currentTarget.value)}
              placeholder="0x..."
            />
            <input
              value={balanceEth}
              onInput={(event) => setBalanceEth(event.currentTarget.value)}
              placeholder="100"
            />
            <button
              onClick={() =>
                run(async () => {
                  await actions.setBalance(balanceAddress, balanceEth)
                  setResult(`Set balance for ${balanceAddress}`)
                })
              }
            >
              Set Balance
            </button>
          </div>
        </PageSection>

        <PageSection title="Snapshot / Revert" description="Local chain rewinds are reconciled back into IndexedDB">
          <div class="button-row">
            <button
              onClick={() =>
                run(async () => {
                  const nextSnapshotId = await actions.createSnapshot()
                  setSnapshotId(nextSnapshotId)
                  setResult(`Created snapshot ${nextSnapshotId}`)
                })
              }
            >
              Create Snapshot
            </button>
            <input
              value={snapshotId}
              onInput={(event) => setSnapshotId(event.currentTarget.value)}
              placeholder="snapshot id"
            />
            <button
              onClick={() =>
                run(async () => {
                  const reverted = await actions.revertSnapshot(snapshotId)
                  setResult(reverted ? `Reverted snapshot ${snapshotId}` : `Snapshot ${snapshotId} rejected`)
                })
              }
            >
              Revert
            </button>
          </div>

          {snapshots.length > 0 && (
            <ul class="snapshot-list">
              {snapshots.map((item) => (
                <li key={item}>
                  <code>{item}</code>
                </li>
              ))}
            </ul>
          )}
        </PageSection>
      </div>
    </>
  )
}
