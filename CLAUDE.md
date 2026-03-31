# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Anvil Explorer is a browser-based block explorer for local Foundry `anvil` chains. It connects to a local RPC, indexes chain data into IndexedDB, and provides a UI for inspecting blocks, transactions, accounts, contracts, logs, and token activity. Not intended for public networks.

## Commands

```bash
npm run dev -- --host 127.0.0.1   # Start dev server at http://127.0.0.1:7777
npm run build                      # TypeScript check + Vite production build
npm run preview                    # Serve the production build
npm run smoke                      # Playwright smoke test (requires running app + anvil)
```

The smoke test expects the app at `http://127.0.0.1:7777` and Anvil at `http://127.0.0.1:8545`. Override with `APP_URL` and `RPC_URL` env vars.

There is no unit test suite or linter configured. The smoke test (`scripts/smoke-test.cjs`) is the only automated test.

## Stack

Vite + Preact + preact-router + viem + idb (IndexedDB wrapper). No CSS framework — styles are inline or in `src/index.css`. TypeScript throughout.

## Architecture

### Data flow

The app does NOT call RPC for most reads. Instead:
1. `src/lib/sync.ts` backfills blocks/txs/receipts/logs from Anvil into IndexedDB, then polls every 2s for new blocks
2. Explorer pages read from IndexedDB via `src/lib/db.ts`
3. RPC is used directly only for: Anvil control actions, live balance reads, address classification, ABI endpoint polling, and on-demand `debug_traceTransaction`

### Key modules

- `src/hooks/use-explorer.tsx` — `ExplorerProvider` context wrapping the entire app. Manages polling, status, settings, and exposes actions to all pages.
- `src/lib/db.ts` — IndexedDB schema (blocks, transactions, receipts, logs, abis, labels, meta stores) and query helpers
- `src/lib/sync.ts` — Indexing pipeline, rewind/reorg detection after snapshot/revert, data pruning
- `src/lib/rpc.ts` — viem client helpers plus Anvil-specific and debug RPC methods
- `src/lib/decode.ts` — ABI parsing (accepts raw JSON arrays or Forge artifacts) and calldata/log/error decode
- `src/lib/token-effects.ts` — ERC-20 balance change derivation from Transfer logs with before/after reads
- `src/lib/failure.ts` — Reverted transaction replay and error decoding
- `src/components/common.tsx` — Shared layout (AppShell, sidebar) and reusable UI components

### Routing

`src/app.tsx` defines all routes via preact-router. Each route maps to a page component in `src/pages/`.

### Built-in ABI API

A Vite plugin in `vite.config.ts` serves `GET/POST /api/abis` during dev and preview. On-disk storage at `.anvil-explorer/abi-api-store.json`. The frontend also supports polling a custom external ABI endpoint (configurable via UI or `VITE_ABI_API_URL`).

## Conventions

- Preact with JSX (not React — imports from `preact`, uses `preact/hooks`)
- File extensions are `.tsx` for components/pages, `.ts` for libraries
- One page component per file in `src/pages/`, one hook per file in `src/hooks/`
- Addresses are normalized to checksummed form before storage
- The app is single-page with no SSR
