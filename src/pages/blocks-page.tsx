import { getLatestBlocks } from '../lib/db.ts'
import { formatTimestamp, shortenHex } from '../lib/format.ts'
import { useAsyncResource } from '../hooks/use-async-resource.ts'
import { useExplorer } from '../hooks/use-explorer.tsx'
import { AddressLink, BlockLink, EmptyState, ErrorState, LoadingState, PageSection, SummaryTable } from '../components/common.tsx'
import { usePageMeta } from '../hooks/use-page-meta.ts'

type RouteProps = { path?: string }

export function BlocksPage(_: RouteProps) {
  usePageMeta('Blocks', 'Browse indexed blocks from your local Anvil chain with timestamps, transaction counts, and gas usage.')
  const { refreshKey } = useExplorer()
  const blocks = useAsyncResource(() => getLatestBlocks(50), [refreshKey], [])

  return (
    <PageSection title="Blocks" description="Most recent indexed blocks">
      {blocks.loading && <LoadingState label="Loading blocks" />}
      {blocks.error && <ErrorState message={blocks.error} />}
      {!blocks.loading && blocks.data.length === 0 && (
        <EmptyState title="No blocks indexed" body="The sync loop has not written any blocks yet." />
      )}
      {blocks.data.length > 0 && (
        <SummaryTable className="summary-table-blocks" headers={['Number', 'Hash', 'Miner', 'Tx Count', 'Gas Used', 'Timestamp']}>
          {blocks.data.map((block) => (
            <tr key={block.number}>
              <td>
                <BlockLink number={block.number} />
              </td>
              <td class="mono">{shortenHex(block.hash)}</td>
              <td>
                <AddressLink address={block.miner} />
              </td>
              <td>{block.transactionCount}</td>
              <td>{block.gasUsed}</td>
              <td>{formatTimestamp(block.timestamp)}</td>
            </tr>
          ))}
        </SummaryTable>
      )}
    </PageSection>
  )
}
