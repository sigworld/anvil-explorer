import type { Hex } from 'viem'
import { normalizeAddress } from './rpc.ts'
import { getBlockByHash, getTransaction } from './db.ts'
import type { SearchTarget } from './types.ts'

const HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/

export async function resolveSearchTarget(raw: string): Promise<SearchTarget | null> {
  const value = raw.trim()

  if (!value) {
    return null
  }

  if (/^\d+$/.test(value)) {
    return { type: 'block', number: Number.parseInt(value, 10) }
  }

  const address = normalizeAddress(value)
  if (address) {
    return { type: 'address', address }
  }

  if (HASH_PATTERN.test(value)) {
    const [transaction, block] = await Promise.all([
      getTransaction(value),
      getBlockByHash(value),
    ])

    if (transaction) {
      return { type: 'transaction', hash: value as Hex }
    }

    if (block) {
      return { type: 'block', number: block.number }
    }
  }

  return null
}
