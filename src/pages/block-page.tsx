import { getBlock, getTransactionsByBlock } from '../lib/db.ts'
import { formatBigIntString, formatNumber, formatTimestamp, parseNumberInput } from '../lib/format.ts'
import { buildTransactionSummaries } from '../lib/transaction-meta.ts'
import { useAsyncResource } from '../hooks/use-async-resource.ts'
import { useExplorer } from '../hooks/use-explorer.tsx'
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
  const { refreshKey } = useExplorer()
  const blockNumber = parseNumberInput(props.number ?? '')
  const resource = useAsyncResource(
    async () => {
      if (blockNumber === null) {
        return null
      }

      const [block, transactions] = await Promise.all([
        getBlock(blockNumber),
        getTransactionsByBlock(blockNumber),
      ])

      return {
        block,
        transactions: await buildTransactionSummaries(transactions),
      }
    },
    [refreshKey, blockNumber],
    null,
  )

  return (
    <PageSection
      title={blockNumber === null ? 'Block' : `Block #${formatNumber(blockNumber)}`}
      description="Stored block header plus indexed transactions"
    >
      {resource.loading && <LoadingState label="Loading block" />}
      {resource.error && <ErrorState message={resource.error} />}
      {!resource.loading && blockNumber === null && (
        <EmptyState title="Invalid block number" body="Use a decimal block number in the route or search box." />
      )}
      {!resource.loading && resource.data && !resource.data.block && (
        <EmptyState title="Block not found" body="That block number is not in IndexedDB yet." />
      )}
      {resource.data?.block && (
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
