import { getAddress, type Hex } from 'viem'
import type { LogRecord } from './types.ts'
import {
  type AnvilClient,
  addressFromSlot,
  getCode,
  getStorageAt,
  rpcRequest,
  ERC1967_IMPLEMENTATION_SLOT,
  ERC1967_BEACON_SLOT,
  ERC1967_ADMIN_SLOT,
} from './rpc.ts'

// --- Types ---

export type ContractArchitectureKind =
  | 'erc1967-proxy'
  | 'erc1967-beacon-proxy'
  | 'eip1167-clone'
  | 'eip2535-diamond'
  | 'erc4337-entrypoint'
  | 'erc4337-account'
  | 'erc4337-paymaster'
  | 'plain'

export type ArchitectureRole =
  | 'implementation'
  | 'beacon'
  | 'admin'
  | 'clone-master'
  | 'facet'
  | 'entrypoint'
  | 'account-factory'
  | 'paymaster'

export type ArchitectureRelation = {
  address: Hex
  role: ArchitectureRole
  label: string
}

export type ContractArchitecture = {
  kind: ContractArchitectureKind
  relations: ArchitectureRelation[]
}

// --- Constants ---

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// EIP-1167 minimal proxy bytecode pattern
const EIP1167_PREFIX = '363d3d373d3d3d363d73'
const EIP1167_SUFFIX = '5af43d82803e903d91602b57fd5bf3'

// EIP-2535 Diamond facets() selector
const FACETS_SELECTOR = '0x7a0ed627'

// ERC-4337 known EntryPoint addresses
const ENTRYPOINT_V06 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789'
const ENTRYPOINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'

// UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)
export const USER_OPERATION_EVENT_TOPIC = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f'

// --- Detectors ---

async function detectErc1967Proxy(
  client: AnvilClient,
  address: Hex,
): Promise<ContractArchitecture | null> {
  try {
    const [implSlot, beaconSlot, adminSlot] = await Promise.all([
      getStorageAt(client, address, ERC1967_IMPLEMENTATION_SLOT),
      getStorageAt(client, address, ERC1967_BEACON_SLOT),
      getStorageAt(client, address, ERC1967_ADMIN_SLOT),
    ])

    const implAddr = addressFromSlot(implSlot)
    const beaconAddr = addressFromSlot(beaconSlot)
    const adminAddr = addressFromSlot(adminSlot)

    // Direct proxy: has implementation slot
    if (implAddr !== ZERO_ADDRESS) {
      const relations: ArchitectureRelation[] = [
        { address: getAddress(implAddr), role: 'implementation', label: 'delegates to' },
      ]

      if (adminAddr !== ZERO_ADDRESS) {
        relations.push({ address: getAddress(adminAddr), role: 'admin', label: 'administered by' })
      }

      return { kind: 'erc1967-proxy', relations }
    }

    // Beacon proxy: has beacon slot, read implementation from beacon
    if (beaconAddr !== ZERO_ADDRESS) {
      const relations: ArchitectureRelation[] = [
        { address: getAddress(beaconAddr), role: 'beacon', label: 'beacon at' },
      ]

      try {
        const beaconImplSlot = await getStorageAt(
          client,
          getAddress(beaconAddr) as Hex,
          ERC1967_IMPLEMENTATION_SLOT,
        )
        const beaconImplAddr = addressFromSlot(beaconImplSlot)

        if (beaconImplAddr !== ZERO_ADDRESS) {
          relations.push({
            address: getAddress(beaconImplAddr),
            role: 'implementation',
            label: 'delegates to (via beacon)',
          })
        }
      } catch {
        // beacon impl read failed, still report beacon relation
      }

      if (adminAddr !== ZERO_ADDRESS) {
        relations.push({ address: getAddress(adminAddr), role: 'admin', label: 'administered by' })
      }

      return { kind: 'erc1967-beacon-proxy', relations }
    }

    return null
  } catch {
    return null
  }
}

async function detectEip1167Clone(
  client: AnvilClient,
  address: Hex,
): Promise<ContractArchitecture | null> {
  try {
    const code = await getCode(client, address)

    if (!code || code === '0x') {
      return null
    }

    const stripped = code.slice(2).toLowerCase()

    // Standard EIP-1167: 0x363d3d373d3d3d363d73<address>5af43d82803e903d91602b57fd5bf3
    if (stripped.startsWith(EIP1167_PREFIX) && stripped.endsWith(EIP1167_SUFFIX)) {
      const masterHex = stripped.slice(EIP1167_PREFIX.length, EIP1167_PREFIX.length + 40)
      const masterAddress = getAddress(('0x' + masterHex) as Hex)

      return {
        kind: 'eip1167-clone',
        relations: [
          { address: masterAddress, role: 'clone-master', label: 'cloned from' },
        ],
      }
    }

    return null
  } catch {
    return null
  }
}

async function detectEip2535Diamond(
  client: AnvilClient,
  address: Hex,
): Promise<ContractArchitecture | null> {
  try {
    // Call facets() on the contract
    const result = await rpcRequest<Hex>(client, 'eth_call', [
      { to: address, data: FACETS_SELECTOR },
      'latest',
    ])

    if (!result || result === '0x' || result.length < 130) {
      return null
    }

    // Decode the ABI-encoded Facet[] return
    // Layout: offset(32) + length(32) + [offset_per_facet...] + [facet_data...]
    // Each facet: address(32) + selectors_offset(32) + selectors_length(32) + selectors...
    const data = result.slice(2)
    const arrayOffset = parseInt(data.slice(0, 64), 16) * 2
    const arrayLength = parseInt(data.slice(arrayOffset, arrayOffset + 64), 16)

    if (arrayLength === 0 || arrayLength > 256) {
      return null
    }

    const relations: ArchitectureRelation[] = []
    const seen = new Set<string>()

    for (let i = 0; i < arrayLength; i++) {
      const facetOffsetPos = arrayOffset + 64 + i * 64
      const facetOffset = parseInt(data.slice(facetOffsetPos, facetOffsetPos + 64), 16) * 2
      const facetDataStart = arrayOffset + 64 + facetOffset

      // First 32 bytes of facet struct is the address (right-padded in the last 20 bytes)
      const addrHex = data.slice(facetDataStart + 24, facetDataStart + 64)
      const facetAddress = getAddress(('0x' + addrHex) as Hex)

      if (!seen.has(facetAddress)) {
        seen.add(facetAddress)
        relations.push({
          address: facetAddress,
          role: 'facet',
          label: 'diamond facet',
        })
      }
    }

    if (relations.length === 0) {
      return null
    }

    return { kind: 'eip2535-diamond', relations }
  } catch {
    return null
  }
}

function detectErc4337(
  address: Hex,
  logs?: LogRecord[],
): ContractArchitecture | null {
  const checksummed = getAddress(address)

  // Check if this is a known EntryPoint
  if (checksummed === ENTRYPOINT_V06 || checksummed === ENTRYPOINT_V07) {
    return { kind: 'erc4337-entrypoint', relations: [] }
  }

  if (!logs || logs.length === 0) {
    return null
  }

  // Scan logs for UserOperationEvent to detect smart accounts and paymasters
  const userOpLogs = logs.filter((log) => log.topic0 === USER_OPERATION_EVENT_TOPIC)

  if (userOpLogs.length === 0) {
    return null
  }

  // UserOperationEvent(bytes32 userOpHash, address sender, address paymaster, ...)
  // topic1 = userOpHash, topic2 = sender (indexed), topic3 = paymaster (indexed)
  // Actually: topic0 = event sig, topic1 = userOpHash, topic2 = sender, topic3 = paymaster

  // Check if this address is the sender (smart account) in any UserOpEvent
  const normalizedAddr = address.toLowerCase()
  for (const log of userOpLogs) {
    const sender = log.topics[2] ? ('0x' + log.topics[2].slice(26)).toLowerCase() : null

    if (sender === normalizedAddr) {
      const entrypointAddr = getAddress(log.address)

      return {
        kind: 'erc4337-account',
        relations: [
          { address: entrypointAddr, role: 'entrypoint', label: 'entry point' },
        ],
      }
    }
  }

  // Check if this address is the paymaster in any UserOpEvent
  for (const log of userOpLogs) {
    const paymaster = log.topics[3] ? ('0x' + log.topics[3].slice(26)).toLowerCase() : null

    if (paymaster === normalizedAddr) {
      const entrypointAddr = getAddress(log.address)

      return {
        kind: 'erc4337-paymaster',
        relations: [
          { address: entrypointAddr, role: 'entrypoint', label: 'entry point' },
        ],
      }
    }
  }

  return null
}

// --- Orchestrator ---

export function architectureKindLabel(kind: ContractArchitectureKind): string | null {
  switch (kind) {
    case 'erc1967-proxy':
      return 'ERC-1967 Proxy'
    case 'erc1967-beacon-proxy':
      return 'Beacon Proxy'
    case 'eip1167-clone':
      return 'EIP-1167 Clone'
    case 'eip2535-diamond':
      return 'EIP-2535 Diamond'
    case 'erc4337-entrypoint':
      return 'ERC-4337 EntryPoint'
    case 'erc4337-account':
      return 'Smart Account'
    case 'erc4337-paymaster':
      return 'Paymaster'
    case 'plain':
      return null
  }
}

export async function detectContractArchitecture(
  client: AnvilClient,
  address: Hex,
  logs?: LogRecord[],
): Promise<ContractArchitecture> {
  // Run ERC-1967 and EIP-1167 in parallel (both are fast storage/code reads)
  const [erc1967Result, eip1167Result] = await Promise.all([
    detectErc1967Proxy(client, address),
    detectEip1167Clone(client, address),
  ])

  // Check for ERC-4337 regardless of proxy status (a smart account can be a proxy)
  const erc4337Result = detectErc4337(address, logs)

  if (erc1967Result) {
    // Composite: proxy + 4337 account — merge relations
    if (erc4337Result) {
      return {
        kind: erc4337Result.kind,
        relations: [...erc1967Result.relations, ...erc4337Result.relations],
      }
    }

    return erc1967Result
  }

  if (eip1167Result) {
    if (erc4337Result) {
      return {
        kind: erc4337Result.kind,
        relations: [...eip1167Result.relations, ...erc4337Result.relations],
      }
    }

    return eip1167Result
  }

  // Diamond detection requires an eth_call, try it next
  const diamondResult = await detectEip2535Diamond(client, address)

  if (diamondResult) {
    return diamondResult
  }

  if (erc4337Result) {
    return erc4337Result
  }

  return { kind: 'plain', relations: [] }
}
