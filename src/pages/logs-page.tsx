import { decodeLog } from '../lib/decode.ts'
import { getAbi, getBlock, getRecentLogs } from '../lib/db.ts'
import { formatTimestamp } from '../lib/format.ts'
import { useAsyncResource } from '../hooks/use-async-resource.ts'
import { useExplorer } from '../hooks/use-explorer.tsx'
import { AddressLink, BlockLink, EmptyState, ErrorState, LoadingState, LogDecodePopup, PageSection, SummaryTable, TxLink } from '../components/common.tsx'
import { usePageMeta } from '../hooks/use-page-meta.ts'

type RouteProps = { path?: string }

export function LogsPage(_: RouteProps) {
  usePageMeta('Logs', 'Browse emitted event logs from your local Anvil chain with ABI-decoded topics and data.')
  const { refreshKey } = useExplorer()
  const logs = useAsyncResource(async () => {
    const records = await getRecentLogs(100)
    const uniqueAddresses = [...new Set(records.map((log) => log.address))]
    const uniqueBlockNumbers = [...new Set(records.map((log) => log.blockNumber).filter((value): value is number => typeof value === 'number'))]

    const [abiEntries, blockEntries] = await Promise.all([
      Promise.all(uniqueAddresses.map(async (address) => [address, (await getAbi(address))?.abi ?? null] as const)),
      Promise.all(uniqueBlockNumbers.map(async (blockNumber) => [blockNumber, await getBlock(blockNumber)] as const)),
    ])

    const abiMap = new Map(abiEntries)
    const blockMap = new Map(blockEntries)

    return records.map((log) => ({
      ...log,
      decoded: decodeLog(log, abiMap.get(log.address) ?? null),
      timestamp: log.blockNumber === null ? null : (blockMap.get(log.blockNumber)?.timestamp ?? null),
    }))
  }, [refreshKey], [])

  return (
    <PageSection title="Logs" description="Most recent indexed logs across the local chain">
      {logs.loading && <LoadingState label="Loading logs" />}
      {logs.error && <ErrorState message={logs.error} />}
      {!logs.loading && logs.data.length === 0 && (
        <EmptyState title="No logs indexed" body="Logs will appear here once receipts are stored." />
      )}
      {logs.data.length > 0 && (
        <SummaryTable
          className="summary-table-logs summary-table-logs-wide summary-table-logs-page"
          headers={[
            'Block',
            'Tx',
            'Address',
            (
              <span class="table-header-tooltip" data-tooltip="Click cell to decode">
                Topics
              </span>
            ),
            (
              <span>Data</span>
            ),
            'Timestamp',
          ]}
        >
          {logs.data.map((log) => {
            const topicsText = log.topics.length > 0 ? log.topics.join('\n') : 'n/a'

            return (
              <tr key={`${log.txHash ?? 'tx'}-${log.logIndex ?? 0}`}>
                <td>
                  <BlockLink number={log.blockNumber} />
                </td>
                <td>{log.txHash ? <TxLink hash={log.txHash} /> : 'n/a'}</td>
                <td>
                  <AddressLink address={log.address} />
                </td>
                <td class={log.decoded ? 'log-topic-decoded' : undefined}>
                  <LogDecodePopup decoded={log.decoded} trigger={<div class="log-data-cell mono">{topicsText}</div>} />
                </td>
                <td>
                  <div class="log-data-cell mono">{log.data}</div>
                </td>
                <td>{log.timestamp ? formatTimestamp(log.timestamp) : 'n/a'}</td>
              </tr>
            )
          })}
        </SummaryTable>
      )}
    </PageSection>
  )
}
