import { getAddress, isAddress } from 'viem'
import { parseAbiInput } from './decode.ts'
import type { AbiRecord } from './types.ts'

/**
 * Result of scanning a directory for Forge/Hardhat artifacts.
 * `matched` have both an address and ABI — ready to import.
 * `unmatched` have an ABI but no deployed address found in broadcast files.
 */
export type ImportScanResult = {
  matched: Array<{ name: string; address: string; source: string }>
  unmatched: Array<{ name: string; source: string }>
}

type BroadcastTransaction = {
  contractName?: string
  contractAddress?: string
  transactionType?: string
}

type BroadcastFile = {
  transactions?: BroadcastTransaction[]
}

async function readJsonFile(fileHandle: FileSystemFileHandle): Promise<unknown> {
  const file = await fileHandle.getFile()
  const text = await file.text()
  return JSON.parse(text)
}

async function* walkDirectory(
  dirHandle: FileSystemDirectoryHandle,
  path: string = '',
): AsyncGenerator<{ path: string; handle: FileSystemFileHandle }> {
  // @ts-expect-error -- FileSystemDirectoryHandle.values() not in all TS lib targets
  for await (const entry of dirHandle.values()) {
    const entryPath = path ? `${path}/${(entry as FileSystemHandle).name}` : (entry as FileSystemHandle).name
    const kind = (entry as { kind: string }).kind

    if (kind === 'file') {
      yield { path: entryPath, handle: entry as FileSystemFileHandle }
    } else if (kind === 'directory') {
      // Skip node_modules, .git, cache, etc.
      const name = (entry as FileSystemHandle).name
      if (name === 'node_modules' || name === '.git' || name === 'cache') {
        continue
      }

      yield* walkDirectory(entry as FileSystemDirectoryHandle, entryPath)
    }
  }
}

function isForgeArtifact(parsed: unknown): parsed is { abi: unknown[]; contractName?: string } {
  if (parsed === null || typeof parsed !== 'object' || !('abi' in parsed)) {
    return false
  }

  const abi = (parsed as Record<string, unknown>).abi
  return Array.isArray(abi) && abi.length > 0
}

function isBroadcastFile(parsed: unknown): parsed is BroadcastFile {
  return (
    parsed !== null &&
    typeof parsed === 'object' &&
    'transactions' in parsed &&
    Array.isArray((parsed as Record<string, unknown>).transactions)
  )
}

function contractNameFromPath(filePath: string): string {
  // out/MyContract.sol/MyContract.json → MyContract
  // artifacts/contracts/MyContract.sol/MyContract.json → MyContract
  const fileName = filePath.split('/').pop() ?? ''
  return fileName.replace(/\.json$/, '')
}

export async function scanDirectory(dirHandle: FileSystemDirectoryHandle): Promise<ImportScanResult> {
  const artifactsByName = new Map<string, string>()
  const addressesByName = new Map<string, string>()

  for await (const { path, handle } of walkDirectory(dirHandle)) {
    if (!handle.name.endsWith('.json')) {
      continue
    }

    try {
      const parsed = await readJsonFile(handle)

      // Check if it's a broadcast file (contains deployment transactions)
      if (isBroadcastFile(parsed)) {
        for (const tx of parsed.transactions ?? []) {
          if (
            tx.transactionType === 'CREATE' &&
            tx.contractName &&
            tx.contractAddress &&
            isAddress(tx.contractAddress)
          ) {
            addressesByName.set(tx.contractName, getAddress(tx.contractAddress))
          }
        }
        continue
      }

      // Check if it's a Forge/Hardhat artifact
      if (isForgeArtifact(parsed)) {
        const name = (parsed.contractName as string) || contractNameFromPath(path)

        // Skip interfaces and abstract contracts (typically very small ABIs
        // nested under .sol dirs that don't match the file name)
        try {
          const source = JSON.stringify(parsed, null, 2)
          parseAbiInput(source)
          artifactsByName.set(name, source)
        } catch {
          // Invalid ABI, skip
        }
      }
    } catch {
      // Not valid JSON or unreadable, skip
    }
  }

  const matched: ImportScanResult['matched'] = []
  const unmatched: ImportScanResult['unmatched'] = []

  for (const [name, source] of artifactsByName) {
    const address = addressesByName.get(name)

    if (address) {
      matched.push({ name, address, source })
    } else {
      unmatched.push({ name, source })
    }
  }

  matched.sort((a, b) => a.name.localeCompare(b.name))
  unmatched.sort((a, b) => a.name.localeCompare(b.name))

  return { matched, unmatched }
}

export function toAbiRecords(items: ImportScanResult['matched']): AbiRecord[] {
  return items.map((item) => ({
    address: getAddress(item.address),
    abi: parseAbiInput(item.source),
    source: item.source,
    updatedAt: Date.now(),
  }))
}

export function isDirectoryPickerSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  // @ts-expect-error -- showDirectoryPicker is not in all TS lib targets
  return window.showDirectoryPicker({ mode: 'read' })
}
