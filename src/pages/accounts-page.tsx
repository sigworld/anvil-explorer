import { useState } from 'preact/hooks'
import { getDiscoveredAccounts } from '../lib/db.ts'
import { formatEtherString, formatNumber } from '../lib/format.ts'
import { createAnvilClient, getAddressKind, getNativeBalance } from '../lib/rpc.ts'
import { useAsyncResource } from '../hooks/use-async-resource.ts'
import { useExplorer } from '../hooks/use-explorer.tsx'
import {
  AppLink,
  AddressLink,
  BlockLink,
  EmptyState,
  ErrorState,
  LoadingState,
  PageSection,
  SummaryTable,
} from '../components/common.tsx'

type RouteProps = {
  path?: string
}

type SortKey = 'firstSeenBlock' | 'lastSeenBlock' | 'nativeBalance' | 'transactionCount'

function SortHeader(props: {
  label: string
  sortKey: SortKey
  activeKey: SortKey
  direction: 'asc' | 'desc'
  onToggle: (sortKey: SortKey) => void
}) {
  const active = props.activeKey === props.sortKey
  const arrow = active ? (props.direction === 'asc' ? '↑' : '↓') : '↕'

  return (
    <button
      type="button"
      class={`table-sort-button ${active ? 'is-active' : ''}`.trim()}
      onClick={() => props.onToggle(props.sortKey)}
      aria-pressed={active}
      title={`Sort by ${props.label}`}
    >
      <span>{props.label}</span>
      <span aria-hidden="true">{arrow}</span>
    </button>
  )
}

export function AccountsPage(_: RouteProps) {
  const { refreshKey, rpcUrl } = useExplorer()
  const [sortKey, setSortKey] = useState<SortKey>('transactionCount')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')
  const resource = useAsyncResource(
    async () => {
      const discovered = await getDiscoveredAccounts()
      const client = createAnvilClient(rpcUrl)

      const accounts = (
        await Promise.all(
          discovered.map(async (account) => {
            const kind = await getAddressKind(client, account.address).catch(() => null)

            if (kind !== 'wallet') {
              return null
            }

            const nativeBalance = await getNativeBalance(client, account.address).catch(() => null)

            return {
              ...account,
              nativeBalance,
            }
          }),
        )
      ).filter((item): item is NonNullable<typeof item> => item !== null)

      return accounts
    },
    [refreshKey, rpcUrl],
    [],
  )

  function handleSortToggle(nextKey: SortKey) {
    if (sortKey === nextKey) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
      return
    }

    setSortKey(nextKey)
    setSortDirection(nextKey === 'firstSeenBlock' ? 'asc' : 'desc')
  }

  const sortedAccounts = [...resource.data].sort((left, right) => {
    const direction = sortDirection === 'asc' ? 1 : -1

    switch (sortKey) {
      case 'firstSeenBlock': {
        const leftValue = left.firstSeenBlock ?? Number.MAX_SAFE_INTEGER
        const rightValue = right.firstSeenBlock ?? Number.MAX_SAFE_INTEGER
        return (leftValue - rightValue) * direction
      }
      case 'lastSeenBlock': {
        const leftValue = left.lastSeenBlock ?? -1
        const rightValue = right.lastSeenBlock ?? -1
        return (leftValue - rightValue) * direction
      }
      case 'nativeBalance': {
        const leftValue = BigInt(left.nativeBalance ?? '-1')
        const rightValue = BigInt(right.nativeBalance ?? '-1')

        if (leftValue === rightValue) {
          return left.address.localeCompare(right.address)
        }

        return (leftValue > rightValue ? 1 : -1) * direction
      }
      case 'transactionCount': {
        const leftValue = left.transactionCount
        const rightValue = right.transactionCount
        if (leftValue === rightValue) {
          return left.address.localeCompare(right.address)
        }
        return (leftValue - rightValue) * direction
      }
    }
  })

  return (
    <PageSection title="Accounts" description="Discovered wallet addresses from indexed transactions and token-transfer activity">
      {resource.loading && <LoadingState label="Loading discovered accounts" />}
      {resource.error && <ErrorState message={resource.error} />}
      {!resource.loading && resource.data.length === 0 && (
        <EmptyState title="No accounts discovered" body="Index some wallet activity to populate this list." />
      )}
      {resource.data.length > 0 && (
        <SummaryTable
          className="summary-table-accounts"
          headers={[
            'Account',
            <SortHeader
              label="First Seen"
              sortKey="firstSeenBlock"
              activeKey={sortKey}
              direction={sortDirection}
              onToggle={handleSortToggle}
            />,
            <SortHeader
              label="Last Seen"
              sortKey="lastSeenBlock"
              activeKey={sortKey}
              direction={sortDirection}
              onToggle={handleSortToggle}
            />,
            <SortHeader
              label="ETH"
              sortKey="nativeBalance"
              activeKey={sortKey}
              direction={sortDirection}
              onToggle={handleSortToggle}
            />,
            <SortHeader
              label="Txs"
              sortKey="transactionCount"
              activeKey={sortKey}
              direction={sortDirection}
              onToggle={handleSortToggle}
            />,
          ]}
        >
          {sortedAccounts.map((account) => (
            <tr key={account.address}>
              <td>
                <AddressLink address={account.address} />
              </td>
              <td>{account.firstSeenBlock === null ? 'n/a' : <BlockLink number={account.firstSeenBlock} />}</td>
              <td>{account.lastSeenBlock === null ? 'n/a' : <BlockLink number={account.lastSeenBlock} />}</td>
              <td>{formatEtherString(account.nativeBalance)}</td>
              <td>
                <AppLink path={`/transactions?account=${account.address}`}>
                  {formatNumber(account.transactionCount)}
                </AppLink>
              </td>
            </tr>
          ))}
        </SummaryTable>
      )}
    </PageSection>
  )
}
