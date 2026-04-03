import { getDiscoveredContracts } from '../lib/db.ts'
import { formatEtherString, formatNumber, formatTimestamp } from '../lib/format.ts'
import { createAnvilClient, getCode, getErc20TokenInfo } from '../lib/rpc.ts'
import { useAsyncResource } from '../hooks/use-async-resource.ts'
import { useExplorer } from '../hooks/use-explorer.tsx'
import { usePageMeta } from '../hooks/use-page-meta.ts'
import {
  AddressLink,
  BlockLink,
  EmptyState,
  ErrorState,
  LoadingState,
  PageSection,
  SummaryTable,
  TxLink,
} from '../components/common.tsx'

type RouteProps = {
  path?: string
}

function getHexByteLength(value: string | null | undefined) {
  if (!value || value === '0x') {
    return 0
  }

  return Math.max(0, (value.length - 2) / 2)
}

function renderContractType(symbol: string | null | undefined, name: string | null | undefined) {
  if (!symbol && !name) {
    return null
  }

  return `ERC-20${symbol ? ` ${symbol}` : name ? ` ${name}` : ''}`
}

function renderDeploymentCost(gasUsed: string | null, gasPrice: string | null) {
  if (!gasUsed) {
    return 'n/a'
  }

  if (!gasPrice) {
    return `${formatNumber(BigInt(gasUsed))} gas`
  }

  return formatEtherString((BigInt(gasUsed) * BigInt(gasPrice)).toString())
}

function renderTimestampWithBlock(timestamp: number | null, blockNumber: number | null) {
  if (!timestamp && blockNumber === null) {
    return 'n/a'
  }

  return (
    <span>
      {formatTimestamp(timestamp)} ({blockNumber === null ? 'n/a' : <BlockLink number={blockNumber} />})
    </span>
  )
}

export function ContractsPage(_: RouteProps) {
  usePageMeta('Contracts', 'Browse deployed contracts on your local Anvil chain — deployer, bytecode size, interaction count, and ERC-20 detection.')
  const { refreshKey, rpcUrl } = useExplorer()
  const resource = useAsyncResource(
    async () => {
      const discovered = await getDiscoveredContracts(250)
      const client = createAnvilClient(rpcUrl)

      const contracts = (
        await Promise.all(
          discovered.map(async (contract) => {
            const code = await getCode(client, contract.address).catch(() => '0x')

            if (code === '0x') {
              return null
            }

            const tokenInfo = await getErc20TokenInfo(client, contract.address).catch(() => null)

            return {
              ...contract,
              contractSize: getHexByteLength(code),
              tokenInfo,
            }
          }),
        )
      ).filter((item): item is NonNullable<typeof item> => item !== null)

      return contracts
    },
    [refreshKey, rpcUrl],
    [],
  )

  return (
    <PageSection title="Contracts" description="Discovered contract addresses with deployment metadata and recent activity">
      {resource.loading && <LoadingState label="Loading discovered contracts" />}
      {resource.error && <ErrorState message={resource.error} />}
      {!resource.loading && resource.data.length === 0 && (
        <EmptyState title="No contracts discovered" body="Index some contract activity or save an ABI to populate this list." />
      )}
      {resource.data.length > 0 && (
        <SummaryTable
          className="summary-table-contracts summary-table-contracts-scrollable"
          headers={['Contract', 'Deployer', 'Deployed', 'type', 'Called', 'Init Tx', 'Gas Cost', 'Size', 'Sources']}
        >
          {resource.data.map((contract) => (
            <tr key={contract.address}>
              <td>
                <AddressLink address={contract.address} />
              </td>
              <td>{contract.deployerAddress ? <AddressLink address={contract.deployerAddress} /> : 'n/a'}</td>
              <td>{renderTimestampWithBlock(contract.deploymentTimestamp, contract.deploymentBlockNumber)}</td>
              <td>{renderContractType(contract.tokenInfo?.symbol, contract.tokenInfo?.name)}</td>
              <td>{renderTimestampWithBlock(contract.lastSeenTimestamp, contract.lastSeenBlock)}</td>
              <td>{contract.deploymentTxHash ? <TxLink hash={contract.deploymentTxHash} /> : 'n/a'}</td>
              <td>
                {contract.deploymentGasUsed ? (
                  <div class="contract-cell-stack">
                    <span>{renderDeploymentCost(contract.deploymentGasUsed, contract.deploymentGasPrice)}</span>
                    <span class="muted mono">{formatNumber(BigInt(contract.deploymentGasUsed))} gas</span>
                  </div>
                ) : (
                  'n/a'
                )}
              </td>
              <td>{formatNumber(contract.contractSize)} B</td>
              <td>{contract.sources.join(', ')}</td>
            </tr>
          ))}
        </SummaryTable>
      )}
    </PageSection>
  )
}
