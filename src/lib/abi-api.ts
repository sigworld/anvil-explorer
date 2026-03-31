import { getAddressLabel, listAbis, upsertAbi, upsertAddressLabel } from './db.ts'
import { normalizeAbiAddress, parseAbiInput } from './decode.ts'
import { createLogger } from './logger.ts'

export const DEFAULT_ABI_API_URL = import.meta.env.VITE_ABI_API_URL ?? '/api/abis'

type UploadedAbiRecord = {
  address: string
  label?: string
  source: string
  updatedAt: number
}

const logger = createLogger('abi-api')

function isUploadedAbiRecord(value: unknown): value is UploadedAbiRecord {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Record<string, unknown>

  return (
    typeof candidate.address === 'string' &&
    (candidate.label === undefined || typeof candidate.label === 'string') &&
    typeof candidate.source === 'string' &&
    typeof candidate.updatedAt === 'number'
  )
}

function normalizeUploadedAbiPayload(payload: unknown) {
  if (Array.isArray(payload)) {
    return payload.filter(isUploadedAbiRecord)
  }

  if (payload && typeof payload === 'object' && Array.isArray((payload as { records?: unknown }).records)) {
    return (payload as { records: unknown[] }).records.filter(isUploadedAbiRecord)
  }

  return []
}

export async function fetchUploadedAbis(endpoint: string) {
  const response = await fetch(endpoint, {
    headers: {
      'cache-control': 'no-store',
    },
  })

  if (!response.ok) {
    throw new Error(`ABI API request failed with ${response.status}`)
  }

  const payload = await response.json()
  return normalizeUploadedAbiPayload(payload)
}

export async function syncUploadedAbis(endpoint: string) {
  if (!endpoint.trim()) {
    return false
  }

  try {
    const [remoteRecords, localRecords] = await Promise.all([fetchUploadedAbis(endpoint), listAbis()])
    const localByAddress = new Map(localRecords.map((record) => [record.address, record]))
    let changed = false

    for (const remoteRecord of remoteRecords) {
      const address = normalizeAbiAddress(remoteRecord.address)
      const current = localByAddress.get(address)
      const nextLabel = remoteRecord.label?.trim()
      const currentLabel = (await getAddressLabel(address))?.label
      const labelChanged = Boolean(nextLabel && nextLabel !== currentLabel)
      const abiChanged = !(
        current &&
        current.updatedAt >= remoteRecord.updatedAt &&
        current.source === remoteRecord.source
      )

      if (abiChanged) {
        await upsertAbi({
          address,
          abi: parseAbiInput(remoteRecord.source),
          source: remoteRecord.source,
          updatedAt: remoteRecord.updatedAt,
        })
      }

      if (labelChanged) {
        await upsertAddressLabel(address, nextLabel as string)
      }

      if (abiChanged || labelChanged) {
        changed = true
      }
    }

    return changed
  } catch (caughtError: unknown) {
    logger.warn('Failed to sync uploaded ABIs', { endpoint, caughtError })
    throw caughtError
  }
}
