import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { parseUnits, toFunctionSelector, type Abi, type AbiParameter } from 'viem'
import { formatAbiItem, formatAbiParams } from 'viem/utils'
import {
  getAccountInsight,
  deleteAbi,
  deleteAddressLabel,
  getAbi,
  getAddressLabel,
  getDiscoveredContracts,
  getDiscoveredErc20ContractsForAddress,
  getDiscoveredHoldersForErc20Contract,
  getLogsForAddress,
  getTransactionsForAddress,
  upsertAbi,
  upsertAddressLabel,
  upsertCodeImage,
  upsertSourceFile,
} from '../lib/db.ts'
import { getDefaultAddressLabel } from '../lib/address-labels.ts'
import { decodeLog, toAbiRecord } from '../lib/decode.ts'
import {
  type BytecodeMatchScanResult,
  isDirectoryPickerSupported,
  pickDirectory,
  scanDirectoryForBytecodeMatch,
} from '../lib/forge-import.ts'
import { formatEtherString, formatTimestamp, formatUnitsString } from '../lib/format.ts'
import {
  createAnvilClient,
  getAddressKind,
  getCode,
  getErc20Balance,
  getErc20HolderBalance,
  getErc20TokenInfo,
  getNativeBalance,
  normalizeAddress,
} from '../lib/rpc.ts'
import { buildTransactionSummaries } from '../lib/transaction-meta.ts'
import { useAsyncResource } from '../hooks/use-async-resource.ts'
import { useExplorer } from '../hooks/use-explorer.tsx'
import { usePageMeta } from '../hooks/use-page-meta.ts'
import type { TransactionSummary } from '../lib/types.ts'
import { AccountInsightSection } from '../components/account-insight.tsx'
import {
  AddressKindBadge,
  AddressLink,
  BlockLink,
  EmptyState,
  ErrorState,
  FoundryAbiTips,
  KeyValueGrid,
  LoadingState,
  LogDecodePopup,
  MethodLabel,
  PageSection,
  SummaryTable,
  TransactionEnvelopeBadge,
  TransactionKindBadge,
  TransactionStatusBadge,
  TxLink,
} from '../components/common.tsx'

type RouteProps = {
  address?: string
  path?: string
}

type PublicContractFunction = {
  name: string
  params: PublicContractFunctionParam[]
  signature: string
  stateMutability: string
  callCount: number
}

type PublicContractFunctionParam = {
  label: string
  children: PublicContractFunctionParam[]
}

type PublicFunctionSortKey = 'name' | 'callCount'

function toPublicContractFunctionParam(param: AbiParameter): PublicContractFunctionParam {
  const children =
    'components' in param && Array.isArray(param.components)
      ? param.components.map(toPublicContractFunctionParam)
      : []
  const label =
    children.length > 0
      ? `${param.type}${param.name ? ` ${param.name}` : ''}`
      : formatAbiParams([param], { includeName: true })

  return {
    label,
    children,
  }
}

function hasNestedPublicContractParams(params: PublicContractFunctionParam[]): boolean {
  return params.some((param) => param.children.length > 0 || hasNestedPublicContractParams(param.children))
}

function renderPublicContractFunctionParams(
  params: PublicContractFunctionParam[],
  signatureKey: string,
  nested = false,
): ComponentChildren {
  return (
    <div class={`contract-function-param-list ${nested ? 'contract-function-param-list-nested' : ''}`.trim()}>
      {params.map((param, index) => {
        const suffix = index < params.length - 1 ? ',' : ''
        const key = `${signatureKey}-${nested ? 'nested' : 'root'}-${index}-${param.label}`

        return param.children.length > 0 ? (
          <details class="contract-function-param-disclosure" key={key}>
            <summary class="contract-function-param-summary">
              <span class="contract-function-param-toggle" aria-hidden="true">
                ›
              </span>
              <span class="contract-function-param">
                {param.label}
                {suffix}
              </span>
            </summary>
            {renderPublicContractFunctionParams(param.children, `${signatureKey}-${index}`, true)}
          </details>
        ) : (
          <div class="contract-function-param-node" key={key}>
            <span class="contract-function-param">
              {param.label}
              {suffix}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function getPublicContractFunctions(
  abi: Abi | null | undefined,
  transactions: TransactionSummary[],
  contractAddress: string | null | undefined,
): PublicContractFunction[] {
  if (!abi) {
    return []
  }

  const normalizedContractAddress = contractAddress?.toLowerCase() ?? null
  const callCountBySelector = new Map<string, number>()

  for (const transaction of transactions) {
    if (!normalizedContractAddress || transaction.to?.toLowerCase() !== normalizedContractAddress || !transaction.selector) {
      continue
    }

    const selector = transaction.selector.toLowerCase()
    callCountBySelector.set(selector, (callCountBySelector.get(selector) ?? 0) + 1)
  }

  const functions: PublicContractFunction[] = []

  for (const item of abi) {
    if (item.type !== 'function') {
      continue
    }

    const selector = toFunctionSelector(item).toLowerCase()
    const params = item.inputs.map(toPublicContractFunctionParam)
    functions.push({
      name: item.name,
      params,
      signature: formatAbiItem(item, { includeName: true }),
      stateMutability: item.stateMutability ?? 'nonpayable',
      callCount: callCountBySelector.get(selector) ?? 0,
    })
  }

  return functions.sort((left, right) => left.signature.localeCompare(right.signature))
}

export function AddressPage(props: RouteProps) {
  usePageMeta(props.address ? `Address ${props.address.slice(0, 10)}...` : 'Address', 'Inspect an address — balance, transactions, event logs, token holdings, contract ABI, and interaction graph.')
  const { actions, refreshKey, rpcUrl } = useExplorer()
  const normalizedAddress = props.address ? normalizeAddress(props.address) : null
  const [localVersion, setLocalVersion] = useState(0)
  const [labelEditing, setLabelEditing] = useState(false)
  const [abiSource, setAbiSource] = useState('')
  const [abiResult, setAbiResult] = useState<string | null>(null)
  const [abiError, setAbiError] = useState<string | null>(null)
  const [labelDraft, setLabelDraft] = useState('')
  const [labelResult, setLabelResult] = useState<string | null>(null)
  const [labelError, setLabelError] = useState<string | null>(null)
  const [publicFunctionSortKey, setPublicFunctionSortKey] = useState<PublicFunctionSortKey>('callCount')
  const [publicFunctionsExpanded, setPublicFunctionsExpanded] = useState(false)
  const [abiCopied, setAbiCopied] = useState(false)
  const [mintRecipient, setMintRecipient] = useState('')
  const [mintAmount, setMintAmount] = useState('1000')
  const [mintResult, setMintResult] = useState<string | null>(null)
  const [mintError, setMintError] = useState<string | null>(null)
  const [forgeDetecting, setForgeDetecting] = useState(false)
  const [forgeScanResult, setForgeScanResult] = useState<BytecodeMatchScanResult | null>(null)
  const [forgeSelectedIndex, setForgeSelectedIndex] = useState(0)
  const [forgeError, setForgeError] = useState<string | null>(null)

  async function handleAbiCopy() {
    if (!resource.data?.abi?.source || !navigator.clipboard) {
      return
    }

    await navigator.clipboard.writeText(resource.data.abi.source)
    setAbiError(null)
    setAbiCopied(true)
    window.setTimeout(() => setAbiCopied(false), 1200)
  }

  const resource = useAsyncResource(
    async () => {
      if (!normalizedAddress) {
        return null
      }

      const client = createAnvilClient(rpcUrl)

      const [transactions, logs, abi, kind, nativeBalance, discoveredTokens, tokenInfo, discoveredHolders, discoveredContracts, manualLabel, accountInsight] = await Promise.all([
        getTransactionsForAddress(normalizedAddress),
        getLogsForAddress(normalizedAddress),
        getAbi(normalizedAddress),
        getAddressKind(client, normalizedAddress),
        getNativeBalance(client, normalizedAddress),
        getDiscoveredErc20ContractsForAddress(normalizedAddress),
        getErc20TokenInfo(client, normalizedAddress),
        getDiscoveredHoldersForErc20Contract(normalizedAddress),
        getDiscoveredContracts(500),
        getAddressLabel(normalizedAddress),
        getAccountInsight(normalizedAddress, 10),
      ])

      const tokenBalances = (
        await Promise.all(
          discoveredTokens.map((token) =>
            getErc20Balance(client, token.tokenAddress, normalizedAddress, token.lastUpdatedBlock),
          ),
        )
      )
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .sort((left, right) => (right.lastUpdatedBlock ?? -1) - (left.lastUpdatedBlock ?? -1))

      const tokenHolders = tokenInfo
        ? (
            await Promise.all(
              discoveredHolders.map((holder) =>
                getErc20HolderBalance(client, normalizedAddress, holder.holderAddress, holder.lastUpdatedBlock),
              ),
            )
          )
            .filter((item): item is NonNullable<typeof item> => item !== null)
            .sort((left, right) => {
              const balanceDelta = BigInt(right.balance) - BigInt(left.balance)
              if (balanceDelta !== 0n) {
                return balanceDelta > 0n ? 1 : -1
              }

              return (right.lastUpdatedBlock ?? -1) - (left.lastUpdatedBlock ?? -1)
            })
        : []

      const defaultLabel = getDefaultAddressLabel(normalizedAddress)

      return {
        abi,
        accountInsight,
        contractDiscovery: discoveredContracts.find((item) => item.address === normalizedAddress) ?? null,
        defaultLabel,
        displayLabel: manualLabel?.label ?? defaultLabel,
        kind,
        logs,
        manualLabel,
        nativeBalance,
        tokenBalances,
        tokenHolders,
        tokenInfo,
        transactions: await buildTransactionSummaries(transactions),
      }
    },
    [refreshKey, localVersion, normalizedAddress, rpcUrl],
    null,
  )

  useEffect(() => {
    setLabelDraft(resource.data?.manualLabel?.label ?? '')
    setLabelEditing(false)
  }, [resource.data?.manualLabel?.label, normalizedAddress])

  useEffect(() => {
    setPublicFunctionsExpanded(false)
  }, [normalizedAddress])

  useEffect(() => {
    setAbiCopied(false)
  }, [normalizedAddress])

  const publicContractFunctions =
    resource.data?.kind === 'contract'
      ? getPublicContractFunctions(resource.data.abi?.abi, resource.data.transactions, normalizedAddress)
      : []
  const sortedPublicContractFunctions = [...publicContractFunctions].sort((left, right) => {
    if (publicFunctionSortKey === 'callCount') {
      const countDelta = right.callCount - left.callCount

      if (countDelta !== 0) {
        return countDelta
      }
    }

    return left.signature.localeCompare(right.signature)
  })
  const visiblePublicContractFunctions = publicFunctionsExpanded
    ? sortedPublicContractFunctions
    : sortedPublicContractFunctions.slice(0, 3)
  const hiddenPublicFunctionCount = Math.max(sortedPublicContractFunctions.length - visiblePublicContractFunctions.length, 0)

  async function handleLabelSubmit(event: Event) {
    event.preventDefault()
    setLabelError(null)
    setLabelResult(null)

    if (!normalizedAddress) {
      setLabelError('Invalid address')
      return
    }

    if (!labelDraft.trim()) {
      setLabelError('Enter a label or remove the current one')
      return
    }

    try {
      await upsertAddressLabel(normalizedAddress, labelDraft.trim())
      setLabelResult(`Saved label for ${normalizedAddress}`)
      setLabelEditing(false)
      setLocalVersion((current) => current + 1)
      actions.refresh()
    } catch (caughtError: unknown) {
      setLabelError(caughtError instanceof Error ? caughtError.message : 'Unable to save label')
    }
  }

  async function handleLabelDelete() {
    if (!normalizedAddress) {
      return
    }

    setLabelError(null)
    setLabelResult(null)

    try {
      await deleteAddressLabel(normalizedAddress)
      setLabelDraft('')
      setLabelEditing(false)
      setLabelResult(`Removed manual label for ${normalizedAddress}`)
      setLocalVersion((current) => current + 1)
      actions.refresh()
    } catch (caughtError: unknown) {
      setLabelError(caughtError instanceof Error ? caughtError.message : 'Unable to remove label')
    }
  }

  async function handleAbiSubmit(event: Event) {
    event.preventDefault()
    setAbiError(null)
    setAbiResult(null)

    if (!normalizedAddress) {
      setAbiError('Invalid contract address')
      return
    }

    try {
      await upsertAbi(toAbiRecord(normalizedAddress, abiSource))

      if (labelDraft.trim()) {
        await upsertAddressLabel(normalizedAddress, labelDraft.trim())
      }

      setAbiSource('')
      setAbiResult(`Saved ABI for ${normalizedAddress}`)
      setLocalVersion((current) => current + 1)
      actions.refresh()
    } catch (caughtError: unknown) {
      setAbiError(caughtError instanceof Error ? caughtError.message : 'Unable to save ABI')
    }
  }

  async function handleForgeDetect() {
    if (!normalizedAddress) return
    setForgeError(null)
    setForgeScanResult(null)
    setForgeSelectedIndex(0)
    setForgeDetecting(true)

    try {
      const client = createAnvilClient(rpcUrl)
      const bytecode = await getCode(client, normalizedAddress)
      if (!bytecode || bytecode === '0x') {
        setForgeError('No bytecode found at this address')
        setForgeDetecting(false)
        return
      }

      const dirHandle = await pickDirectory()
      const result = await scanDirectoryForBytecodeMatch(dirHandle, bytecode)

      if (result.candidates.length === 0) {
        setForgeError('No matching contracts found. Make sure you select the Forge project root (or out/ directory) after running forge build.')
        setForgeDetecting(false)
        return
      }

      setForgeScanResult(result)
    } catch (caughtError: unknown) {
      if (caughtError instanceof DOMException && caughtError.name === 'AbortError') {
        // User cancelled the directory picker
      } else {
        setForgeError(caughtError instanceof Error ? caughtError.message : 'Failed to scan directory')
      }
    }

    setForgeDetecting(false)
  }

  async function handleForgeConfirm() {
    if (!forgeScanResult || !normalizedAddress) return
    const candidate = forgeScanResult.candidates[forgeSelectedIndex]
    if (!candidate) return

    try {
      await upsertAbi(toAbiRecord(normalizedAddress, candidate.source))
      await upsertAddressLabel(normalizedAddress, candidate.name)

      // Save code images for the selected candidate
      const codeImages = forgeScanResult.codeImagesByArtifact.get(candidate.artifactPath) ?? []
      for (const image of codeImages) {
        await upsertCodeImage(image)
      }

      // Save all source files (source maps may reference any file in the project)
      for (const file of forgeScanResult.sourceFiles) {
        await upsertSourceFile(file)
      }

      setForgeScanResult(null)
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
      setAbiResult(`Saved ABI: ${candidate.name} (${parts.join(', ')})`)
      setLocalVersion((current) => current + 1)
      actions.refresh()
    } catch (caughtError: unknown) {
      setForgeError(caughtError instanceof Error ? caughtError.message : 'Failed to save ABI')
    }
  }

  function renderWalletLabelValue() {
    if (!resource.data) {
      return 'n/a'
    }

    const data = resource.data

    if (!labelEditing) {
      return (
        <div class="wallet-label-inline">
          <span>{data.displayLabel ?? 'n/a'}</span>
          <button type="button" class="section-header-toggle" onClick={() => setLabelEditing(true)}>
            {data.manualLabel ? 'Edit label' : 'Add label'}
          </button>
        </div>
      )
    }

    return (
      <form class="wallet-label-editor" onSubmit={handleLabelSubmit}>
        <input
          value={labelDraft}
          onInput={(event) => setLabelDraft(event.currentTarget.value)}
          placeholder={data.defaultLabel ?? 'Deployer, Treasury Wallet, Test User'}
        />
        <button type="submit">Save</button>
        <button
          type="button"
          onClick={() => {
            setLabelDraft(data.manualLabel?.label ?? '')
            setLabelError(null)
            setLabelResult(null)
            setLabelEditing(false)
          }}
        >
          Cancel
        </button>
        {data.manualLabel && (
          <button type="button" onClick={handleLabelDelete}>
            Remove
          </button>
        )}
      </form>
    )
  }

  function renderContractLabelActions() {
    if (!resource.data) {
      return null
    }

    const data = resource.data

    if (!labelEditing) {
      return (
        <div class="wallet-label-inline">
          <button type="button" onClick={() => setLabelEditing(true)}>
            {data.manualLabel ? 'Edit label' : 'Add label'}
          </button>
        </div>
      )
    }

    return (
      <form class="wallet-label-editor panel-header-actions" onSubmit={handleLabelSubmit}>
        <input
          value={labelDraft}
          onInput={(event) => setLabelDraft(event.currentTarget.value)}
          placeholder={data.defaultLabel ?? 'Treasury, Router, Vault, Token'}
        />
        <button type="submit">Save</button>
        <button
          type="button"
          onClick={() => {
            setLabelDraft(data.manualLabel?.label ?? '')
            setLabelError(null)
            setLabelResult(null)
            setLabelEditing(false)
          }}
        >
          Cancel
        </button>
        {data.manualLabel && (
          <button type="button" onClick={handleLabelDelete}>
            Remove
          </button>
        )}
      </form>
    )
  }

  async function handleAbiDelete() {
    if (!normalizedAddress) {
      return
    }

    setAbiError(null)
    setAbiResult(null)

    try {
      await deleteAbi(normalizedAddress)
      setAbiResult(`Deleted ABI for ${normalizedAddress}`)
      setLocalVersion((current) => current + 1)
      actions.refresh()
    } catch (caughtError: unknown) {
      setAbiError(caughtError instanceof Error ? caughtError.message : 'Unable to delete ABI')
    }
  }

  function renderTransactions() {
    if (!resource.data) {
      return null
    }

    return (
      <PageSection title="Transactions" description="Most recent sent or received transactions">
        {resource.data.transactions.length === 0 ? (
          <EmptyState title="No transactions" body="This address is not present in the indexed transaction set." />
        ) : (
          <SummaryTable className="summary-table-transactions summary-table-transactions-address" headers={['Hash', 'Type', 'Method', 'Block', 'Status', 'Timestamp']}>
            {resource.data.transactions.map((transaction) => (
              <tr key={transaction.hash}>
                <td>
                  <TxLink hash={transaction.hash} />
                </td>
                <td>
                  <div class="tx-meta-inline tx-type-inline">
                    <TransactionKindBadge kind={transaction.kind} />
                    <TransactionEnvelopeBadge envelope={transaction.envelope} />
                  </div>
                </td>
                <td>
                  <MethodLabel method={transaction.method} selector={transaction.selector} />
                </td>
                <td>
                  <BlockLink number={transaction.blockNumber} />
                </td>
                <td>
                  <TransactionStatusBadge status={transaction.status} />
                </td>
                <td>{formatTimestamp(transaction.timestamp)}</td>
              </tr>
            ))}
          </SummaryTable>
        )}
      </PageSection>
    )
  }

  function renderLogs() {
    if (!resource.data || resource.data.kind !== 'contract') {
      return null
    }

    const contractAbi = resource.data.abi?.abi

    return (
      <PageSection title="Logs" description="Most recent indexed logs emitted by this address">
        {resource.data.logs.length === 0 ? (
          <EmptyState title="No logs" body="This address has not emitted any indexed logs yet." />
        ) : (
          <SummaryTable
            className="summary-table-logs summary-table-logs-address"
            headers={[
              'Block',
              'Tx',
              <span class="table-header-tooltip" data-tooltip="Click cell to decode">Topics</span>,
              'Data',
            ]}
          >
            {resource.data.logs.map((log) => {
              const decoded = contractAbi ? decodeLog(log, contractAbi) : null
              const topicsText = log.topics.length > 0 ? log.topics.join('\n') : 'n/a'

              return (
                <tr key={`${log.txHash ?? 'tx'}-${log.logIndex ?? 0}`}>
                  <td>
                    <BlockLink number={log.blockNumber} />
                  </td>
                  <td>{log.txHash ? <TxLink hash={log.txHash} /> : 'n/a'}</td>
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
      </PageSection>
    )
  }

  function renderTokenSection() {
    if (!resource.data) {
      return null
    }

    if (resource.data.kind === 'contract' && resource.data.tokenInfo) {
      const tokenInfo = resource.data.tokenInfo

      return (
        <PageSection
          title="Token Holders"
          description="Holder balances discovered from this contract's indexed Transfer logs"
        >
          {resource.data.tokenHolders.length === 0 ? (
            <EmptyState
              title="No discovered holders"
              body="No indexed Transfer logs currently identify token holders for this contract."
            />
          ) : (
            <SummaryTable headers={['Holder', 'Balance', 'Last Seen']}>
              {resource.data.tokenHolders.map((holder) => (
                <tr key={holder.holderAddress}>
                  <td>
                    <AddressLink address={holder.holderAddress} />
                  </td>
                  <td>
                    {formatUnitsString(
                      holder.balance,
                      tokenInfo.decimals,
                      tokenInfo.symbol ?? undefined,
                    )}
                  </td>
                  <td>{holder.lastUpdatedBlock === null ? 'n/a' : <BlockLink number={holder.lastUpdatedBlock} />}</td>
                </tr>
              ))}
            </SummaryTable>
          )}
        </PageSection>
      )
    }

    if (resource.data.kind === 'contract') {
      return null
    }

    return (
      <PageSection
        title="ERC-20 Balances"
        description="Token balances discovered from indexed Transfer logs"
      >
        {resource.data.tokenBalances.length === 0 ? (
          <EmptyState
            title="No discovered ERC-20 balances"
            body="No indexed Transfer logs currently tie this address to a token contract."
          />
        ) : (
          <SummaryTable className="summary-table-account-balances" headers={['Token', 'Symbol', 'Balance', 'Last Seen']}>
            {resource.data.tokenBalances.map((token) => (
              <tr key={token.tokenAddress}>
                <td>
                  <AddressLink address={token.tokenAddress} />
                </td>
                <td>{token.symbol ?? token.name ?? 'n/a'}</td>
                <td>{formatUnitsString(token.balance, token.decimals, token.symbol ?? undefined)}</td>
                <td>{token.lastUpdatedBlock === null ? 'n/a' : <BlockLink number={token.lastUpdatedBlock} />}</td>
              </tr>
            ))}
          </SummaryTable>
        )}
      </PageSection>
    )
  }

  return (
    <>
      {resource.loading && <LoadingState label="Loading address activity" />}
      {resource.error && <ErrorState message={resource.error} />}
      {!resource.loading && !normalizedAddress && (
        <EmptyState title="Invalid address" body="Use a valid 20-byte hex address in the route or search." />
      )}
      {resource.data &&
        (resource.data.kind === 'contract' ? (
          <div class="detail-layout">
            <div class="detail-main">
              <PageSection
                title={resource.data.displayLabel ?? 'Contract'}
                description={normalizedAddress ?? undefined}
                actions={renderContractLabelActions()}
              >
                <p class="muted">Contract activity, emitted logs, and token side effects indexed from your local Anvil chain.</p>
                {labelResult && <p class="success-copy">{labelResult}</p>}
                {labelError && <ErrorState message={labelError} />}
              </PageSection>
              {renderTokenSection()}
              <AccountInsightSection address={normalizedAddress!} relations={resource.data.accountInsight} />
              {renderTransactions()}
              {renderLogs()}
            </div>
            <aside class="detail-sidebar">
              <PageSection title="Contract Details" description="Stored explorer metadata for this contract">
                <KeyValueGrid
                  items={[
                    { label: 'Address', value: <span class="mono">{normalizedAddress}</span> },
                    { label: 'Label', value: resource.data.displayLabel ?? 'n/a' },
                    {
                      label: 'Label Source',
                      value: resource.data.manualLabel ? 'manual' : resource.data.defaultLabel ? 'anvil default' : 'none',
                    },
                    { label: 'Type', value: <AddressKindBadge kind={resource.data.kind} /> },
                    { label: 'Native Balance', value: formatEtherString(resource.data.nativeBalance) },
                    { label: 'ERC-20', value: resource.data.tokenInfo ? 'yes' : 'no' },
                    { label: 'ABI', value: resource.data.abi ? 'available' : 'missing' },
                    { label: 'Transactions', value: resource.data.transactions.length },
                    { label: 'Logs', value: resource.data.logs.length },
                    { label: 'Sources', value: resource.data.contractDiscovery?.sources.join(', ') ?? 'manual' },
                  ]}
                />
              </PageSection>

              {resource.data.tokenInfo && (
                <>
                  <PageSection title="Token Metadata" description="Live ERC-20 metadata read from the contract">
                    <KeyValueGrid
                      items={[
                        { label: 'Name', value: resource.data.tokenInfo.name ?? 'n/a' },
                        { label: 'Symbol', value: resource.data.tokenInfo.symbol ?? 'n/a' },
                        { label: 'Decimals', value: resource.data.tokenInfo.decimals },
                        {
                          label: 'Total Supply',
                          value: formatUnitsString(
                            resource.data.tokenInfo.totalSupply,
                            resource.data.tokenInfo.decimals,
                            resource.data.tokenInfo.symbol ?? undefined,
                          ),
                        },
                      ]}
                    />
                  </PageSection>

                  <PageSection title="Mint Tokens" description={`Deal ${resource.data.tokenInfo.symbol ?? 'tokens'} via storage slot manipulation`}>
                    {mintResult && <p class="success-copy">{mintResult}</p>}
                    {mintError && <ErrorState message={mintError} />}
                    <div class="stack-form">
                      <input
                        value={mintRecipient}
                        onInput={(event) => setMintRecipient(event.currentTarget.value)}
                        placeholder="Recipient address"
                      />
                      <input
                        value={mintAmount}
                        onInput={(event) => setMintAmount(event.currentTarget.value)}
                        placeholder={`Amount (${resource.data.tokenInfo.symbol ?? 'tokens'})`}
                      />
                      <button
                        onClick={async () => {
                          setMintError(null)
                          setMintResult(null)
                          try {
                            const decimals = resource.data!.tokenInfo!.decimals
                            const amount = parseUnits(mintAmount, decimals)
                            await actions.dealErc20(normalizedAddress!, mintRecipient, amount)
                            const label = resource.data!.tokenInfo!.symbol ?? 'tokens'
                            setMintResult(`Minted ${mintAmount} ${label} to ${mintRecipient}`)
                          } catch (caughtError: unknown) {
                            setMintError(caughtError instanceof Error ? caughtError.message : 'Mint failed')
                          }
                        }}
                      >
                        Mint
                      </button>
                    </div>
                  </PageSection>
                </>
              )}

              <PageSection title="Public Functions" description="Callable methods derived from the attached ABI">
                {resource.data.abi ? (
                  sortedPublicContractFunctions.length > 0 ? (
                    <>
                      <div class="contract-function-toolbar">
                        <div class="function-sort-toggle" aria-label="Sort public functions">
                          <span class="function-sort-ribbon">Sort</span>
                          <button
                            type="button"
                            class={`function-sort-button ${publicFunctionSortKey === 'name' ? 'is-active' : ''}`.trim()}
                            onClick={() => setPublicFunctionSortKey('name')}
                          >
                            Name
                          </button>
                          <button
                            type="button"
                            class={`function-sort-button ${publicFunctionSortKey === 'callCount' ? 'is-active' : ''}`.trim()}
                            onClick={() => setPublicFunctionSortKey('callCount')}
                          >
                            Calls
                          </button>
                        </div>
                        <p class="muted contract-function-toolbar-copy">
                          Format: <code>[call count] functionName(type paramName, ...) [mutability]</code>
                        </p>
                      </div>
                      <div class="contract-function-list">
                        {visiblePublicContractFunctions.map((item) => (
                          <div class="contract-function-item" key={item.signature}>
                            <span class="meta-badge contract-function-count">{item.callCount}</span>
                            <div class="contract-function-signature mono">
                              {item.params.length > 3 || hasNestedPublicContractParams(item.params) ? (
                                <div class="contract-function-signature-block">
                                  <span class="contract-function-signature-line">{item.name}(</span>
                                  {renderPublicContractFunctionParams(item.params, item.signature)}
                                  <span class="contract-function-signature-line">)</span>
                                </div>
                              ) : (
                                item.signature
                              )}
                            </div>
                            <span class="meta-badge contract-function-mutability">{item.stateMutability}</span>
                          </div>
                        ))}
                      </div>
                      {sortedPublicContractFunctions.length > 3 && (
                        <div class="contract-function-expand">
                          <button
                            type="button"
                            class="section-header-toggle"
                            onClick={() => setPublicFunctionsExpanded((current) => !current)}
                            aria-expanded={publicFunctionsExpanded}
                          >
                            {publicFunctionsExpanded
                              ? 'Show fewer functions'
                              : `Show ${hiddenPublicFunctionCount} more function${hiddenPublicFunctionCount === 1 ? '' : 's'}`}
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <p class="muted">The attached ABI does not expose any callable functions.</p>
                  )
                ) : (
                  <p class="muted">Attach an ABI to list this contract&apos;s publicly callable functions.</p>
                )}
              </PageSection>

              <PageSection
                title="Contract ABI"
                description="Attach an ABI here to decode contract calls, events, and custom errors for this contract"
                actions={isDirectoryPickerSupported() ? (
                  <button type="button" class="section-header-toggle" onClick={handleForgeDetect} disabled={forgeDetecting}>
                    {forgeDetecting ? 'Scanning...' : 'Detect from Forge'}
                  </button>
                ) : undefined}
              >
                <div class="contract-abi-summary-row">
                  <KeyValueGrid
                    items={[
                      { label: 'ABI Status', value: resource.data.abi ? 'attached' : 'missing' },
                      {
                        label: 'Updated',
                        value: resource.data.abi ? new Date(resource.data.abi.updatedAt).toLocaleString() : 'n/a',
                      },
                    ]}
                  />
                  {resource.data.abi && (
                    <div class="contract-abi-summary-action">
                      <button type="button" class="section-header-toggle" onClick={handleAbiCopy}>
                        Copy ABI
                      </button>
                      {abiCopied && (
                        <span class="contract-abi-copy-toast" role="status">
                          Copied
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <details class="abi-disclosure">
                  <summary class="abi-disclosure-summary">
                    <div class="abi-disclosure-copy">
                      <span class="abi-disclosure-title">
                        {resource.data.abi ? 'Show attached ABI' : 'Add or paste ABI'}
                      </span>
                      {!resource.data.abi && (
                        <span class="muted">Paste a raw ABI array or a Forge artifact JSON object.</span>
                      )}
                    </div>
                    <span class="abi-disclosure-chevron" aria-hidden="true">
                      ›
                    </span>
                  </summary>
                  <div class="abi-disclosure-body">
                    {resource.data.abi ? (
                      <div class="stack-form">
                        <label>
                          <span class="field-label">Attached ABI</span>
                          <textarea rows={14} value={resource.data.abi.source} readOnly />
                        </label>
                        <div class="button-row button-row-inline">
                          <button type="button" onClick={handleAbiDelete}>
                            Delete ABI
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
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
                                    name="forge-match"
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
                            {(() => {
                              const selected = forgeScanResult.candidates[forgeSelectedIndex]
                              return selected && selected.hasSourceImages && !selected.bytecodeMatch && selected.compiledBytes > 0 ? (
                                <div class="forge-mismatch-warning">
                                  <p>
                                    <strong>Bytecode mismatch</strong> — debug tracing requires bytecodes to match exactly.
                                    Your compiled bytecode is {selected.compiledBytes.toLocaleString()} bytes but on-chain
                                    is {selected.onChainBytes.toLocaleString()} bytes.
                                  </p>
                                  <p>
                                    This usually means different <code>optimizer_runs</code> in <code>foundry.toml</code>.
                                    Match the original deployment settings and run <code>forge build --force</code>, then
                                    detect again. The ABI will still be applied for call/event decoding.
                                  </p>
                                </div>
                              ) : null
                            })()}
                            <div class="button-row button-row-inline">
                              <button type="button" onClick={handleForgeConfirm}>
                                Apply ABI
                              </button>
                              <button type="button" onClick={() => setForgeScanResult(null)}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <form class="stack-form" onSubmit={handleAbiSubmit}>
                            <label>
                              <span class="field-label">ABI JSON</span>
                              <textarea
                                rows={14}
                                value={abiSource}
                                onInput={(event) => setAbiSource(event.currentTarget.value)}
                                placeholder='[{"type":"function","name":"transfer",...}] or a Forge artifact JSON object'
                              />
                            </label>
                            <button type="submit">Save ABI</button>
                          </form>
                        )}
                        {forgeError && <ErrorState message={forgeError} />}
                      </>
                    )}
                    <FoundryAbiTips />
                  </div>
                </details>
                {abiResult && <p class="success-copy">{abiResult}</p>}
                {abiError && <ErrorState message={abiError} />}
              </PageSection>
            </aside>
          </div>
        ) : (
          <>
            <div class="detail-layout detail-layout-account">
              <div class="detail-main">
                <PageSection title={resource.data.displayLabel ?? 'Wallet'} description={normalizedAddress ?? undefined}>
                  <KeyValueGrid
                    items={[
                      { label: 'Address', value: <span class="mono">{normalizedAddress}</span> },
                      { label: 'Label', value: renderWalletLabelValue() },
                      {
                        label: 'Label Source',
                        value: resource.data.manualLabel ? 'manual' : resource.data.defaultLabel ? 'anvil default' : 'none',
                      },
                      { label: 'Type', value: <AddressKindBadge kind={resource.data.kind} /> },
                      { label: 'Native Balance', value: formatEtherString(resource.data.nativeBalance) },
                      { label: 'Transactions', value: resource.data.transactions.length },
                    ]}
                  />
                  {labelResult && <p class="success-copy">{labelResult}</p>}
                  {labelError && <ErrorState message={labelError} />}
                </PageSection>
              </div>
              <aside class="detail-sidebar">{renderTokenSection()}</aside>
            </div>
            <AccountInsightSection address={normalizedAddress!} relations={resource.data.accountInsight} />
            {renderTransactions()}
          </>
        ))}
    </>
  )
}
