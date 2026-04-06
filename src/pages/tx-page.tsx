import { DebugTraceView } from '../components/debug-trace-view.tsx'
import { StackTraceView } from '../components/stack-trace-view.tsx'
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { decodeLog, decodeTransaction, mergeAbis, toAbiRecord } from '../lib/decode.ts'
import {
  getAbi,
  getLogsByTxHash,
  getReceipt,
  getResolvedAddressLabel,
  getTransaction,
  storeBlockBundle,
  upsertAbi,
  upsertAddressLabel,
  upsertCodeImage,
  upsertSourceFile,
} from '../lib/db.ts'
import { inspectTransactionFailure } from '../lib/failure.ts'
import {
  type BytecodeMatchScanResult,
  isDirectoryPickerSupported,
  pickDirectory,
  scanDirectoryForBytecodeMatch,
} from '../lib/forge-import.ts'
import { formatBigIntString, formatNumber, formatUnitsString, shortenHex } from '../lib/format.ts'
import { buildTokenBalanceEffects } from '../lib/token-effects.ts'
import { buildTraceTree } from '../lib/trace.ts'
import { buildTransactionSummary } from '../lib/transaction-meta.ts'
import type { OpcodeTrace, TokenBalanceEffect, TraceNode } from '../lib/types.ts'
import { useAsyncResource } from '../hooks/use-async-resource.ts'
import { useExplorer } from '../hooks/use-explorer.tsx'
import { usePageMeta } from '../hooks/use-page-meta.ts'
import {
  createAnvilClient,
  getAddressKind,
  getBlockByNumber,
  getCode,
  getProxyImplementation,
  getReceiptByHash,
  getTransactionByHash,
} from '../lib/rpc.ts'
import { normalizeTransaction, normalizeBlock, normalizeReceipt, normalizeLogs } from '../lib/sync.ts'
import {
  AppLink,
  AddressLink,
  AddressKindBadge,
  BlockLink,
  CopyButton,
  EmptyState,
  ErrorState,
  FoundryAbiTips,
  JsonView,
  KeyValueGrid,
  LoadingState,
  LogDecodePopup,
  MethodLabel,
  PageSection,
  SummaryTable,
  TransactionEnvelopeBadge,
  TransactionKindBadge,
  TransactionStatusBadge,
} from '../components/common.tsx'

type RouteProps = {
  hash?: string
  path?: string
}

type TxDetailTab = 'overview' | 'stack' | 'debug'

function formatTokenEffectDelta(
  delta: string,
  decimals: number,
) {
  const deltaBigInt = BigInt(delta)

  return `${deltaBigInt >= 0n ? '+' : ''}${formatUnitsString(delta, decimals)}`
}

function ResolvedAddressText(props: { address: string | null; linked?: boolean }) {
  const { refreshKey } = useExplorer()
  const label = useAsyncResource(
    async () => (props.address ? getResolvedAddressLabel(props.address) : null),
    [props.address, refreshKey],
    null,
  )

  if (!props.address) {
    return <span class="mono">n/a</span>
  }

  const primary = label.data ?? shortenHex(props.address)
  const addressValue = shortenHex(props.address)

  return (
    <span class="tx-address-block">
      <span class="tx-address-block-primary">{primary}</span>
      {(label.data || props.linked) && (
        <span class="tx-address-block-value-row">
          <span class="tx-address-block-secondary muted mono" title={props.address}>
            {addressValue}
          </span>
          {props.linked && (
            <AppLink className="tx-address-inline-link" path={`/address/${props.address}`} title={props.address}>
              <svg aria-hidden="true" viewBox="0 0 16 16">
                <path d="M6 4h6v6" />
                <path d="m5 11 7-7" />
                <path d="M10 12H4V6" />
              </svg>
            </AppLink>
          )}
        </span>
      )}
    </span>
  )
}

function TxDetailPanel(props: {
  title?: string
  description?: ComponentChildren
  actions?: ComponentChildren
  children: ComponentChildren
}) {
  const hasHeader = props.title || props.description || props.actions
  const headerClassName =
    props.title || props.description
      ? 'panel-header tx-detail-panel-header'
      : 'panel-header tx-detail-panel-header tx-detail-panel-header-actions-only'

  return (
    <section class="panel">
      {hasHeader && (
        <div class={headerClassName}>
          {(props.title || props.description) && (
            <div class="section-header-copy section-header-copy-compact">
              {props.title && <p class="eyebrow tx-detail-panel-title section-kicker">{props.title}</p>}
              {props.description && <p class="section-description section-description-compact">{props.description}</p>}
            </div>
          )}
          {props.actions}
        </div>
      )}
      {props.children}
    </section>
  )
}

function groupTokenEffectsByToken(tokenEffects: TokenBalanceEffect[]) {
  const groups = new Map<
    string,
    {
      tokenAddress: string
      symbol: string | null
      name: string | null
      decimals: number
      effects: TokenBalanceEffect[]
      holderCount: number
      totalAbsDelta: bigint
    }
  >()

  for (const effect of tokenEffects) {
    const current = groups.get(effect.tokenAddress)
    const magnitude = BigInt(effect.delta)
    const absDelta = magnitude < 0n ? -magnitude : magnitude

    if (current) {
      current.effects.push(effect)
      current.holderCount += 1
      current.totalAbsDelta += absDelta
      continue
    }

    groups.set(effect.tokenAddress, {
      tokenAddress: effect.tokenAddress,
      symbol: effect.symbol,
      name: effect.name,
      decimals: effect.decimals,
      effects: [effect],
      holderCount: 1,
      totalAbsDelta: absDelta,
    })
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      effects: [...group.effects].sort((left, right) => {
        const leftDelta = BigInt(left.delta)
        const rightDelta = BigInt(right.delta)
        const leftMagnitude = leftDelta < 0n ? -leftDelta : leftDelta
        const rightMagnitude = rightDelta < 0n ? -rightDelta : rightDelta

        if (leftMagnitude !== rightMagnitude) {
          return rightMagnitude > leftMagnitude ? 1 : -1
        }

        return left.holderAddress.localeCompare(right.holderAddress)
      }),
    }))
    .sort((left, right) => {
      if (left.holderCount !== right.holderCount) {
        return right.holderCount - left.holderCount
      }

      if (left.totalAbsDelta !== right.totalAbsDelta) {
        return right.totalAbsDelta > left.totalAbsDelta ? 1 : -1
      }

      const leftName = left.symbol ?? left.name ?? left.tokenAddress
      const rightName = right.symbol ?? right.name ?? right.tokenAddress
      return leftName.localeCompare(rightName)
    })
}

export function TxPage(props: RouteProps) {
  usePageMeta(props.hash ? `Tx ${props.hash.slice(0, 10)}...` : 'Transaction', 'Inspect a transaction — decoded calldata, event logs, token transfers, debug traces, and revert reasons.')
  const { actions, refreshKey, rpcUrl } = useExplorer()
  const [activeTab, setActiveTab] = useState<TxDetailTab>('overview')
  const [localVersion, setLocalVersion] = useState(0)
  const [trace, setTrace] = useState<TraceNode | null>(null)
  const [rawTrace, setRawTrace] = useState<unknown>(null)
  const [rawTraceOpen, setRawTraceOpen] = useState(false)
  const [traceLoading, setTraceLoading] = useState(false)
  const [traceError, setTraceError] = useState<string | null>(null)
  const traceRequestIdRef = useRef(0)
  const [rawCalldataOpen, setRawCalldataOpen] = useState(false)
  const [abiSource, setAbiSource] = useState('')
  const [contractLabel, setContractLabel] = useState('')
  const [abiResult, setAbiResult] = useState<string | null>(null)
  const [abiError, setAbiError] = useState<string | null>(null)
  const [abiModalAddress, setAbiModalAddress] = useState<string | null>(null)
  const [forgeDetecting, setForgeDetecting] = useState(false)
  const [forgeScanResult, setForgeScanResult] = useState<BytecodeMatchScanResult | null>(null)
  const [forgeSelectedIndex, setForgeSelectedIndex] = useState(0)
  const [forgeError, setForgeError] = useState<string | null>(null)
  const [selectedTokenAddress, setSelectedTokenAddress] = useState<string | null>(null)
  const [opcodeTrace, setOpcodeTrace] = useState<OpcodeTrace | null>(null)
  const [opcodeLoading, setStructLogLoading] = useState(false)
  const [opcodeError, setStructLogError] = useState<string | null>(null)
  const opcodeRequestIdRef = useRef(0)

  useEffect(() => {
    traceRequestIdRef.current += 1
    opcodeRequestIdRef.current += 1
    setActiveTab('overview')
    setTrace(null)
    setRawTrace(null)
    setRawTraceOpen(false)
    setTraceLoading(false)
    setTraceError(null)
    setRawCalldataOpen(false)
    setSelectedTokenAddress(null)
    setOpcodeTrace(null)
    setStructLogLoading(false)
    setStructLogError(null)
  }, [props.hash])

  async function lazyLoadTrace<T>(
    ref: { current: number },
    isLoaded: boolean,
    isLoading: boolean,
    setLoading: (v: boolean) => void,
    setError: (v: string | null) => void,
    setData: (v: T) => void,
    fetcher: () => Promise<T>,
    fallbackError: string,
  ) {
    if (!props.hash || isLoading || isLoaded) return

    const requestId = ref.current + 1
    ref.current = requestId
    setLoading(true)
    setError(null)

    try {
      const result = await fetcher()
      if (ref.current !== requestId) return
      setData(result)
    } catch (caughtError: unknown) {
      if (ref.current === requestId) {
        setError(caughtError instanceof Error ? caughtError.message : fallbackError)
      }
    } finally {
      if (ref.current === requestId) {
        setLoading(false)
      }
    }
  }

  async function loadTraceData() {
    await lazyLoadTrace(
      traceRequestIdRef,
      !!rawTrace,
      traceLoading,
      setTraceLoading,
      setTraceError,
      (result: { raw: unknown; tree: TraceNode }) => {
        setRawTrace(result.raw)
        setTrace(result.tree)
        setRawTraceOpen(false)
      },
      async () => {
        const raw = await actions.loadTrace(props.hash as `0x${string}`)
        const client = createAnvilClient(rpcUrl)
        const tree = await buildTraceTree(raw, client)
        return { raw, tree }
      },
      'Trace request failed',
    )
  }

  async function loadOpcodeData(enableStorage = false) {
    await lazyLoadTrace(
      opcodeRequestIdRef,
      !!opcodeTrace,
      opcodeLoading,
      setStructLogLoading,
      setStructLogError,
      setOpcodeTrace,
      () => actions.loadOpcodeTrace(props.hash as `0x${string}`, { enableStorage }),
      'Opcode trace failed',
    )
  }

  useEffect(() => {
    if ((activeTab !== 'overview' && activeTab !== 'stack' && activeTab !== 'debug') || traceLoading || rawTrace) return
    void loadTraceData()
  }, [activeTab, props.hash, rpcUrl])

  useEffect(() => {
    if (activeTab !== 'debug' || opcodeLoading || opcodeTrace) return
    void loadOpcodeData(true)
  }, [activeTab, props.hash, rpcUrl])

  const resource = useAsyncResource(
    async () => {
      if (!props.hash) {
        return null
      }

      let [transaction, receipt, logs] = await Promise.all([
        getTransaction(props.hash),
        getReceipt(props.hash),
        getLogsByTxHash(props.hash),
      ])

      if (!transaction) {
        const client = createAnvilClient(rpcUrl)
        const txHash = props.hash as `0x${string}`
        const rpcTx = await getTransactionByHash(client, txHash)
        if (!rpcTx) {
          return null
        }

        transaction = normalizeTransaction(rpcTx)
        const rpcReceipt = await getReceiptByHash(client, txHash)

        // Index the entire block so all sibling txs and logs are available
        if (rpcTx.blockNumber) {
          const rpcBlock = await getBlockByNumber(client, Number(rpcTx.blockNumber))
          const blockRecord = normalizeBlock(rpcBlock)
          const txRecords = rpcBlock.transactions.map(normalizeTransaction)
          const receipts = (
            await Promise.all(rpcBlock.transactions.map((t) => getReceiptByHash(client, t.hash)))
          ).filter((r): r is NonNullable<typeof r> => r !== null)
          const receiptRecords = receipts.map(normalizeReceipt)
          const logRecords = receipts.flatMap(normalizeLogs)
          await storeBlockBundle(blockRecord, txRecords, receiptRecords, logRecords)

          // Re-read from IndexedDB so local data is consistent
          ;[transaction, receipt, logs] = await Promise.all([
            getTransaction(props.hash).then((t) => t ?? transaction!),
            getReceipt(props.hash),
            getLogsByTxHash(props.hash),
          ])
          actions.refresh()
        } else if (rpcReceipt) {
          // Pending tx with receipt but no block — store just the tx + receipt
          receipt = normalizeReceipt(rpcReceipt)
          logs = normalizeLogs(rpcReceipt)
        }
      }

      const client = createAnvilClient(rpcUrl)
      const summary = await buildTransactionSummary(transaction, client)

      const [toAbi, createdAbi, fromKind, toKind, implAbi] = await Promise.all([
        transaction.to ? getAbi(transaction.to) : Promise.resolve(undefined),
        receipt?.contractAddress ? getAbi(receipt.contractAddress) : Promise.resolve(undefined),
        getAddressKind(client, transaction.from),
        transaction.to ? getAddressKind(client, transaction.to) : Promise.resolve(null),
        transaction.to
          ? getProxyImplementation(client, transaction.to as `0x${string}`).then(impl => impl ? getAbi(impl) : null)
          : Promise.resolve(null),
      ])

      const merged = mergeAbis([toAbi?.abi, createdAbi?.abi, implAbi?.abi])
      const contractAbi = merged.length > 0 ? merged : null
      const failure =
        receipt?.status === '0' ? await inspectTransactionFailure(client, transaction, contractAbi) : null
      const tokenEffects = await buildTokenBalanceEffects(client, logs, transaction.blockNumber)

      return {
        transaction,
        receipt,
        logs,
        summary,
        contractAbi,
        fromKind,
        toKind,
        failure,
        tokenEffects,
      }
    },
    [refreshKey, localVersion, props.hash, rpcUrl],
    null,
  )

  function openAbiModal(address: string) {
    setAbiModalAddress(address)
    setAbiSource('')
    setContractLabel('')
    setAbiResult(null)
    setAbiError(null)
    setForgeScanResult(null)
    setForgeError(null)
    setForgeDetecting(false)
    setForgeSelectedIndex(0)
  }

  function closeAbiModal() {
    setAbiModalAddress(null)
    setForgeScanResult(null)
  }

  async function handleAbiSubmit(event: Event) {
    event.preventDefault()
    setAbiError(null)
    setAbiResult(null)

    const contractAddress = abiModalAddress

    if (!contractAddress) {
      setAbiError('No contract address selected')
      return
    }

    try {
      await upsertAbi(toAbiRecord(contractAddress, abiSource))

      if (contractLabel.trim()) {
        await upsertAddressLabel(contractAddress, contractLabel.trim())
      }

      setAbiSource('')
      setContractLabel('')
      setAbiModalAddress(null)
      setAbiResult(
        contractLabel.trim()
          ? `Saved ABI and label for ${shortenHex(contractAddress)}`
          : `Saved ABI for ${shortenHex(contractAddress)}`,
      )
      setLocalVersion((current) => current + 1)
      actions.refresh()
    } catch (caughtError: unknown) {
      setAbiError(caughtError instanceof Error ? caughtError.message : 'Unable to save ABI')
    }
  }

  async function handleForgeDetect() {
    if (!abiModalAddress) return
    setForgeError(null)
    setForgeScanResult(null)
    setForgeSelectedIndex(0)
    setForgeDetecting(true)

    try {
      const client = createAnvilClient(rpcUrl)
      const bytecode = await getCode(client, abiModalAddress as `0x${string}`)
      if (!bytecode || bytecode === '0x') {
        setForgeError('No bytecode found at this address')
        setForgeDetecting(false)
        return
      }

      const dirHandle = await pickDirectory()
      const result = await scanDirectoryForBytecodeMatch(dirHandle, bytecode)

      if (result.candidates.length === 0) {
        setForgeError('No matching contracts found. Make sure you select the Forge project root after running forge build.')
        setForgeDetecting(false)
        return
      }

      setForgeScanResult(result)
    } catch (caughtError: unknown) {
      if (caughtError instanceof DOMException && caughtError.name === 'AbortError') {
        // User cancelled
      } else {
        setForgeError(caughtError instanceof Error ? caughtError.message : 'Failed to scan directory')
      }
    }

    setForgeDetecting(false)
  }

  async function handleForgeConfirm() {
    if (!forgeScanResult || !abiModalAddress) return
    const candidate = forgeScanResult.candidates[forgeSelectedIndex]
    if (!candidate) return

    try {
      await upsertAbi(toAbiRecord(abiModalAddress, candidate.source))
      await upsertAddressLabel(abiModalAddress as `0x${string}`, candidate.name)

      const codeImages = forgeScanResult.codeImagesByArtifact.get(candidate.artifactPath) ?? []
      for (const image of codeImages) {
        await upsertCodeImage(image)
      }
      for (const file of forgeScanResult.sourceFiles) {
        await upsertSourceFile(file)
      }

      const parts: string[] = []
      if (candidate.bytecodeMatch) {
        parts.push('exact bytecode match')
      } else {
        parts.push(`${candidate.matchedSelectors}/${candidate.onChainSelectors} selectors`)
      }
      if (codeImages.length > 0) {
        parts.push(`${codeImages.length} code image${codeImages.length === 1 ? '' : 's'}`)
      }
      if (forgeScanResult.sourceFiles.length > 0) {
        parts.push(`${forgeScanResult.sourceFiles.length} source file${forgeScanResult.sourceFiles.length === 1 ? '' : 's'}`)
      }

      setForgeScanResult(null)
      setAbiModalAddress(null)
      setAbiResult(`Saved ABI: ${candidate.name} (${parts.join(', ')})`)
      setLocalVersion((current) => current + 1)
      actions.refresh()
    } catch (caughtError: unknown) {
      setForgeError(caughtError instanceof Error ? caughtError.message : 'Failed to save ABI')
    }
  }

  const decodedCall =
    resource.data?.transaction && resource.data.contractAbi
      ? decodeTransaction(resource.data.transaction, resource.data.contractAbi)
      : null
  const tokenGroups = resource.data ? groupTokenEffectsByToken(resource.data.tokenEffects) : []
  const activeTokenGroup =
    tokenGroups.find((group) => group.tokenAddress === selectedTokenAddress) ?? tokenGroups[0] ?? null

  return (
    <PageSection
      title="Transaction"
      description={
        props.hash ? (
          <span class="panel-description-inline">
            <span class="mono">{shortenHex(props.hash, 10)}</span>
            <CopyButton value={props.hash} label="transaction hash" />
          </span>
        ) : (
          'Missing hash'
        )
      }
    >
      {resource.loading && <LoadingState label="Loading transaction" />}
      {resource.error && <ErrorState message={resource.error} />}
      {!resource.loading && !props.hash && (
        <EmptyState title="Missing hash" body="Use a transaction hash in the route or search box." />
      )}
      {!resource.loading && props.hash && !resource.data && (
        <EmptyState title="Transaction not found" body="Could not find this transaction in IndexedDB or via RPC." />
      )}
      {resource.data && (
        <>
          <div class="detail-layout tx-detail-layout">
            <div class="detail-main">
              <KeyValueGrid
                items={[
                  { label: 'Block', value: <BlockLink number={resource.data.transaction.blockNumber} /> },
                  {
                    label: 'From',
                    value: (
                      <span class="address-detail">
                        <AddressLink address={resource.data.transaction.from} />
                        <AddressKindBadge kind={resource.data.fromKind} />
                        {resource.data.fromKind === 'contract' && !resource.data.contractAbi && (
                          <button
                            type="button"
                            class="attach-abi-inline-btn"
                            onClick={() => openAbiModal(resource.data!.transaction.from)}
                          >
                            Attach ABI
                          </button>
                        )}
                      </span>
                    ),
                  },
                  {
                    label: 'To',
                    value: (
                      <span class="address-detail">
                        <AddressLink address={resource.data.transaction.to} />
                        <AddressKindBadge kind={resource.data.toKind} />
                        {resource.data.toKind === 'contract' && resource.data.transaction.to && !resource.data.contractAbi && (
                          <button
                            type="button"
                            class="attach-abi-inline-btn"
                            onClick={() => openAbiModal(resource.data!.transaction.to!)}
                          >
                            Attach ABI
                          </button>
                        )}
                      </span>
                    ),
                  },
                  { label: 'Kind', value: <TransactionKindBadge kind={resource.data.summary.kind} /> },
                  { label: 'Status', value: <TransactionStatusBadge status={resource.data.summary.status} /> },
                  { label: 'Envelope', value: <TransactionEnvelopeBadge envelope={resource.data.summary.envelope} /> },
                  {
                    label: 'Method',
                    value: <MethodLabel method={resource.data.summary.method} selector={resource.data.summary.selector} />,
                  },
                  { label: 'Selector', value: <span class="mono">{resource.data.summary.selector ?? '0x'}</span> },
                  { label: 'Value', value: formatBigIntString(resource.data.transaction.value) },
                  { label: 'Gas', value: formatBigIntString(resource.data.transaction.gas) },
                  { label: 'Nonce', value: formatNumber(resource.data.transaction.nonce) },
                  { label: 'Receipt Code', value: resource.data.receipt?.status ?? 'n/a' },
                ]}
              />
            </div>

            <aside class="detail-sidebar">
              <section
                class={`tx-effects-panel ${resource.data.tokenEffects.length === 0 ? 'tx-effects-panel-muted' : ''}`.trim()}
              >
                <div class="tx-effects-panel-header">
                  <div class="tx-effects-panel-title-row">
                    <p class="eyebrow">Token Effects</p>
                    {tokenGroups.length > 0 && (
                      <span class="tx-effects-count">{formatNumber(tokenGroups.length)} tokens</span>
                    )}
                  </div>
                  <p class="muted">Grouped by token. Currently sourced from indexed ERC-20 Transfer logs.</p>
                </div>

                {resource.data.tokenEffects.length === 0 ? (
                  <p class="muted">No related token balance changes for this transaction.</p>
                ) : (
                  <div class="tx-token-browser">
                    <div class="tx-token-list" role="tablist" aria-label="Tokens with balance changes">
                      {tokenGroups.map((group) => {
                        const isActive = group.tokenAddress === activeTokenGroup?.tokenAddress

                        return (
                          <div
                            key={group.tokenAddress}
                            class={`tx-token-item ${isActive ? 'is-active' : ''}`.trim()}
                            onClick={() => setSelectedTokenAddress(group.tokenAddress)}
                            role="tab"
                            aria-selected={isActive}
                            style={{ cursor: 'pointer' }}
                          >
                            <div class={`tx-token-button ${isActive ? 'is-active' : ''}`.trim()}>
                              <span class="tx-token-button-main">
                                <strong>{group.symbol ?? group.name ?? 'Unknown token'}</strong>
                              </span>
                              <span class="tx-token-button-meta">
                                {formatNumber(group.holderCount)} holders
                              </span>
                            </div>
                            <ResolvedAddressText address={group.tokenAddress} linked />
                          </div>
                        )
                      })}
                    </div>

                    {activeTokenGroup && (
                      <div class="tx-token-detail">
                        <div class="tx-effects-table">
                          <div class="tx-effects-table-scroll">
                            <div class="tx-effects-table-inner">
                              <div class="tx-effects-table-head" aria-hidden="true">
                                <span>Holder</span>
                                <span>Delta</span>
                                <span>Balance Change</span>
                              </div>

                              <div class="tx-effects-list">
                                {activeTokenGroup.effects.map((effect) => {
                                  const beforeBalance =
                                    effect.beforeBalance === null
                                      ? 'n/a'
                                      : formatUnitsString(effect.beforeBalance, effect.decimals)
                                  const afterBalance =
                                    effect.afterBalance === null
                                      ? 'n/a'
                                      : formatUnitsString(effect.afterBalance, effect.decimals)

                                  return (
                                    <article key={`${effect.tokenAddress}:${effect.holderAddress}`} class="tx-effect-item">
                                      <div class="tx-effect-cell tx-effect-holder-cell">
                                        <ResolvedAddressText address={effect.holderAddress} linked />
                                      </div>
                                      <div class="tx-effect-cell tx-effect-metric">
                                        <strong class={`tx-effect-delta ${BigInt(effect.delta) >= 0n ? 'is-positive' : 'is-negative'}`}>
                                          {formatTokenEffectDelta(effect.delta, effect.decimals)}
                                        </strong>
                                      </div>
                                      <div class="tx-effect-cell tx-effect-balance-inline">
                                        <span class="tx-effect-balance-before muted">{beforeBalance}</span>
                                        <span class="tx-effect-balance-arrow" aria-hidden="true">→</span>
                                        <span class="tx-effect-balance-after">{afterBalance}</span>
                                      </div>
                                    </article>
                                  )
                                })}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </section>
            </aside>
          </div>

          {resource.data.failure && (
            <PageSection
              className="tx-failure-section"
              title="Failure"
              description={
                resource.data.failure.replayBlockNumber === null
                  ? 'Decoded from replayed eth_call'
                  : `Decoded from replayed eth_call at block ${resource.data.failure.replayBlockNumber}`
              }
            >
              <KeyValueGrid
                items={[
                  { label: 'Message', value: resource.data.failure.message || 'Execution reverted' },
                  {
                    label: 'Error',
                    value: (
                      <span class="tx-failure-error-highlight">
                        {resource.data.failure.errorName ?? 'unknown custom error'}
                      </span>
                    ),
                  },
                  { label: 'Signature', value: <span class="mono">{resource.data.failure.signature ?? 'n/a'}</span> },
                  { label: 'Raw Data', value: <span class="mono">{resource.data.failure.rawData ?? 'n/a'}</span> },
                ]}
              />

              {resource.data.failure.args.length > 0 && (
                <SummaryTable headers={['Arg', 'Value']}>
                  {resource.data.failure.args.map((arg) => (
                    <tr key={`${arg.name}-${arg.value}`}>
                      <td>{arg.name}</td>
                      <td class="mono">{arg.value}</td>
                    </tr>
                  ))}
                </SummaryTable>
              )}
            </PageSection>
          )}

          <div class="tx-detail-tabs" role="tablist" aria-label="Transaction detail sections">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'overview'}
              class={`tx-detail-tab ${activeTab === 'overview' ? 'tx-detail-tab-active' : ''}`}
              onClick={() => setActiveTab('overview')}
            >
              Calldata + Logs
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'stack'}
              class={`tx-detail-tab ${activeTab === 'stack' ? 'tx-detail-tab-active' : ''}`}
              onClick={() => setActiveTab('stack')}
            >
              Stack Trace
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'debug'}
              class={`tx-detail-tab ${activeTab === 'debug' ? 'tx-detail-tab-active' : ''}`}
              onClick={() => setActiveTab('debug')}
            >
              Debug
            </button>
          </div>

          {activeTab === 'overview' && (
            <div class="tx-overview-columns">
              <div class="tx-overview-left">
                <TxDetailPanel
                  title="Calldata"
                  description="Raw input plus ABI-backed decode when available"
                  actions={
                    decodedCall ? (
                      <div class="panel-header-actions">
                        <button
                          type="button"
                          class={`section-header-toggle ${rawCalldataOpen ? 'is-active' : ''}`.trim()}
                          onClick={() => setRawCalldataOpen((current) => !current)}
                          aria-pressed={rawCalldataOpen}
                        >
                          {rawCalldataOpen ? 'Hide raw data' : 'Show raw data'}
                        </button>
                      </div>
                    ) : undefined
                  }
                >
                  {decodedCall ? (
                    <div class="decoded-card">
                      <p class="eyebrow">Decoded Function</p>
                      <strong>{decodedCall.signature}</strong>
                      <ul class="decoded-list">
                        {decodedCall.args.map((arg) => (
                          <li key={`${arg.name}-${arg.value}`}>
                            <span class="decoded-arg-name">{arg.name}</span>
                            <code class="decoded-arg-value">{arg.value}</code>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <>
                      <pre class="json-view mono calldata-view">{resource.data.transaction.input}</pre>
                      <p class="muted">
                        No matching ABI for this calldata.
                        {resource.data.transaction.to && !resource.data.contractAbi && (
                          <>
                            {' '}
                            <button
                              type="button"
                              class="link-button"
                              onClick={() => openAbiModal(resource.data!.transaction.to!)}
                            >
                              Attach an ABI
                            </button>
                            {' '}to decode.
                          </>
                        )}
                      </p>
                    </>
                  )}
                  {decodedCall && rawCalldataOpen && (
                    <pre class="json-view mono calldata-view">{resource.data.transaction.input}</pre>
                  )}
                </TxDetailPanel>

                <div class="tx-detail-section-spacer">
                  <TxDetailPanel title="Receipt Logs" description="Indexed event logs for this transaction">
                    {resource.data.logs.length === 0 && (
                      <EmptyState title="No logs emitted" body="This receipt has no indexed logs." />
                    )}
                    {resource.data.logs.length > 0 && (
                      <SummaryTable
                        className="summary-table-logs tx-receipt-logs-table"
                        headers={[
                          'Log',
                          'Address',
                          <span class="table-header-tooltip" data-tooltip="Click cell to decode">Topics</span>,
                          'Data',
                        ]}
                      >
                        {resource.data.logs.map((log) => {
                          const decoded = resource.data?.contractAbi
                            ? decodeLog(log, resource.data.contractAbi)
                            : null
                          const topicsText = log.topics.length > 0 ? log.topics.join('\n') : 'n/a'

                          return (
                            <tr key={`${log.txHash ?? 'tx'}-${log.logIndex ?? 0}`}>
                              <td>{log.logIndex ?? 'n/a'}</td>
                              <td>
                                <AddressLink address={log.address} />
                              </td>
                              <td class={decoded ? 'log-topic-decoded' : undefined}>
                                <LogDecodePopup decoded={decoded} trigger={<div class="log-data-cell mono">{topicsText}</div>} />
                              </td>
                              <td>
                                <div class="log-data-cell mono">{log.data}</div>
                              </td>
                            </tr>
                          )
                        })}
                      </SummaryTable>
                    )}
                  </TxDetailPanel>
                </div>
              </div>

              <div class="tx-overview-right">
                <TxDetailPanel
                  title="Call Tree"
                  description="On-demand call tree from debug_traceTransaction with callTracer."
                  actions={
                    trace && rawTrace ? (
                      <div class="panel-header-actions">
                        <button
                          type="button"
                          class={`section-header-toggle ${rawTraceOpen ? 'is-active' : ''}`.trim()}
                          onClick={() => setRawTraceOpen((current) => !current)}
                          aria-pressed={rawTraceOpen}
                        >
                          {rawTraceOpen ? 'Hide raw JSON' : 'Show raw JSON'}
                        </button>
                      </div>
                    ) : undefined
                  }
                >
                  {traceError && <ErrorState message={traceError} />}
                  {traceLoading && !trace && <p class="muted">Loading trace…</p>}
                  {!trace && !traceLoading && !traceError && (
                    <div class="panel-empty-action">
                      <button type="button" onClick={() => void loadTraceData()}>Load Call Tree</button>
                    </div>
                  )}
                  {trace && <TraceTree node={trace} />}
                  {rawTrace && rawTraceOpen && (
                    <div class="tx-detail-subsection-spacer">
                      <p class="eyebrow">Raw Trace JSON</p>
                      <JsonView value={rawTrace} />
                    </div>
                  )}
                </TxDetailPanel>
              </div>
            </div>
          )}

          {activeTab === 'stack' && (
            <section class="stack-trace-wrap">
              {traceLoading && !trace && <p class="muted">Loading trace…</p>}
              {traceError && <ErrorState message={traceError} />}
              {trace && (
                <StackTraceView
                  trace={trace}
                  opcodeTrace={opcodeTrace}
                  opcodeLoading={opcodeLoading}
                  onRequestOpcodeTrace={() => {
                    if (!opcodeTrace && !opcodeLoading) {
                      void loadOpcodeData(true)
                    }
                  }}
                  loadRuntimeCode={async (address) => {
                    const client = createAnvilClient(rpcUrl)
                    return getCode(
                      client,
                      address,
                      resource.data?.transaction.blockNumber !== null && resource.data?.transaction.blockNumber !== undefined
                        ? `0x${resource.data.transaction.blockNumber.toString(16)}`
                        : 'latest',
                    )
                  }}
                />
              )}
            </section>
          )}

          {activeTab === 'debug' && (
            <section class="debug-trace-wrap">
              {opcodeError && <ErrorState message={opcodeError} />}
              {opcodeLoading && !opcodeTrace && <p class="muted">Loading opcode trace…</p>}
              {opcodeTrace && opcodeTrace.entries.length === 0 && (
                <EmptyState
                  title="No opcode trace data"
                  body="debug_traceTransaction returned 0 struct logs. This is a known issue with some Anvil versions on forked chains. Try upgrading Foundry (foundryup) or restarting Anvil."
                />
              )}
              {opcodeTrace && opcodeTrace.entries.length > 0 && trace && (
                <DebugTraceView
                  trace={opcodeTrace}
                  callTree={trace}
                  txHash={props.hash as `0x${string}` | undefined}
                  loadRuntimeCode={async (address) => {
                    const client = createAnvilClient(rpcUrl)
                    return getCode(
                      client,
                      address,
                      resource.data?.transaction.blockNumber !== null && resource.data?.transaction.blockNumber !== undefined
                        ? `0x${resource.data.transaction.blockNumber.toString(16)}`
                        : 'latest',
                    )
                  }}
                />
              )}
              {opcodeTrace && opcodeTrace.entries.length > 0 && !trace && <p class="muted">Call tree is still loading. Debug mode starts after the frame tree is ready.</p>}
            </section>
          )}

          {abiResult && <p class="success-copy">{abiResult}</p>}

          {abiModalAddress && (
            <div class="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) closeAbiModal() }}>
              <div class="modal-dialog">
                <div class="modal-dialog-header">
                  <h3>Attach ABI</h3>
                  <button type="button" class="modal-close-button section-header-toggle" onClick={closeAbiModal} aria-label="Close">&times;</button>
                </div>
                <p class="muted">
                  Save an ABI for <span class="mono">{shortenHex(abiModalAddress)}</span> to decode calls and events.
                </p>
                {forgeScanResult ? (
                  <div class="stack-form">
                    <span class="field-label">
                      {forgeScanResult.candidates.length} matching contract{forgeScanResult.candidates.length === 1 ? '' : 's'} found
                    </span>
                    <div class="forge-match-list">
                      {forgeScanResult.candidates.map((candidate, index) => (
                        <label
                          key={candidate.artifactPath}
                          class={`forge-match-item${index === forgeSelectedIndex ? ' forge-match-item-selected' : ''}`}
                        >
                          <input
                            type="radio"
                            name="forge-match-modal"
                            checked={index === forgeSelectedIndex}
                            onChange={() => setForgeSelectedIndex(index)}
                          />
                          <div class="forge-match-info">
                            <span class="forge-match-name">{candidate.name}</span>
                            {candidate.sourcePath && (
                              <span class="forge-match-path muted">{candidate.sourcePath}</span>
                            )}
                          </div>
                          <div class="forge-match-badges">
                            {candidate.bytecodeMatch && (
                              <span class="forge-match-badge forge-match-badge-exact">exact</span>
                            )}
                            {candidate.hasSourceImages && (
                              <span class="forge-match-badge forge-match-badge-sources">sources</span>
                            )}
                            <span class={`forge-match-score${candidate.matchedSelectors === candidate.totalAbiSelectors ? ' forge-match-score-high' : ''}`}>
                              {candidate.matchedSelectors}/{candidate.onChainSelectors} selectors
                            </span>
                          </div>
                        </label>
                      ))}
                    </div>
                    <div class="button-row button-row-inline">
                      <button type="button" onClick={handleForgeConfirm}>Apply ABI</button>
                      <button type="button" onClick={() => setForgeScanResult(null)}>Back</button>
                    </div>
                    {forgeError && <ErrorState message={forgeError} />}
                  </div>
                ) : (
                  <form class="stack-form" onSubmit={handleAbiSubmit}>
                    <label>
                      <span class="field-label">Contract Label</span>
                      <input
                        value={contractLabel}
                        onInput={(event) => setContractLabel(event.currentTarget.value)}
                        placeholder="Treasury, Token, Vault, Router"
                      />
                    </label>
                    <label>
                      <span class="field-label">ABI JSON</span>
                      <textarea
                        rows={12}
                        value={abiSource}
                        onInput={(event) => setAbiSource(event.currentTarget.value)}
                        placeholder='[{"type":"function","name":"transfer",...}] or a Forge artifact JSON object'
                      />
                    </label>
                    <div class="button-row button-row-inline">
                      <button type="submit">Save ABI</button>
                      {isDirectoryPickerSupported() && (
                        <button type="button" onClick={handleForgeDetect} disabled={forgeDetecting}>
                          {forgeDetecting ? 'Scanning...' : 'Detect from Forge'}
                        </button>
                      )}
                      <button type="button" onClick={closeAbiModal}>Cancel</button>
                    </div>
                    {abiError && <ErrorState message={abiError} />}
                    {forgeError && <ErrorState message={forgeError} />}
                    <FoundryAbiTips />
                  </form>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </PageSection>
  )
}

function TraceTree(props: { node: TraceNode }) {
  return (
    <div class="trace-tree">
      <TraceTreeNode node={props.node} />
    </div>
  )
}

function TraceTreeNode(props: { node: TraceNode }) {
  const { node } = props
  const [expanded, setExpanded] = useState(false)
  const callLabel = node.signature ?? node.functionName ?? node.selector ?? 'fallback / receive'

  return (
    <div class="trace-node">
      <div class={`trace-card trace-status-${node.status}`}>
        <button
          type="button"
          class="trace-summary"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
        >
          <span class={`trace-chevron ${expanded ? 'trace-chevron-open' : ''}`}>▸</span>
          <span class="trace-summary-main">
            <span class="trace-summary-route">
              <AddressLink address={node.from} />
              <span class="muted">→</span>
              <AddressLink address={node.to} />
            </span>
            <span class="trace-summary-call mono">{callLabel}</span>
          </span>
          <span class="trace-summary-meta">
            <span class="muted mono">
              gas used {node.gasUsed === null ? 'n/a' : formatBigIntString(node.gasUsed)}
            </span>
            <span class="meta-badge meta-kind">{node.type}</span>
            <span class={`meta-badge meta-status meta-status-${node.status}`}>{node.status}</span>
          </span>
        </button>

        {expanded && (
          <div class="trace-details">
            <KeyValueGrid
              items={[
                { label: 'Value', value: node.value === null ? '0' : formatBigIntString(node.value) },
                { label: 'Gas', value: node.gas === null ? 'n/a' : formatBigIntString(node.gas) },
                { label: 'Gas Used', value: node.gasUsed === null ? 'n/a' : formatBigIntString(node.gasUsed) },
                { label: 'Selector', value: <span class="mono">{node.selector ?? '0x'}</span> },
                { label: 'Input', value: <span class="mono">{node.input}</span> },
                { label: 'Output', value: <span class="mono">{node.output ?? 'n/a'}</span> },
                { label: 'Error', value: node.error ?? node.revertReason ?? 'none' },
              ]}
            />

            {node.args.length > 0 && (
              <SummaryTable headers={['Arg', 'Value']}>
                {node.args.map((arg) => (
                  <tr key={`${node.id}-${arg.name}-${arg.value}`}>
                    <td>{arg.name}</td>
                    <td class="mono">{arg.value}</td>
                  </tr>
                ))}
              </SummaryTable>
            )}
          </div>
        )}
      </div>
      {node.calls.length > 0 && (
        <div class="trace-children">
          {node.calls.map((child) => (
            <TraceTreeNode key={child.id} node={child} />
          ))}
        </div>
      )}
    </div>
  )
}
