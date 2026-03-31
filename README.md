# Anvil Explorer

Anvil Explorer is a browser-based explorer for local Foundry `anvil` chains.

It connects to your local RPC, indexes chain data into IndexedDB, and gives you a fast UI for inspecting blocks, transactions, accounts, contracts, logs, token activity, and traces without leaving the browser.

This project is built for local development and debugging. It is not intended for public networks.

## Why Use It

- Browse recent blocks, transactions, accounts, contracts, and logs from your local chain
- Search by block number, block hash, transaction hash, or address
- Inspect transaction status, calldata, receipt logs, failure reasons, and on-demand traces
- Attach contract ABIs and labels so calldata, events, and custom errors decode across the UI
- Inspect live native balances, discovered ERC-20 balances, token holders, and per-transaction token balance changes
- Run common Anvil actions from the UI, including mining blocks, setting balances, and snapshot / revert

## Quick Start

Requirements:

- Node.js 20+
- A running local Anvil node

Start Anvil:

```bash
anvil
```

Install dependencies and start the app:

```bash
npm install
npm run dev -- --host 127.0.0.1
```

Open:

```text
http://127.0.0.1:7777
```

By default the app connects to:

```text
http://127.0.0.1:8545
```

You can change the RPC URL from the sidebar at any time.

## Using The Explorer

When the app connects, the sidebar shows chain status, head, indexed block, and record counts. The explorer syncs continuously and updates itself as new blocks appear.

Main areas:

- `Overview`: recent failed transactions, active wallets, active contracts, recent blocks, recent transactions
- `Blocks`: recent indexed blocks and per-block transaction lists
- `Transactions`: recent transactions with method, envelope, initiator, and status
- `Accounts`: discovered wallet addresses, balances, and transaction counts
- `Contracts`: discovered contracts, ABI status, ERC-20 detection, and discovery sources
- `Logs`: recent indexed logs across the local chain
- `ABIs`: manage saved ABIs, labels, and ABI sync endpoint settings
- `Config`: mine blocks, set balances, create snapshots, revert snapshots, and reset explorer data

## Common Workflows

### Inspect a transaction

Open a transaction from the overview, transactions list, block page, or search.

The transaction page shows:

- block, sender, recipient, value, gas, method, selector, status, and envelope type
- decoded failure information for reverted calls when available
- decoded calldata when a matching ABI exists
- receipt logs
- grouped ERC-20 balance changes with before/after balances
- an on-demand `debug_traceTransaction` call tree

### Add an ABI

You can save an ABI from:

- the `ABIs` page
- a contract address page
- a transaction page when calldata is not yet decodable

Supported input:

- a raw ABI JSON array
- a Forge artifact JSON object containing an `abi` field

Once saved, the explorer can use that ABI to decode:

- transaction calldata
- receipt logs
- custom errors on failed transactions

You can also save a label for the same address so the UI shows a readable contract name instead of only the address.

If you want the explorer to pull ABIs from your own service instead of the built-in local endpoint, see [API.md](./API.md).

### Inspect an address or contract

Address pages automatically classify the target as a wallet or contract.

Wallet pages show:

- native balance
- recent transactions
- discovered ERC-20 balances
- relationship insights based on indexed activity

Contract pages show:

- contract metadata and saved labels
- public functions derived from the attached ABI
- recent transactions and emitted logs
- ERC-20 metadata and discovered holders when the contract looks like a token

### Use Anvil controls

The `Config` page lets you:

- mine blocks with `anvil_mine`
- set balances with `anvil_setBalance`
- create snapshots with `evm_snapshot`
- revert snapshots with `evm_revert`
- clear local IndexedDB data and re-index from block 0

## Notes

- Data is stored in the browser's IndexedDB.
- Resetting explorer data clears the local browser cache, not the Anvil chain itself.
- The explorer is designed for local Anvil workflows.
- If you switch RPC URLs or revert to a very different local chain state, resetting IndexedDB is usually the cleanest recovery step.

## Developer Docs

For custom ABI endpoint integration, see [API.md](./API.md).

Developer-oriented setup, scripts, architecture notes, route inventory, and implementation details now live in [DEVELOPER.md](./DEVELOPER.md).
