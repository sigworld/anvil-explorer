import { getLatestBlocks, getLatestTransactions, getTransactionsInLatestBlockWindow } from '../lib/db.ts'
import { formatNumber, formatTimestamp, shortenHex } from '../lib/format.ts'
import { buildAddressActivitySummaries, buildFailedTransactionSummaries, buildTransactionSummaries } from '../lib/transaction-meta.ts'
import { useAsyncResource } from '../hooks/use-async-resource.ts'
import { useExplorer } from '../hooks/use-explorer.tsx'
import { usePageMeta } from '../hooks/use-page-meta.ts'
import { createAnvilClient, getAddressKind } from '../lib/rpc.ts'
import {
  AppLink,
  AddressLink,
  BlockLink,
  EmptyState,
  ErrorState,
  LoadingState,
  MethodLabel,
  PageSection,
  SummaryTable,
  TransactionStatusBadge,
  TxLink,
} from '../components/common.tsx'

type RouteProps = { path?: string }

const FAILED_TX_BLOCK_WINDOW = 10
const ACTIVITY_BLOCK_WINDOW = 50
const FAILED_TX_LIMIT = 8
const ACTIVITY_LIMIT = 8
const ACTIVITY_CANDIDATE_LIMIT = 24

async function resolveAddressActivity(
  rpcUrl: string,
  candidates: ReturnType<typeof buildAddressActivitySummaries>,
  expectedKind: 'wallet' | 'contract',
) {
  const client = createAnvilClient(rpcUrl)
  const shortlisted = candidates.slice(0, ACTIVITY_CANDIDATE_LIMIT)
  const resolved = await Promise.all(
    shortlisted.map(async (candidate) => {
      try {
        const kind = await getAddressKind(client, candidate.address)
        return kind === expectedKind ? candidate : null
      } catch {
        return null
      }
    }),
  )

  return resolved.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null).slice(0, ACTIVITY_LIMIT)
}

export function HomePage(_: RouteProps) {
  usePageMeta('Overview', 'Live overview of your local Anvil chain — recent blocks, transactions, active wallets, and top contracts.')
  const { refreshKey, rpcUrl } = useExplorer()
  const recentBlocks = useAsyncResource(() => getLatestBlocks(8), [refreshKey], [])
  const recentTransactions = useAsyncResource(
    async () => buildTransactionSummaries(await getLatestTransactions(8)),
    [refreshKey],
    [],
  )
  const recentFailures = useAsyncResource(
    async () => buildFailedTransactionSummaries(await getTransactionsInLatestBlockWindow(FAILED_TX_BLOCK_WINDOW), FAILED_TX_LIMIT),
    [refreshKey],
    [],
  )
  const topWallets = useAsyncResource(
    async () =>
      resolveAddressActivity(
        rpcUrl,
        buildAddressActivitySummaries(await getTransactionsInLatestBlockWindow(ACTIVITY_BLOCK_WINDOW), 'from'),
        'wallet',
      ),
    [refreshKey, rpcUrl],
    [],
  )
  const topContracts = useAsyncResource(
    async () =>
      resolveAddressActivity(
        rpcUrl,
        buildAddressActivitySummaries(await getTransactionsInLatestBlockWindow(ACTIVITY_BLOCK_WINDOW), 'to'),
        'contract',
      ),
    [refreshKey, rpcUrl],
    [],
  )

  return (
    <section class="overview-stack">
      <PageSection
        title="Recent Failed Transactions"
        description={`Failed receipts found in the last ${FAILED_TX_BLOCK_WINDOW} indexed blocks`}
      >
        {recentFailures.loading && <LoadingState label="Loading recent failures" />}
        {recentFailures.error && <ErrorState message={recentFailures.error} />}
        {!recentFailures.loading && recentFailures.data.length === 0 && (
          <EmptyState
            title="No recent failures"
            body={`The last ${FAILED_TX_BLOCK_WINDOW} indexed blocks contain no failed transactions.`}
          />
        )}
        {recentFailures.data.length > 0 && (
          <SummaryTable className="summary-table-failures" headers={['Hash', 'Method', 'From', 'Block', 'Timestamp']}>
            {recentFailures.data.map((transaction) => (
              <tr key={transaction.hash}>
                <td>
                  <TxLink hash={transaction.hash} />
                </td>
                <td>
                  <div class="tx-meta-stack">
                    <MethodLabel method={transaction.method} selector={transaction.selector} />
                  </div>
                </td>
                <td>
                  <AddressLink address={transaction.from} />
                </td>
                <td>
                  <BlockLink number={transaction.blockNumber} />
                </td>
                <td>{formatTimestamp(transaction.timestamp)}</td>
              </tr>
            ))}
          </SummaryTable>
        )}
      </PageSection>

      <div class="overview-activity-grid">
        <PageSection
          title="Top Active Wallets"
          description={`Highest outbound transaction counts over the last ${ACTIVITY_BLOCK_WINDOW} indexed blocks`}
        >
          {topWallets.loading && <LoadingState label="Loading active wallets" />}
          {topWallets.error && <ErrorState message={topWallets.error} />}
          {!topWallets.loading && topWallets.data.length === 0 && (
            <EmptyState
              title="No active wallets"
              body={`No wallet initiators were identified in the last ${ACTIVITY_BLOCK_WINDOW} indexed blocks.`}
            />
          )}
          {topWallets.data.length > 0 && (
            <SummaryTable className="summary-table-leaderboard summary-table-leaderboard-overview" headers={['Address', 'Tx Count', 'Last Seen']}>
              {topWallets.data.map((wallet) => (
                <tr key={wallet.address}>
                  <td>
                    <AddressLink address={wallet.address} />
                  </td>
                  <td>{formatNumber(wallet.count)}</td>
                  <td>
                    <BlockLink number={wallet.lastSeenBlock} />
                  </td>
                </tr>
              ))}
            </SummaryTable>
          )}
        </PageSection>

        <PageSection
          title="Most Interacted Contracts"
          description={`Most frequently targeted contracts over the last ${ACTIVITY_BLOCK_WINDOW} indexed blocks`}
        >
          {topContracts.loading && <LoadingState label="Loading contract activity" />}
          {topContracts.error && <ErrorState message={topContracts.error} />}
          {!topContracts.loading && topContracts.data.length === 0 && (
            <EmptyState
              title="No active contracts"
              body={`No contract targets were identified in the last ${ACTIVITY_BLOCK_WINDOW} indexed blocks.`}
            />
          )}
          {topContracts.data.length > 0 && (
            <SummaryTable className="summary-table-leaderboard summary-table-leaderboard-overview" headers={['Contract', 'Interactions', 'Last Seen']}>
              {topContracts.data.map((contract) => (
                <tr key={contract.address}>
                  <td>
                    <AddressLink address={contract.address} />
                  </td>
                  <td>{formatNumber(contract.count)}</td>
                  <td>
                    <BlockLink number={contract.lastSeenBlock} />
                  </td>
                </tr>
              ))}
            </SummaryTable>
          )}
        </PageSection>
      </div>

      <div class="overview-grid">
        <PageSection title="Recent Blocks" description="Latest indexed blocks in IndexedDB">
          {recentBlocks.loading && <LoadingState label="Loading recent blocks" />}
          {recentBlocks.error && <ErrorState message={recentBlocks.error} />}
          {!recentBlocks.loading && recentBlocks.data.length === 0 && (
            <EmptyState title="No indexed blocks" body="Start Anvil and wait for the sync loop to fill IndexedDB." />
          )}
          {recentBlocks.data.length > 0 && (
            <SummaryTable className="summary-table-blocks" headers={['Block', 'Hash', 'Txs', 'Timestamp']}>
              {recentBlocks.data.map((block) => (
                <tr key={block.number}>
                  <td>
                    <BlockLink number={block.number} />
                  </td>
                  <td>
                    <AppLink className="mono" path={`/blocks/${block.number}`} title={block.hash}>
                      {shortenHex(block.hash)}
                    </AppLink>
                  </td>
                  <td>{formatNumber(block.transactionCount)}</td>
                  <td>{formatTimestamp(block.timestamp)}</td>
                </tr>
              ))}
            </SummaryTable>
          )}
        </PageSection>

        <PageSection title="Recent Transactions" description="Latest transactions by indexed block">
          {recentTransactions.loading && <LoadingState label="Loading recent transactions" />}
          {recentTransactions.error && <ErrorState message={recentTransactions.error} />}
          {!recentTransactions.loading && recentTransactions.data.length === 0 && (
            <EmptyState title="No transactions yet" body="Transactions will appear here once blocks are indexed." />
          )}
          {recentTransactions.data.length > 0 && (
            <SummaryTable
              className="summary-table-transactions summary-table-transactions-overview"
              headers={['Hash', 'Method', 'Block', 'Status', 'Timestamp']}
            >
              {recentTransactions.data.map((transaction) => (
                <tr key={transaction.hash}>
                  <td>
                    <TxLink hash={transaction.hash} />
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
      </div>
    </section>
  )
}
