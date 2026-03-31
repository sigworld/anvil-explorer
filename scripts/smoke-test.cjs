const { chromium } = require('playwright')

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:7777'
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545'
const MINT_ABI = JSON.stringify(
  [
    {
      type: 'function',
      name: 'mint',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      outputs: [],
    },
    {
      type: 'event',
      name: 'Transfer',
      anonymous: false,
      inputs: [
        { name: 'from', type: 'address', indexed: true },
        { name: 'to', type: 'address', indexed: true },
        { name: 'value', type: 'uint256', indexed: false },
      ],
    },
    {
      type: 'error',
      name: 'ERC20InsufficientBalance',
      inputs: [
        { name: 'sender', type: 'address' },
        { name: 'balance', type: 'uint256' },
        { name: 'needed', type: 'uint256' },
      ],
    },
  ],
  null,
  2,
)

async function rpcRequest(method, params = []) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  })

  const payload = await response.json()

  if (payload.error) {
    throw new Error(`${method} failed: ${payload.error.message}`)
  }

  return payload.result
}

function encodeTransferCall(recipient, amountHex) {
  const pad = (value) => value.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  return `0xa9059cbb${pad(recipient)}${pad(amountHex)}`
}

async function findRecentContractTransaction() {
  const latestBlockHex = await rpcRequest('eth_blockNumber')
  const latestBlockNumber = Number(latestBlockHex)

  for (let blockNumber = latestBlockNumber; blockNumber >= Math.max(0, latestBlockNumber - 25); blockNumber -= 1) {
    const block = await rpcRequest('eth_getBlockByNumber', [`0x${blockNumber.toString(16)}`, true])
    const transaction = (block.transactions ?? []).find(
      (item) => item.to && item.input && item.input.startsWith('0x40c10f19'),
    )

    if (transaction) {
      return {
        blockNumber,
        contractAddress: transaction.to,
        txHash: transaction.hash,
        input: transaction.input,
      }
    }
  }

  throw new Error('No recent mint(address,uint256) transaction found to verify calldata decode coverage')
}

async function createFailedErc20Transfer(tokenAddress) {
  const [recipient, sender] = await rpcRequest('eth_accounts')
  const data = encodeTransferCall(recipient, '0x1')
  return rpcRequest('eth_sendTransaction', [
    {
      from: sender,
      to: tokenAddress,
      data,
    },
  ])
}

async function waitForHead(page, expectedHead, timeout = 15000) {
  await page.waitForFunction(
    (value) => {
      const element = document.querySelector('.topbar')
      return element ? element.textContent.includes(`head ${value}`) : false
    },
    expectedHead,
    { timeout },
  )
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function extractAddressFromMintInput(input) {
  return `0x${input.slice(10 + 24, 10 + 64)}`
}

async function main() {
  const targetTransaction = await findRecentContractTransaction()
  const failedTxHash = await createFailedErc20Transfer(targetTransaction.contractAddress)
  const holderAddress = extractAddressFromMintInput(targetTransaction.input)
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const pageErrors = []
  const consoleErrors = []

  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })

  function headFromText(text) {
    const match = text.match(/head\s+(\d+)/i)
    return match ? Number.parseInt(match[1], 10) : null
  }

  await page.goto(APP_URL, { waitUntil: 'networkidle' })
  await page.waitForSelector('h1')
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length > 0, {
    timeout: 15000,
  })

  const recentBlocksSection = page
    .locator('.panel')
    .filter({ has: page.getByRole('heading', { name: 'Recent Blocks' }) })
  const recentTransactionsSection = page
    .locator('.panel')
    .filter({ has: page.getByRole('heading', { name: 'Recent Transactions' }) })

  const topbarText = await page.locator('.topbar').innerText()
  const initialHead = headFromText(topbarText)
  const recentBlockRows = await recentBlocksSection.locator('tbody tr').count()
  const recentTxRows = await recentTransactionsSection.locator('tbody tr').count()

  assert(initialHead !== null, 'Overview did not render a chain head')
  assert(recentBlockRows > 0, 'Recent blocks table is empty')
  assert(recentTxRows > 0, 'Recent transactions table is empty')

  await page.goto(`${APP_URL}/abis`, { waitUntil: 'networkidle' })
  const initialStoredAbisSection = page
    .locator('.panel')
    .filter({ has: page.getByRole('heading', { name: 'Stored ABIs' }) })
  const existingAbiRow = initialStoredAbisSection
    .locator('.abi-tile')
    .filter({ hasText: targetTransaction.contractAddress })

  if (await existingAbiRow.count()) {
    await existingAbiRow.getByRole('button', { name: 'Delete ABI' }).click()
    await page.waitForTimeout(1000)
  }

  await page.goto(`${APP_URL}/tx/${targetTransaction.txHash}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('text=Calldata')
  const missingAbiBefore = (await page.locator('text=No matching ABI for this calldata.').count()) > 0

  await page.goto(`${APP_URL}/abis`, { waitUntil: 'networkidle' })
  const storedAbisSection = page
    .locator('.panel')
    .filter({ has: page.getByRole('heading', { name: 'Stored ABIs' }) })
  await storedAbisSection.getByRole('button', { name: 'Upload ABI' }).click()
  const saveAbiDialog = page.getByRole('dialog', { name: 'Upload ABI' })
  await saveAbiDialog.getByLabel('Contract Address').fill(targetTransaction.contractAddress)
  await saveAbiDialog.locator('textarea').fill(MINT_ABI)
  await saveAbiDialog.getByRole('button', { name: 'Upload ABI' }).click()
  await page.waitForFunction(
    () => document.querySelectorAll('.abi-tile').length > 0,
    { timeout: 10000 },
  )
  const storedAbiRows = await storedAbisSection.locator('.abi-tile').count()

  await page.goto(`${APP_URL}/tx/${targetTransaction.txHash}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('text=Calldata')
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes('decoded function'), {
    timeout: 10000,
  })
  const decodedCallText = await page.locator('.decoded-card').innerText()
  const decodedEventVisible = (await page.locator('text=Transfer').count()) > 0
  await page.getByRole('tab', { name: 'Trace' }).click()
  await page.waitForSelector('.trace-tree .trace-summary-call')
  const traceSummaryText = await page.locator('.trace-tree .trace-summary-call').first().innerText()

  const txPage = {
    url: page.url(),
    hasCalldata: (await page.locator('text=Calldata').count()) > 0,
    hasTraceSection: (await page.locator('text=debug_traceTransaction').count()) > 0,
    missingAbiBefore,
    storedAbiRows,
    decodedCallText,
    decodedEventVisible,
    traceSummaryText,
    showsTokenEffects: (await page.locator('text=ERC-20 Effects').count()) > 0,
    showsBeforeAfterBalances:
      (await page.locator('text=Before').count()) > 0 && (await page.locator('text=After').count()) > 0,
    logRows: await page.locator('tbody tr').count(),
  }

  await page.goto(`${APP_URL}/tx/${failedTxHash}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('text=Failure')
  const failedTxText = await page.locator('body').innerText()
  const failedTxPage = {
    hash: failedTxHash,
    showsFailedStatus: failedTxText.includes('FAILED'),
    showsFailureSection: failedTxText.includes('Failure'),
    showsDecodedCustomError: failedTxText.includes('ERC20InsufficientBalance'),
    showsFailureArgs: failedTxText.includes('sender') && failedTxText.includes('needed'),
  }

  await page.goto(`${APP_URL}/address/${holderAddress}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('text=ERC-20 Balances')
  const addressPageText = await page.locator('body').innerText()
  const walletSectionTitles = await page.locator('section.panel h2').allInnerTexts()
  const addressPage = {
    holderAddress,
    showsInsight: addressPageText.includes('Insight'),
    showsWalletType: addressPageText.includes('WALLET'),
    showsTokenBalance: (await page.locator('tbody tr').count()) > 0,
    showsTokenSymbol: addressPageText.includes('SIXG'),
    hidesLogsSection: !walletSectionTitles.includes('Logs'),
  }

  await page.goto(`${APP_URL}/contracts`, { waitUntil: 'networkidle' })
  await page.waitForSelector('text=Discovered contract addresses')
  const contractsPageText = await page.locator('body').innerText()
  const contractsPage = {
    rowCount: await page.locator('tbody tr').count(),
    showsContractLinks: (await page.locator('a[href^="/address/"]').count()) > 0,
    showsAbiColumn: contractsPageText.includes('ABI'),
  }

  await page.goto(`${APP_URL}/address/${targetTransaction.contractAddress}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('text=Token Metadata')
  const contractAddressPageText = await page.locator('body').innerText()
  const contractLogsTable = page.locator('.summary-table-logs-address')
  const contractLogsTableText = await contractLogsTable.innerText()
  const contractAddressPage = {
    showsInsight: contractAddressPageText.includes('Insight'),
    showsContractType: contractAddressPageText.includes('CONTRACT'),
    showsErc20Indicator: contractAddressPageText.includes('ERC-20') && contractAddressPageText.includes('yes'),
    showsTokenMetadata: contractAddressPageText.includes('Token Metadata') && contractAddressPageText.includes('SIXG'),
    showsTokenHolders: contractAddressPageText.includes('Token Holders'),
    showsContractAbiSection: contractAddressPageText.includes('Contract ABI'),
    showsAbiDisclosure: contractAddressPageText.includes('Show attached ABI'),
    showsPublicFunctions: contractAddressPageText.includes('Public Functions') && contractAddressPageText.includes('mint('),
    showsDecodedLogs: contractLogsTableText.includes('Decoded') && contractLogsTableText.includes('Transfer'),
    abiCollapsedByDefault: (await page.locator('.abi-disclosure[open]').count()) === 0,
  }

  await page.goto(`${APP_URL}/controls`, { waitUntil: 'networkidle' })
  await page.waitForSelector('text=Mine Blocks')
  const snapshotInput = page.locator('input[placeholder="snapshot id"]')
  await page.getByRole('button', { name: 'Create Snapshot' }).click()
  await page.waitForFunction(
    () => document.body.innerText.includes('Created snapshot') && document.querySelector('input[placeholder="snapshot id"]').value.length > 0,
    { timeout: 10000 },
  )
  const snapshotId = await snapshotInput.inputValue()

  await page.getByRole('button', { name: 'Mine' }).click()
  await page.waitForFunction(() => document.body.innerText.includes('Mined 1 block(s)'), {
    timeout: 10000,
  })

  await page.goto(APP_URL, { waitUntil: 'networkidle' })
  await waitForHead(page, initialHead + 1, 15000)
  const updatedTopbarText = await page.locator('.topbar').innerText()
  const updatedHead = headFromText(updatedTopbarText)

  await page.goto(`${APP_URL}/controls`, { waitUntil: 'networkidle' })
  await snapshotInput.fill(snapshotId)
  await page.getByRole('button', { name: 'Revert' }).click()
  await page.waitForFunction(() => document.body.innerText.includes('Reverted snapshot'), {
    timeout: 10000,
  })

  await page.goto(APP_URL, { waitUntil: 'networkidle' })
  await waitForHead(page, initialHead, 15000)
  const revertedTopbarText = await page.locator('.topbar').innerText()
  const revertedHead = headFromText(revertedTopbarText)

  assert(updatedHead === initialHead + 1, 'Mine action did not advance the indexed head')
  assert(revertedHead === initialHead, 'Snapshot revert did not restore the indexed head')
  assert(txPage.hasCalldata, 'Transaction page is missing calldata section')
  assert(txPage.hasTraceSection, 'Transaction page is missing trace section')
  assert(txPage.decodedCallText.includes('mint'), 'Calldata did not decode after ABI save')
  assert(txPage.decodedCallText.includes('to'), 'Decoded calldata did not use ABI parameter names')
  assert(txPage.decodedCallText.includes('amount'), 'Decoded calldata did not use ABI parameter names')
  assert(txPage.traceSummaryText.includes('mint(to, amount)'), 'Trace decode did not use ABI parameter names')
  assert(txPage.decodedEventVisible, 'Receipt logs did not decode after ABI save')
  assert(txPage.showsTokenEffects, 'Successful token-affecting transaction did not show ERC-20 effects')
  assert(txPage.showsBeforeAfterBalances, 'ERC-20 effects did not show before/after balances')
  assert(failedTxPage.showsFailedStatus, 'Failed transaction did not show failed status')
  assert(failedTxPage.showsFailureSection, 'Failed transaction did not show failure section')
  assert(failedTxPage.showsDecodedCustomError, 'Failed transaction did not decode custom error')
  assert(failedTxPage.showsFailureArgs, 'Failed transaction did not show decoded error args')
  assert(addressPage.showsInsight, 'Address page did not show Insight')
  assert(addressPage.showsWalletType, 'Address page did not identify the wallet address clearly')
  assert(addressPage.showsTokenBalance, 'Address page did not show the discovered ERC-20 token contract')
  assert(addressPage.showsTokenSymbol, 'Address page did not show the discovered ERC-20 token symbol')
  assert(addressPage.hidesLogsSection, 'Wallet address page should not show a logs section')
  assert(contractsPage.rowCount > 0, 'Contracts page did not render any discovered contracts')
  assert(contractsPage.showsContractLinks, 'Contracts page did not render contract detail links')
  assert(contractsPage.showsAbiColumn, 'Contracts page did not render ABI status metadata')
  assert(contractAddressPage.showsInsight, 'Contract address page did not show Insight')
  assert(contractAddressPage.showsContractType, 'Contract address page did not identify the contract clearly')
  assert(contractAddressPage.showsErc20Indicator, 'Contract address page did not show ERC-20 status')
  assert(contractAddressPage.showsTokenMetadata, 'Contract address page did not show token metadata')
  assert(contractAddressPage.showsTokenHolders, 'Contract address page did not show token holders')
  assert(contractAddressPage.showsContractAbiSection, 'Contract address page did not show inline ABI attachment')
  assert(contractAddressPage.showsAbiDisclosure, 'Contract address page did not collapse the ABI section behind a disclosure')
  assert(contractAddressPage.showsPublicFunctions, 'Contract address page did not list public functions from the attached ABI')
  assert(contractAddressPage.showsDecodedLogs, 'Contract address page did not show decoded logs in the logs table')
  assert(contractAddressPage.abiCollapsedByDefault, 'Contract ABI section should be collapsed by default')
  assert(pageErrors.length === 0, `Browser page errors: ${pageErrors.join('; ')}`)
  assert(consoleErrors.length === 0, `Browser console errors: ${consoleErrors.join('; ')}`)

  const result = {
    contractAddress: targetTransaction.contractAddress,
    targetTxHash: targetTransaction.txHash,
    holderAddress,
    initialHead,
    updatedHead,
    revertedHead,
    snapshotId,
    recentBlockRows,
    recentTxRows,
    topbarText,
    updatedTopbarText,
    revertedTopbarText,
    txPage,
    failedTxPage,
    addressPage,
    contractsPage,
    contractAddressPage,
    pageErrors,
    consoleErrors,
  }

  console.log(JSON.stringify(result, null, 2))
  await browser.close()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
