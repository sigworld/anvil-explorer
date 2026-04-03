import type { StorageLayout } from './types.ts'

export type DecodedStorageSlot = {
  label: string
  slot: string
  typeName: string
  encoding: string
  rawValue: string
}

/**
 * Try to match a raw storage slot hex to a named variable using the storageLayout.
 * For simple (inplace) variables this is a direct slot match.
 * For mappings and dynamic arrays, we can't reverse the keccak so we just
 * annotate the base slot if we know it.
 */
export function decodeStorageSlot(
  slotHex: string,
  value: string,
  layout: StorageLayout | null | undefined,
): DecodedStorageSlot | null {
  if (!layout || layout.storage.length === 0) {
    return null
  }

  const normalizedSlot = normalizeSlotHex(slotHex)

  for (const entry of layout.storage) {
    const entrySlot = normalizeSlotHex(entry.slot)
    if (entrySlot === normalizedSlot) {
      const typeInfo = layout.types[entry.type]
      return {
        label: entry.label,
        slot: normalizedSlot,
        typeName: typeInfo?.label ?? entry.type,
        encoding: typeInfo?.encoding ?? 'inplace',
        rawValue: value,
      }
    }
  }

  // Check if the slot could be a mapping key hash for any mapping variable
  for (const entry of layout.storage) {
    const typeInfo = layout.types[entry.type]
    if (typeInfo?.encoding === 'mapping') {
      const entrySlot = normalizeSlotHex(entry.slot)
      // We can't reverse keccak, but we can note it's near the mapping's base
      // This is a heuristic: if nothing else matched, flag it as a possible mapping access
      if (normalizedSlot !== entrySlot) {
        continue
      }
    }

    if (typeInfo?.encoding === 'dynamic_array') {
      const entrySlot = normalizeSlotHex(entry.slot)
      // The array length is at the base slot, elements start at keccak256(slot)
      if (normalizedSlot === entrySlot) {
        return {
          label: `${entry.label}.length`,
          slot: normalizedSlot,
          typeName: typeInfo.label,
          encoding: 'dynamic_array',
          rawValue: value,
        }
      }
    }
  }

  return null
}

/**
 * Decode all storage accesses in a single step, returning labeled results.
 */
export function decodeStepStorage(
  storage: Record<string, string> | undefined,
  layout: StorageLayout | null | undefined,
): DecodedStorageSlot[] {
  if (!storage) {
    return []
  }

  const results: DecodedStorageSlot[] = []

  for (const [slot, value] of Object.entries(storage)) {
    const decoded = decodeStorageSlot(slot, value, layout)
    results.push(decoded ?? {
      label: abbreviateSlot(slot),
      slot: normalizeSlotHex(slot),
      typeName: 'unknown',
      encoding: 'unknown',
      rawValue: value,
    })
  }

  return results
}

/**
 * Compute the diff between two storage snapshots.
 */
export function diffStorage(
  previous: Record<string, string> | undefined,
  current: Record<string, string> | undefined,
): Array<{ slot: string; before: string | null; after: string | null }> {
  const diffs: Array<{ slot: string; before: string | null; after: string | null }> = []
  const allSlots = new Set([
    ...Object.keys(previous ?? {}),
    ...Object.keys(current ?? {}),
  ])

  for (const slot of allSlots) {
    const before = previous?.[slot] ?? null
    const after = current?.[slot] ?? null
    if (before !== after) {
      diffs.push({ slot: normalizeSlotHex(slot), before, after })
    }
  }

  return diffs.sort((a, b) => a.slot.localeCompare(b.slot))
}

function normalizeSlotHex(slot: string): string {
  const hex = slot.startsWith('0x') ? slot.slice(2) : slot
  return '0x' + hex.padStart(64, '0').toLowerCase()
}

function abbreviateSlot(slot: string): string {
  const normalized = normalizeSlotHex(slot)
  return `slot[${normalized.slice(0, 10)}…${normalized.slice(-4)}]`
}
