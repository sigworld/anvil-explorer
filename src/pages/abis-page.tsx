import { useEffect, useState } from 'preact/hooks'
import { DEFAULT_ABI_API_URL } from '../lib/abi-api.ts'
import {
  clearAllAbis,
  deleteAbi,
  getResolvedAddressLabel,
  listAbis,
  upsertAbi,
  upsertAddressLabel,
  upsertCodeImage,
  upsertSourceFile,
} from '../lib/db.ts'
import { toAbiRecord } from '../lib/decode.ts'
import { type ImportScanResult, isDirectoryPickerSupported, pickDirectory, scanDirectory, toAbiRecords } from '../lib/forge-import.ts'
import { shortenHex } from '../lib/format.ts'
import { useAsyncResource } from '../hooks/use-async-resource.ts'
import { useExplorer } from '../hooks/use-explorer.tsx'
import {
  AppLink,
  EmptyState,
  ErrorState,
  FoundryAbiTips,
  LoadingState,
  PageSection,
} from '../components/common.tsx'
import { usePageMeta } from '../hooks/use-page-meta.ts'

type RouteProps = { path?: string }

function AbiTileAddress(props: { address: string }) {
  const { refreshKey } = useExplorer()
  const label = useAsyncResource(async () => getResolvedAddressLabel(props.address), [props.address, refreshKey], null)
  const labelText = label.data
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    if (!navigator.clipboard) {
      return
    }

    await navigator.clipboard.writeText(props.address)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <span class="address-link-stack">
      {labelText && (
        <AppLink className="address-link-primary" path={`/address/${props.address}`} title={props.address}>
          {labelText}
        </AppLink>
      )}
      <span class="address-link-row">
        <AppLink
          className={`address-link-primary ${labelText ? 'address-link-secondary muted mono' : ''}`.trim()}
          path={`/address/${props.address}`}
          title={props.address}
        >
          {shortenHex(props.address)}
        </AppLink>
        <span class="abi-tile-inline-copy-wrap">
          <button
            type="button"
            class={`copy-button ${copied ? 'copy-button-copied' : ''}`.trim()}
            onClick={handleCopy}
            title={copied ? 'Contract address copied' : 'Copy contract address'}
            aria-label={copied ? 'Contract address copied' : 'Copy contract address'}
          >
            <svg aria-hidden="true" viewBox="0 0 16 16">
              <rect x="5" y="3" width="8" height="10" rx="1.5" />
              <path d="M3 10.5V5.5A1.5 1.5 0 0 1 4.5 4H9" />
            </svg>
          </button>
          {copied && (
            <span class="abi-tile-copy-toast" role="status">
              Contract address copied
            </span>
          )}
        </span>
      </span>
    </span>
  )
}

export function AbisPage(_: RouteProps) {
  usePageMeta('ABIs', 'Manage contract ABIs for calldata and log decoding — upload manually, import from Forge, or sync from an API endpoint.')
  const { abiApiUrl, actions, refreshKey, setAbiApiUrl } = useExplorer()
  const [localVersion, setLocalVersion] = useState(0)
  const [isSaveAbiModalOpen, setIsSaveAbiModalOpen] = useState(false)
  const [address, setAddress] = useState('')
  const [label, setLabel] = useState('')
  const [source, setSource] = useState('')
  const [copiedAbiAddress, setCopiedAbiAddress] = useState<string | null>(null)
  const [apiUrlDraft, setApiUrlDraft] = useState(abiApiUrl)
  const [formError, setFormError] = useState<string | null>(null)
  const [importScan, setImportScan] = useState<ImportScanResult | null>(null)
  const [importScanning, setImportScanning] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importDone, setImportDone] = useState<number | null>(null)
  const [importSourceInfo, setImportSourceInfo] = useState('')
  const abis = useAsyncResource(() => listAbis(), [refreshKey, localVersion], [])

  useEffect(() => {
    setApiUrlDraft(abiApiUrl)
  }, [abiApiUrl])

  useEffect(() => {
    if (!isSaveAbiModalOpen) {
      return
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setFormError(null)
        setIsSaveAbiModalOpen(false)
      }
    }

    const originalOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      document.body.style.overflow = originalOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isSaveAbiModalOpen])

  function openSaveAbiModal() {
    setFormError(null)
    setIsSaveAbiModalOpen(true)
  }

  function closeSaveAbiModal() {
    setFormError(null)
    setIsSaveAbiModalOpen(false)
  }

  async function handleSubmit(event: Event) {
    event.preventDefault()
    setFormError(null)

    try {
      const record = toAbiRecord(address, source)
      await upsertAbi(record)

      if (label.trim()) {
        await upsertAddressLabel(record.address, label.trim())
      }

      setAddress('')
      setLabel('')
      setSource('')
      setIsSaveAbiModalOpen(false)
      setLocalVersion((current) => current + 1)
      actions.refresh()
    } catch (caughtError: unknown) {
      setFormError(caughtError instanceof Error ? caughtError.message : 'Unable to save ABI')
    }
  }

  function handleApiEndpointSubmit(event: Event) {
    event.preventDefault()
    const nextValue = apiUrlDraft.trim()
    setAbiApiUrl(nextValue)

  }

  async function handleDelete(nextAddress: string) {
    await deleteAbi(nextAddress)
    setLocalVersion((current) => current + 1)
    actions.refresh()
  }

  async function handleClearAll() {
    if (!confirm('Clear all stored ABIs, code images, and source files?')) return
    await clearAllAbis()
    setLocalVersion((current) => current + 1)
    actions.refresh()
  }

  async function handleCopyAbi(nextAddress: string, nextSource: string) {
    if (!navigator.clipboard) {
      return
    }

    await navigator.clipboard.writeText(nextSource)
    setCopiedAbiAddress(nextAddress)
    window.setTimeout(() => {
      setCopiedAbiAddress((current) => (current === nextAddress ? null : current))
    }, 1200)
  }

  async function handleImportFromDirectory() {
    setImportError(null)
    setImportScan(null)
    setImportDone(null)
    setImportScanning(true)

    try {
      const dirHandle = await pickDirectory()
      const result = await scanDirectory(dirHandle)

      if (result.matched.length === 0 && result.unmatched.length === 0) {
        setImportError('No Forge or Hardhat artifacts found in this directory. Make sure you select your project root or the out/ directory after running forge build.')
        setImportScanning(false)
        return
      }

      setImportScan(result)
    } catch (caughtError: unknown) {
      if (caughtError instanceof DOMException && caughtError.name === 'AbortError') {
        // User cancelled the picker
      } else {
        setImportError(caughtError instanceof Error ? caughtError.message : 'Failed to scan directory')
      }
    }

    setImportScanning(false)
  }

  async function handleConfirmImport() {
    if (!importScan) {
      return
    }

    try {
      const records = toAbiRecords(importScan.matched)

      for (const record of records) {
        await upsertAbi(record)
      }

      // Use contract names as labels
      for (const item of importScan.matched) {
        await upsertAddressLabel(item.address as `0x${string}`, item.name)
      }

      // Store imported code images from build-info.
      for (const image of importScan.codeImages) {
        await upsertCodeImage(image)
      }

      // Store source files
      for (const file of importScan.sourceFiles) {
        await upsertSourceFile(file)
      }

      setImportSourceInfo(
        importScan.codeImages.length > 0
          ? ` (${importScan.codeImages.length} code images, ${importScan.sourceFiles.length} source files)`
          : '',
      )
      setImportDone(records.length)
      setImportScan(null)
      setLocalVersion((current) => current + 1)
      actions.refresh()
    } catch (caughtError: unknown) {
      setImportError(caughtError instanceof Error ? caughtError.message : 'Failed to import ABIs')
    }
  }

  function handleCloseImport() {
    setImportScan(null)
    setImportError(null)
    setImportDone(null)
    setImportSourceInfo('')
  }

  const abiItems = [...abis.data].sort((left, right) => right.updatedAt - left.updatedAt)

  return (
    <div class="detail-layout">
      <div class="detail-main">
        <PageSection
          title="Stored ABIs"
          description="Contract decoders currently stored in IndexedDB"
          actions={
            <div class="panel-header-actions">
              {isDirectoryPickerSupported() && (
                <button type="button" onClick={handleImportFromDirectory} disabled={importScanning}>
                  {importScanning ? 'Scanning\u2026' : 'Import from Forge'}
                </button>
              )}
              <button type="button" onClick={openSaveAbiModal}>
                Upload ABI
              </button>
              {abis.data.length > 0 && (
                <button type="button" class="danger-button" onClick={handleClearAll}>
                  Clear All
                </button>
              )}
            </div>
          }
        >
          {abis.loading && <LoadingState label="Loading saved ABIs" />}
          {abis.error && <ErrorState message={abis.error} />}
          {!abis.loading && abis.data.length === 0 && (
            <EmptyState title="No ABIs saved" body="Paste a contract ABI to enable calldata and log decoding." />
          )}
          {abiItems.length > 0 && (
            <div class="abi-tile-grid">
              {abiItems.map((item) => {
                const copied = copiedAbiAddress === item.address

                return (
                  <article key={item.address} class="abi-tile">
                    <div class="abi-tile-actions">
                      <span class="abi-tile-action-wrap">
                        <button
                          type="button"
                          class={`abi-tile-copy-action ${copied ? 'abi-tile-copy-action-copied' : ''}`.trim()}
                          onClick={() => handleCopyAbi(item.address, item.source)}
                          title={copied ? 'ABI copied' : 'Copy ABI'}
                          aria-label={copied ? 'ABI copied' : 'Copy ABI'}
                        >
                          <span class="abi-tile-copy-label">ABI</span>
                          <svg aria-hidden="true" viewBox="0 0 16 16">
                            <rect x="5" y="3" width="8" height="10" rx="1.5" />
                            <path d="M3 10.5V5.5A1.5 1.5 0 0 1 4.5 4H9" />
                          </svg>
                        </button>
                        {copied && (
                          <span class="abi-tile-copy-toast" role="status">
                            ABI copied
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        class="copy-button abi-tile-delete-button"
                        onClick={() => handleDelete(item.address)}
                        title="Delete ABI"
                        aria-label="Delete ABI"
                      >
                        <svg aria-hidden="true" viewBox="0 0 16 16">
                          <path d="M3.5 4.5h9" />
                          <path d="M6.5 4.5V3.2a.7.7 0 0 1 .7-.7h1.6a.7.7 0 0 1 .7.7v1.3" />
                          <path d="M5 6.2v5.3" />
                          <path d="M8 6.2v5.3" />
                          <path d="M11 6.2v5.3" />
                          <path d="M4.2 4.5l.5 8.2a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.5-8.2" />
                        </svg>
                      </button>
                    </div>
                    <div class="abi-tile-body">
                      <div class="abi-tile-address">
                        <AbiTileAddress address={item.address} />
                      </div>
                    </div>
                    <dl class="abi-tile-meta">
                      <div>
                        <dt class="eyebrow">Updated</dt>
                        <dd>{new Date(item.updatedAt).toLocaleString()}</dd>
                      </div>
                    </dl>
                  </article>
                )
              })}
            </div>
          )}
        </PageSection>
      </div>

      <aside class="detail-sidebar">
        <PageSection
          title="ABI API Endpoint"
          description="The frontend polls this GET endpoint for ABI records. Default is the built-in local endpoint, but any compatible service works."
          actions={
            <button
              type="button"
              class={`api-toggle ${abiApiUrl ? 'is-active' : ''}`.trim()}
              onClick={() => {
                if (abiApiUrl) {
                  setAbiApiUrl('')

                } else {
                  const url = apiUrlDraft || DEFAULT_ABI_API_URL
                  setApiUrlDraft(url)
                  setAbiApiUrl(url)

                }
              }}
              title={abiApiUrl ? 'Disable ABI API polling' : 'Enable ABI API polling'}
              aria-pressed={!!abiApiUrl}
            />
          }
        >
          <form class="stack-form" onSubmit={handleApiEndpointSubmit}>
            <label>
              <span class="field-label">Endpoint URL</span>
              <input
                value={apiUrlDraft}
                onInput={(event) => setApiUrlDraft(event.currentTarget.value)}
                placeholder={DEFAULT_ABI_API_URL}
                disabled={!abiApiUrl}
              />
            </label>
            <div class="button-row-inline" style={{ marginTop: 8, marginBottom: 12 }}>
              <button type="submit" disabled={!abiApiUrl}>Save Endpoint</button>
              <button
                type="button"
                disabled={!abiApiUrl}
                onClick={() => {
                  setApiUrlDraft(DEFAULT_ABI_API_URL)
                  setAbiApiUrl(DEFAULT_ABI_API_URL)

                }}
              >
                Use Default
              </button>
            </div>
          </form>
          <div class="info-panel">
            <p class="muted">
              <code>GET</code> must return a bare array or <code>{`{"records":[...]}`}</code>.
              Each record needs <code>address</code>, <code>source</code>, and <code>updatedAt</code>.{' '}
              <code>label</code> is optional.
            </p>
            <pre class="json-view">{`{
  "records": [
    {
      "address": "0xYourContractAddress",
      "label": "Treasury",
      "source": "[{\"type\":\"function\",...}]",
      "updatedAt": 1712345678901
    }
  ]
}`}</pre>
            <p class="muted">
              Optional: support <code>POST</code> with <code>source</code>, <code>abi</code>, or{' '}
              <code>artifact</code> payloads for automated ABI registration from deploy scripts.
            </p>
          </div>
        </PageSection>
      </aside>

      {importDone !== null && (
        <div class="modal-backdrop" onClick={handleCloseImport}>
          <section
            class="panel modal-dialog"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="modal-dialog-header">
              <div>
                <h2>Import Complete</h2>
                <p class="muted">
                  {importDone === 0
                    ? 'No ABIs were imported.'
                    : `Imported ${importDone} contract ABI${importDone === 1 ? '' : 's'} with labels.${importSourceInfo}`}
                </p>
              </div>
              <button type="button" class="modal-close-button" onClick={handleCloseImport} aria-label="Close">
                Close
              </button>
            </div>
            <div class="button-row modal-dialog-actions">
              <button type="button" onClick={handleCloseImport}>
                Done
              </button>
            </div>
          </section>
        </div>
      )}

      {importError && !importScan && importDone === null && (
        <div class="modal-backdrop" onClick={handleCloseImport}>
          <section
            class="panel modal-dialog"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="modal-dialog-header">
              <div>
                <h2>Import Failed</h2>
              </div>
              <button type="button" class="modal-close-button" onClick={handleCloseImport} aria-label="Close">
                Close
              </button>
            </div>
            <ErrorState message={importError} />
            <div class="button-row modal-dialog-actions">
              <button type="button" onClick={handleCloseImport}>
                Close
              </button>
            </div>
          </section>
        </div>
      )}

      {importScan && (
        <div class="modal-backdrop" onClick={handleCloseImport}>
          <section
            class="panel modal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="modal-dialog-header">
              <div>
                <h2 id="import-dialog-title">Import from Forge</h2>
                <p class="muted">
                  Found {importScan.matched.length + importScan.unmatched.length} contract artifact{importScan.matched.length + importScan.unmatched.length === 1 ? '' : 's'}.
                  {importScan.matched.length > 0 &&
                    ` ${importScan.matched.length} matched to deployed addresses via broadcast files.`}
                  {importScan.codeImages.length > 0 &&
                    ` ${importScan.codeImages.length} code image${importScan.codeImages.length === 1 ? '' : 's'} from build-info.`}
                  {importScan.sourceFiles.length > 0 &&
                    ` ${importScan.sourceFiles.length} source file${importScan.sourceFiles.length === 1 ? '' : 's'} found for source mapping.`}
                </p>
              </div>
              <button type="button" class="modal-close-button" onClick={handleCloseImport} aria-label="Close">
                Close
              </button>
            </div>

            {importScan.matched.length > 0 && (
              <div>
                <p class="eyebrow">Ready to import ({importScan.matched.length})</p>
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Contract</th>
                      <th>Address</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importScan.matched.map((item) => (
                      <tr key={item.address}>
                        <td>{item.name}</td>
                        <td class="mono">{shortenHex(item.address)}</td>
                        <td>
                          {item.hasSourceImages
                            ? <span class="meta-badge meta-status meta-status-success">code image</span>
                            : <span class="muted">ABI only</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {importScan.unmatched.length > 0 && (
              <div>
                <p class="eyebrow">No deployed address found ({importScan.unmatched.length})</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' }}>
                  {importScan.unmatched.map((item) => (
                    <span key={item.name} class="meta-badge" title="No matching deployment in broadcast/ files">
                      {item.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {importError && <ErrorState message={importError} />}

            <div class="button-row modal-dialog-actions">
              {importScan.matched.length > 0 && (
                <button type="button" onClick={handleConfirmImport}>
                  Import {importScan.matched.length} ABI{importScan.matched.length === 1 ? '' : 's'}
                  {importScan.sourceFiles.length > 0 ? ' with source' : ''}
                </button>
              )}
              <button type="button" onClick={handleCloseImport}>
                Cancel
              </button>
            </div>
          </section>
        </div>
      )}

      {isSaveAbiModalOpen && (
        <div class="modal-backdrop" onClick={closeSaveAbiModal}>
          <section
            class="panel modal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="save-abi-dialog-title"
            aria-describedby="save-abi-dialog-description"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="modal-dialog-header">
              <div>
                <h2 id="save-abi-dialog-title">Upload ABI</h2>
                <p class="muted" id="save-abi-dialog-description">
                  Attach an ABI to a contract address for decode support and optionally save a contract name used
                  throughout the explorer.
                </p>
              </div>
              <button type="button" class="modal-close-button" onClick={closeSaveAbiModal} aria-label="Close upload ABI modal">
                Close
              </button>
            </div>
            <form class="stack-form" onSubmit={handleSubmit}>
              <label>
                <span class="field-label">Contract Address</span>
                <input value={address} onInput={(event) => setAddress(event.currentTarget.value)} />
              </label>
              <label>
                <span class="field-label">Contract Label</span>
                <input value={label} onInput={(event) => setLabel(event.currentTarget.value)} placeholder="Treasury, Token, Vault, Router" />
              </label>
              <label>
                <span class="field-label">ABI JSON</span>
                <textarea
                  rows={16}
                  value={source}
                  onInput={(event) => setSource(event.currentTarget.value)}
                  placeholder='[{"type":"function","name":"transfer",...}] or a Forge artifact JSON object'
                />
              </label>
              <div class="button-row modal-dialog-actions">
                <button type="submit">Upload ABI</button>
                <button type="button" onClick={closeSaveAbiModal}>
                  Cancel
                </button>
              </div>
            </form>
            {formError && <ErrorState message={formError} />}
            <FoundryAbiTips />
          </section>
        </div>
      )}
    </div>
  )
}
