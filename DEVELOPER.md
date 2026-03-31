# Developer Notes

This file collects the developer-oriented material that used to live in `README.md`.

## Project Summary

Anvil Explorer is a Vite + Preact app for local Anvil chains. The frontend reads from IndexedDB for normal explorer views and uses RPC directly only for control actions, live balance reads, address classification, ABI sync, and on-demand trace loading.

Current scope includes:

- local Anvil RPC indexing over HTTP
- block, transaction, receipt, and log backfill into IndexedDB
- polling for new blocks
- rewind detection after snapshot / revert and pruning of divergent local data
- block, transaction, address, account, contract, log, ABI, and control views
- ABI-backed decode for calldata, logs, and custom errors
- token balance discovery from indexed ERC-20 `Transfer` logs plus live reads
- per-transaction ERC-20 balance effect analysis
- on-demand `debug_traceTransaction` rendering with `callTracer`
- a browser smoke test against a live app and Anvil instance

Out of scope right now:

- remote networks
- wallet integration
- websocket subscriptions
- persisted traces
- source verification, ENS, and general-purpose state inspection

## Stack

- Vite
- Preact
- `preact-router`
- `viem`
- `idb`
- `@noble/hashes`
- `@noble/curves`
- Playwright for smoke testing

## Local Development

Requirements:

- Node.js 20+
- a running local Anvil node

Install dependencies:

```bash
npm install
```

Start the app:

```bash
npm run dev -- --host 127.0.0.1
```

Default URLs:

- app: `http://127.0.0.1:7777`
- RPC: `http://127.0.0.1:8545`

The Vite dev server is pinned to port `7777` with `strictPort: true`.

## Scripts

Start the dev server:

```bash
npm run dev -- --host 127.0.0.1
```

Build the app:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

Run the browser smoke test:

```bash
npm run smoke
```

`npm run smoke` expects:

- the app already running at `http://127.0.0.1:7777`
- Anvil already running at `http://127.0.0.1:8545`

Optional overrides:

```bash
APP_URL=http://127.0.0.1:7777 RPC_URL=http://127.0.0.1:8545 npm run smoke
```

## Built-in ABI API

For user-facing endpoint integration guidance, see [API.md](./API.md).

Implementation details for the built-in local endpoint:

- default frontend endpoint: `VITE_ABI_API_URL` or `/api/abis`
- implemented by the Vite plugin in `vite.config.ts`
- supported methods: `GET /api/abis`, `POST /api/abis`
- on-disk store: `.anvil-explorer/abi-api-store.json`

## How It Works

### Sync model

The app connects to Anvil with `viem` and:

1. Reads chain metadata and the current head.
2. Backfills from the last indexed block forward.
3. Stores normalized records in IndexedDB.
4. Polls every 2 seconds for new blocks.
5. Detects local rewinds by comparing stored block hashes with RPC results.
6. Prunes divergent data and resumes from the common ancestor.

ABI sync runs independently and polls every 3 seconds.

### IndexedDB stores

- `blocks`
  key: block number
  indexes: `hash`, `timestamp`
- `transactions`
  key: tx hash
  indexes: `from`, `to`, `blockNumber`
- `receipts`
  key: tx hash
  indexes: `contractAddress`, `blockNumber`
- `logs`
  key: auto-increment
  indexes: `address`, `topic0`, `blockNumber`, `txHash`
- `abis`
  key: contract address
- `labels`
  key: address
- `meta`
  key/value sync metadata

### Read path

Most explorer pages read from IndexedDB rather than calling RPC directly. The main exceptions are:

- Anvil control actions
- live address classification and balance reads
- ERC-20 metadata and holder balance reads
- ABI endpoint polling
- on-demand trace loading

## Routes

- `/`
  overview with recent failures, active wallets, active contracts, recent blocks, and recent transactions
- `/blocks`
  recent indexed blocks
- `/blocks/:number`
  block detail and indexed transactions
- `/transactions`
  recent transactions, optionally filtered by account involvement
- `/tx/:hash`
  transaction detail, failure diagnostics, calldata decode, receipt logs, token effects, inline ABI attach, and trace
- `/accounts`
  discovered wallet activity and balances
- `/contracts`
  discovered contracts, token detection, ABI presence, and discovery sources
- `/address/:address`
  wallet or contract detail, labels, ABI controls, token metadata, holders, balances, transactions, logs, and relationship insight
- `/logs`
  recent indexed logs
- `/abis`
  ABI storage, endpoint configuration, and ABI API reference
- `/controls`
  mining, balance changes, snapshots, reverts, and local explorer reset

## Smoke Test Coverage

The current smoke test checks:

- overview page loads
- recent blocks and transactions render
- a recent contract call opens in the transaction page
- ABI save works
- calldata decode appears after ABI save
- event decode appears after ABI save
- ERC-20 transaction effects render
- a failed transaction shows decoded failure details
- a wallet page shows wallet classification and discovered token balances
- an ERC-20 contract page shows token metadata and holders
- mining advances the indexed head
- snapshot revert restores the explorer head
- no browser page errors
- no browser console errors

## Project Layout

```text
src/
  components/
  hooks/
  lib/
  pages/
scripts/
  smoke-test.cjs
```

Important files:

- `src/hooks/use-explorer.tsx`
  app-level polling, status, settings, and actions
- `src/lib/sync.ts`
  indexing pipeline and rewind handling
- `src/lib/db.ts`
  IndexedDB schema and query helpers
- `src/lib/rpc.ts`
  `viem` client helpers plus Anvil/debug RPC methods
- `src/lib/decode.ts`
  ABI parsing and decode logic
- `src/lib/failure.ts`
  reverted transaction replay and error decoding
- `src/lib/token-effects.ts`
  ERC-20 effect derivation and before/after balance reads
- `src/lib/transaction-meta.ts`
  transaction classification and summary helpers
- `vite.config.ts`
  Vite config plus the built-in ABI API
- `scripts/smoke-test.cjs`
  live browser smoke test

## Notes

- This repo is designed around local Anvil usage.
- Explorer data lives in browser IndexedDB.
- ABI uploads handled by the built-in endpoint live in `.anvil-explorer/abi-api-store.json`.
- If switching between very different local chains during development, resetting IndexedDB avoids stale local state.
