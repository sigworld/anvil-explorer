import { getLatestTransactions, getResolvedAddressLabel, getTransactionsForAccountInvolvement } from '../lib/db.ts'
import { formatTimestamp } from '../lib/format.ts'
import { buildTransactionSummaries } from '../lib/transaction-meta.ts'
import { useAsyncResource } from '../hooks/use-async-resource.ts'
import { useExplorer } from '../hooks/use-explorer.tsx'
import { normalizeAddress } from '../lib/rpc.ts'
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
  TransactionEnvelopeBadge,
  TransactionKindBadge,
  TransactionStatusBadge,
  TxLink,
} from '../components/common.tsx'

type RouteProps = { path?: string }

function hashMethod(method: string) {
  let hash = 0

  for (let index = 0; index < method.length; index += 1) {
    hash = (hash * 31 + method.charCodeAt(index)) % 360
  }

  return hash
}

function getMethodHue(method: string) {
  const lowered = method.toLowerCase()

  if (lowered === 'transfer' || lowered === 'transferfrom' || lowered === 'value transfer') {
    return 210
  }

  if (lowered === 'approve') {
    return 32
  }

  if (lowered.includes('mint')) {
    return 145
  }

  if (lowered.includes('burn')) {
    return 356
  }

  if (lowered === 'constructor') {
    return 268
  }

  return hashMethod(lowered)
}

function getMethodToneStyle(method: string) {
  return {
    '--tx-method-hue': String(getMethodHue(method)),
  }
}

function getRowStripeClass(index: number) {
  return Math.floor(index / 2) % 2 === 0 ? 'tx-row-pair-even' : 'tx-row-pair-odd'
}

function formatTransactionListTimestamp(timestamp: number | null | undefined) {
  if (!timestamp) {
    return { label: 'n/a', title: undefined }
  }

  const absoluteLabel = formatTimestamp(timestamp)
  const ageSeconds = Math.floor(Date.now() / 1000) - timestamp

  if (ageSeconds < 0 || ageSeconds >= 2 * 60 * 60) {
    return { label: absoluteLabel, title: undefined }
  }

  if (ageSeconds < 60) {
    return { label: 'just now', title: absoluteLabel }
  }

  if (ageSeconds < 60 * 60) {
    return { label: `${Math.floor(ageSeconds / 60)}m ago`, title: absoluteLabel }
  }

  const hours = Math.floor(ageSeconds / (60 * 60))
  const minutes = Math.floor((ageSeconds % (60 * 60)) / 60)
  const label = minutes === 0 ? `${hours}h ago` : `${hours}h ${minutes}m ago`
  return { label, title: absoluteLabel }
}

export function TransactionsPage(_: RouteProps) {
  const { refreshKey } = useExplorer()
  const accountFilter = normalizeAddress(new URLSearchParams(window.location.search).get('account') ?? '')
  const accountLabel = useAsyncResource(
    async () => (accountFilter ? getResolvedAddressLabel(accountFilter) : null),
    [accountFilter, refreshKey],
    null,
  )
  const transactions = useAsyncResource(
    async () =>
      buildTransactionSummaries(
        accountFilter ? await getTransactionsForAccountInvolvement(accountFilter, 100) : await getLatestTransactions(100),
      ),
    [refreshKey, accountFilter],
    [],
  )

  return (
    <PageSection
      title="Transactions"
      description={
        accountFilter
          ? (
              <>
                Most recent indexed transactions involving{' '}
                {accountLabel.data ? (
                  <>
                    <span class="subtitle-highlight">{accountLabel.data}</span>
                    <span class="subtitle-highlight subtitle-highlight-address mono">({accountFilter})</span>
                  </>
                ) : (
                  <span class="subtitle-highlight subtitle-highlight-address mono">{accountFilter}</span>
                )}
              </>
            )
          : 'Most recent indexed transactions with initiator / payer detail'
      }
      actions={accountFilter ? <AppLink path="/transactions">Show all</AppLink> : undefined}
    >
      {transactions.loading && <LoadingState label="Loading transactions" />}
      {transactions.error && <ErrorState message={transactions.error} />}
      {!transactions.loading && transactions.data.length === 0 && (
        <EmptyState
          title={accountFilter ? 'No matching transactions' : 'No transactions yet'}
          body={
            accountFilter
              ? 'No indexed transactions currently involve this account.'
              : 'Transactions will appear here once blocks are indexed.'
          }
        />
      )}
      {transactions.data.length > 0 && (
        <SummaryTable className="summary-table-transactions summary-table-transactions-wide" headers={['Hash', 'Timestamp', 'Type', 'Method', 'Initiator', 'Block', 'Status']}>
          {transactions.data.map((transaction, index) => {
            const timestamp = formatTransactionListTimestamp(transaction.timestamp)

            return (
              <tr key={transaction.hash} class={getRowStripeClass(index)}>
                <td>
                  <TxLink hash={transaction.hash} />
                </td>
                <td title={timestamp.title}>{timestamp.label}</td>
                <td>
                  <div class="tx-meta-inline tx-type-inline">
                    <TransactionKindBadge kind={transaction.kind} />
                    <TransactionEnvelopeBadge envelope={transaction.envelope} />
                  </div>
                </td>
                <td>
                  <div class="tx-meta-stack">
                    <MethodLabel
                      method={transaction.method}
                      selector={transaction.selector}
                      methodClassName="tx-method-pill"
                      methodStyle={getMethodToneStyle(transaction.method)}
                    />
                  </div>
                </td>
                <td>
                  <AddressLink address={transaction.from} />
                </td>
                <td>
                  <BlockLink number={transaction.blockNumber} />
                </td>
                <td>
                  <TransactionStatusBadge status={transaction.status} />
                </td>
              </tr>
            )
          })}
        </SummaryTable>
      )}
    </PageSection>
  )
}
