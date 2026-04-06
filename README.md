# Anvil Explorer

A browser-based block explorer for local Foundry `anvil` chains. Indexes chain data into IndexedDB and gives you a full inspection UI — blocks, transactions, contracts, logs, token activity, execution traces, and source-level debugging — without leaving your browser.

**Try it now: [anvilscan.sigworld.io](https://anvilscan.sigworld.io)**

https://github.com/user-attachments/assets/a7470f21-a84d-429c-8d2f-6971a6e887c4

## Quick Start

Requirements: Node.js 20+ and a running local Anvil node.

```bash
anvil                              # start anvil (or anvil --fork-url <rpc>)
npm install && npm run dev -- --host 127.0.0.1  # start explorer at http://127.0.0.1:7777
```

The app connects to `http://127.0.0.1:8545` by default. Configure RPC endpoints and start block from the **Config** page, or switch between saved endpoints from the sidebar dropdown.

## Features

- Browse blocks, transactions, accounts, contracts, and event logs
- Search by block number, block hash, transaction hash, or address
- Decode calldata, receipt logs, and custom errors with attached ABIs (raw JSON or Forge artifacts)
- ERC-1967 proxy detection — automatically resolves implementation addresses and merges proxy + implementation ABIs for decoding
- Inspect ERC-20 balances, token holders, and per-transaction balance changes
- On-demand `debug_traceTransaction` call trees with opcode-level execution trace and gas cost breakdown
- Source-mapped stack traces and stepping debugger when Forge build artifacts are imported
- Anvil controls: mine blocks, mint native ETH, mint ERC-20 tokens, snapshot / revert, impersonate accounts
- Multi-endpoint support — save and switch between multiple Anvil instances with color-coded indicators
- **Forked chain support** — auto-detects `anvil --fork-url` via `anvil_nodeInfo`, indexes only post-fork blocks, and fetches pre-fork blocks on demand from the origin chain

## Forked Chains

When connected to a forked Anvil instance, the explorer automatically:

- Detects the fork origin and block number (shown in the sidebar)
- Indexes only blocks created after the fork — no attempt to sync millions of historical blocks
- Fetches pre-fork blocks live from the origin RPC when you navigate to them (marked with a banner)

You can also set a custom **Start Block** on the **Config** page to narrow the indexing window further, even on non-forked chains.

## Token Minting

### Native ETH

From the **Config** page, use **Mint Native Token** to add ETH to any address. This is additive — it reads the current balance and adds the specified amount on top (unlike `anvil_setBalance` which overwrites).

### ERC-20 Tokens

Use **Mint ERC20 Token** on the **Config** page to deal arbitrary ERC-20 tokens to any address. Enter the token contract address, click **Lookup** to auto-detect decimals and symbol, then specify the recipient and amount.

This also works inline from the **Token Metadata** sidebar on any ERC-20 contract's address page — useful when you're already inspecting a token.

Under the hood, the explorer brute-forces the `balanceOf` storage slot (Solidity and Vyper mapping layouts, slots 0–19) and writes via `anvil_setStorageAt`. Works with standard token implementations; exotic storage layouts may not be supported.

## Execution Tracing

On any transaction's detail page, the **Trace** tab offers three views:

- **Call Tree** — high-level call graph from `debug_traceTransaction` with `callTracer`, showing nested contract calls with gas usage, decoded function names, and arguments
- **Stack Trace** — source-mapped call frames with inline Solidity display, gas attribution per frame, and navigable call hierarchy. Requires Forge build artifacts with source maps imported via **Import from Forge**.
- **Opcode Trace** — step-by-step EVM execution showing every opcode with program counter, gas cost, call depth, and stack. Includes source mapping to Solidity lines when code images are available, a gas summary with the top 5 most expensive opcodes, and expandable stack/storage state per step. Results are paginated for large traces.

## Working with ABIs

ABIs unlock decoded calldata, event logs, and custom error messages across the explorer.

### Import from Forge

The fastest way to load ABIs. On the **ABIs** page, click **Import from Forge** and select your Forge project root (or the `out/` directory). The explorer scans `out/` for compiled artifacts and cross-references `broadcast/` files to match each contract to its deployed address — then imports everything in one step, including code images and source files for execution tracing.

Contracts found in artifacts but without a matching deployment are listed separately so you can assign an address manually.

For the best experience, configure your Forge project to emit build info, source maps, and storage layouts. Add this to your `foundry.toml`:

```toml
[profile.default]
build_info = true
ffi = true
ast = true
extra_output = [
  "metadata",
  "ir",
  "irOptimized",
  "storageLayout",
  "devdoc",
  "userdoc",
  "evm.assembly"
]
```

This ensures the explorer has everything it needs for full calldata decoding, source-mapped stack traces, and the stepping debugger.

### ABI API (auto-sync)

The explorer polls an ABI endpoint and automatically imports new or updated ABIs. A built-in local endpoint at `/api/abis` works out of the box — push ABIs to it from deployment scripts:

```bash
curl -X POST http://127.0.0.1:7777/api/abis \
  -H 'content-type: application/json' \
  -d '{"address":"0x5Fb...aa3","label":"Token","artifact":{"abi":[...]}}'
```

You can also point the explorer at your own service. Configure the endpoint URL on the **ABIs** page or set `VITE_ABI_API_URL` at build time. Toggle polling on or off with the pill switch in the section header. See [API.md](./API.md) for the full endpoint spec.

### Manual upload

As a fallback, you can paste an ABI directly from the **ABIs** page, a **contract address** page, or a **transaction** page. Accepts a raw ABI JSON array or a full Forge artifact JSON. You can also attach a human-readable **label** so the UI shows a contract name instead of just the address.

### What gets decoded

Once an ABI is saved for an address, the explorer automatically decodes:
- **Transaction calldata** — function name and parameters
- **Receipt logs** — event names and arguments
- **Revert errors** — custom error names and arguments on failed transactions

For proxy contracts (ERC-1967), the explorer reads the implementation storage slot, resolves the implementation address, and merges both ABIs so that proxied calls and events are decoded correctly. The address page shows native and proxied public functions in separate tabs.

## Docs

- [API.md](./API.md) — Custom ABI endpoint integration
- [DEVELOPER.md](./DEVELOPER.md) — Architecture, scripts, and implementation details
