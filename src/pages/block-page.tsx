import { getBlock, getTransactionsByBlock } from '../lib/db.ts'
import { formatBigIntString, formatNumber, formatTimestamp, parseNumberInput } from '../lib/format.ts'
import { createAnvilClient, getBlockByNumber } from '../lib/rpc.ts'
import { normalizeBlock, normalizeTransaction, persistBlock } from '../lib/sync.ts'
import { buildTransactionSummaries } from '../lib/transaction-meta.ts'
import { useAsyncResource } from '../hooks/use-async-resource.ts'
import { useExplorer } from '../hooks/use-explorer.tsx'
import { usePageMeta } from '../hooks/use-page-meta.ts'
import { route } from 'preact-router'
import {
  AddressLink,
  EmptyState,
  ErrorState,
  KeyValueGrid,
  LoadingState,
  MethodLabel,
  PageSection,
  SummaryTable,
  TransactionEnvelopeBadge,
  TransactionKindBadge,
  TransactionStatusBadge,
  TxLink,
} from '../components/common.tsx'

type RouteProps = {
  number?: string
  path?: string
}

export function BlockPage(props: RouteProps) {
  usePageMeta(props.number ? `Block ${props.number}` : 'Block', 'Inspect a single Anvil block — header fields, gas stats, and every transaction in the block.')
  const { actions, refreshKey, rpcUrl, chainMeta } = useExplorer()
  const blockNumber = parseNumberInput(props.number ?? '')
  const forkBlockNumber = chainMeta?.forkConfig?.forkBlockNumber ?? null
  const isPreFork = forkBlockNumber !== null && blockNumber !== null && blockNumber < forkBlockNumber

  const resource = useAsyncResource(
    async () => {
      if (blockNumber === null) {
        return null
      }

      const client = createAnvilClient(rpcUrl)

      const [block, transactions] = await Promise.all([
        getBlock(blockNumber),
        getTransactionsByBlock(blockNumber),
      ])

      if (block) {
        return {
          block,
          transactions: await buildTransactionSummaries(transactions, client),
        }
      }

      // Block not indexed — fetch from RPC and index it
      try {
        const rpcBlock = await getBlockByNumber(client, blockNumber)
        if (!rpcBlock) {
          return { block: undefined, transactions: [] }
        }

        await persistBlock(client, rpcBlock)
        actions.refresh()

        const [storedBlock, storedTxs] = await Promise.all([
          getBlock(blockNumber),
          getTransactionsByBlock(blockNumber),
        ])

        return {
          block: storedBlock ?? normalizeBlock(rpcBlock),
          transactions: await buildTransactionSummaries(
            storedTxs.length > 0 ? storedTxs : rpcBlock.transactions.map(normalizeTransaction),
            client,
          ),
        }
      } catch {
        return { block: undefined, transactions: [] }
      }
    },
    [refreshKey, blockNumber, isPreFork, rpcUrl],
    null,
  )

  const upperBound = chainMeta?.latestBlockNumber ?? null
  const hasPrev = blockNumber !== null && blockNumber > 0
  const hasNext = blockNumber !== null && upperBound !== null && blockNumber < upperBound

  const displayedBlock = resource.data?.block
  const isStale = displayedBlock && blockNumber !== null && displayedBlock.number !== blockNumber
  const showLoading = resource.loading || isStale

  const title = (
    <span class="block-title-row">
      <button type="button" class="block-nav-btn" disabled={!hasPrev} onClick={() => hasPrev && route(`/blocks/${blockNumber! - 1}`)}>←</button>
      <button type="button" class="block-nav-btn" disabled={!hasNext} onClick={() => hasNext && route(`/blocks/${blockNumber! + 1}`)}>→</button>
      <span>{blockNumber === null ? 'Block' : `Block #${formatNumber(blockNumber)}`}</span>
    </span>
  )

  return (
    <PageSection
      title={title}
      description="Stored block header plus indexed transactions"
    >
      {showLoading && <LoadingState label={`Loading block ${blockNumber !== null ? '#' + formatNumber(blockNumber) : ''}…`} />}
      {resource.error && <ErrorState message={resource.error} />}
      {!showLoading && blockNumber === null && (
        <EmptyState title="Invalid block number" body="Use a decimal block number in the route or search box." />
      )}
      {!showLoading && resource.data && !resource.data.block && (
        <EmptyState title="Block not found" body="Could not find this block in IndexedDB or via RPC." />
      )}
      {!isStale && resource.data?.block && (
        <>
          <KeyValueGrid
            items={[
              { label: 'Hash', value: <span class="mono">{resource.data.block.hash}</span> },
              { label: 'Parent', value: <span class="mono">{resource.data.block.parentHash}</span> },
              { label: 'Miner', value: <AddressLink address={resource.data.block.miner} /> },
              { label: 'Timestamp', value: formatTimestamp(resource.data.block.timestamp) },
              { label: 'Gas Used', value: formatBigIntString(resource.data.block.gasUsed) },
              { label: 'Gas Limit', value: formatBigIntString(resource.data.block.gasLimit) },
            ]}
          />

          <SummaryTable className="summary-table-transactions" headers={['Index', 'Hash', 'Type', 'Method', 'Status', 'Timestamp']}>
            {resource.data.transactions.map((transaction) => (
              <tr key={transaction.hash}>
                <td>{transaction.transactionIndex ?? 'n/a'}</td>
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
                  <div class="tx-meta-stack">
                    <MethodLabel method={transaction.method} selector={transaction.selector} />
                  </div>
                </td>
                <td>
                  <TransactionStatusBadge status={transaction.status} />
                </td>
                <td>{formatTimestamp(transaction.timestamp)}</td>
              </tr>
            ))}
          </SummaryTable>
        </>
      )}
    </PageSection>
  )
}
