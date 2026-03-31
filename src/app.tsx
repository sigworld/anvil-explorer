import Router from 'preact-router'
import { AppShell } from './components/common.tsx'
import { ExplorerProvider } from './hooks/use-explorer.tsx'
import { AbisPage } from './pages/abis-page.tsx'
import { AccountsPage } from './pages/accounts-page.tsx'
import { AddressPage } from './pages/address-page.tsx'
import { BlockPage } from './pages/block-page.tsx'
import { BlocksPage } from './pages/blocks-page.tsx'
import { ControlsPage } from './pages/controls-page.tsx'
import { ContractsPage } from './pages/contracts-page.tsx'
import { HomePage } from './pages/home-page.tsx'
import { LogsPage } from './pages/logs-page.tsx'
import { NotFoundPage } from './pages/not-found-page.tsx'
import { TransactionsPage } from './pages/transactions-page.tsx'
import { TxPage } from './pages/tx-page.tsx'

export function App() {
  return (
    <ExplorerProvider>
      <AppShell>
        <Router>
          <HomePage path="/" />
          <BlocksPage path="/blocks" />
          <BlockPage path="/blocks/:number" />
          <TransactionsPage path="/transactions" />
          <AccountsPage path="/accounts" />
          <ContractsPage path="/contracts" />
          <TxPage path="/tx/:hash" />
          <AddressPage path="/address/:address" />
          <LogsPage path="/logs" />
          <AbisPage path="/abis" />
          <ControlsPage path="/controls" />
          <NotFoundPage default />
        </Router>
      </AppShell>
    </ExplorerProvider>
  )
}
