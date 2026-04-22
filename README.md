# Anvil Explorer

A block explorer for your local `anvil` chain. Runs in the browser, indexes everything into IndexedDB, and gives you the same inspection workflow you'd use on Etherscan — but for your local dev environment.

**Live demo: [anvilscan.sigworld.io](https://anvilscan.sigworld.io)** (append `?demo` to explore with sample data, no Anvil needed)

https://github.com/user-attachments/assets/a7470f21-a84d-429c-8d2f-6971a6e887c4

## Setup

```bash
anvil                                            # or anvil --fork-url <rpc>
npm install && npm run dev -- --host 127.0.0.1   # http://127.0.0.1:7777
```

Connects to `http://127.0.0.1:8545` by default. Change the RPC endpoint or set a custom start block on the **Config** page.

## What You Get

**Browsing & Search** — blocks, transactions, accounts, contracts, event logs. Search by block number, block hash, tx hash, or address.

**Calldata & Log Decoding** — attach ABIs (raw JSON or Forge artifacts) and the explorer decodes function calls, event logs, and revert errors everywhere they appear. Proxy contracts (ERC-1967) automatically merge implementation ABIs so proxied calls decode correctly.

**Contract Architecture** — detects ERC-1967 proxies, EIP-1167 clones, EIP-2535 diamonds, and ERC-4337 abstract accounts. Shows implementation addresses, links to master copies, and badges the pattern on address pages.

**Token Inspection** — ERC-20 balances, holder lists, and per-transaction balance diffs with before/after reads.

**Execution Tracing** — three views on any transaction:
- **Call Tree** — nested contract calls from `debug_traceTransaction` with gas, decoded names, and args
- **Stack Trace** — source-mapped Solidity frames with inline code display (requires Forge artifacts with source maps)
- **Opcode Trace** — step-by-step EVM execution with PC, gas cost, depth, stack, and storage state

**Interaction Graphs** — per-transaction call graphs and per-address relationship graphs showing value flows, invocations, and contract creation. Dagre layout, draggable nodes, fullscreen, edge crossing arcs.

**Anvil Controls** — mine blocks, mint ETH, mint ERC-20 tokens (brute-forces the `balanceOf` slot), snapshot/revert, impersonate accounts. All from the UI.

**Forked Chain Support** — auto-detects `anvil --fork-url` via `anvil_nodeInfo`, indexes only post-fork blocks, fetches pre-fork blocks on demand from the origin RPC.

**Multi-Endpoint** — save and switch between multiple Anvil instances from the sidebar.

## Loading ABIs

ABIs unlock decoded calldata, logs, and errors across the explorer. Three ways to get them in:

### Import from Forge (recommended)

Click **Import from Forge** on the ABIs page and select your Forge project root. The explorer scans `out/` for compiled artifacts and cross-references `broadcast/` to match contracts to deployed addresses — imports everything in one step, including source files for the stepping debugger.

For full source mapping and storage layouts, add to `foundry.toml`:

```toml
[profile.default]
build_info = true
ffi = true
ast = true
extra_output = ["metadata", "ir", "irOptimized", "storageLayout", "devdoc", "userdoc", "evm.assembly"]
```

### ABI API (auto-sync)

Push ABIs from your deploy scripts to the built-in endpoint:

```bash
curl -X POST http://127.0.0.1:7777/api/abis \
  -H 'content-type: application/json' \
  -d '{"address":"0x5Fb...aa3","label":"Token","artifact":{"abi":[...]}}'
```

Or point at your own service — the endpoint URL is configurable on the ABIs page or via `VITE_ABI_API_URL`. See [API.md](./API.md) for the spec.

### Manual Upload

Paste a raw ABI JSON array or full Forge artifact on the ABIs page, any contract address page, or any transaction page.

## Token Minting

**ETH** — Config page → Mint Native Token. Additive — reads current balance and adds on top.

**ERC-20** — Config page → Mint ERC20 Token, or use the inline mint on any token's address page. Enter the token contract, auto-detect decimals/symbol, specify recipient and amount. Works by brute-forcing the `balanceOf` storage slot (Solidity and Vyper layouts, slots 0–19) via `anvil_setStorageAt`.

## Docs

- [API.md](./API.md) — ABI endpoint integration
- [DEVELOPER.md](./DEVELOPER.md) — Architecture and implementation details
