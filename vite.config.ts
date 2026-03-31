import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import preact from '@preact/preset-vite'
import { defineConfig, type Plugin } from 'vite'
import { normalizeAbiAddress, parseAbiInput } from './src/lib/decode.ts'

type UploadedAbiRecord = {
  address: string
  label?: string
  source: string
  updatedAt: number
}

const ABI_STORE_PATH = resolve(process.cwd(), '.anvil-explorer', 'abi-api-store.json')

async function readAbiStore() {
  try {
    const source = await readFile(ABI_STORE_PATH, 'utf8')
    const parsed = JSON.parse(source) as { records?: UploadedAbiRecord[] }
    return Array.isArray(parsed.records) ? parsed.records : []
  } catch (caughtError: unknown) {
    if ((caughtError as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return []
    }

    throw caughtError
  }
}

async function writeAbiStore(records: UploadedAbiRecord[]) {
  await mkdir(dirname(ABI_STORE_PATH), { recursive: true })
  await writeFile(ABI_STORE_PATH, JSON.stringify({ records }, null, 2))
}

async function readJsonBody(request: NodeJS.ReadableStream) {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (chunks.length === 0) {
    return {}
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function sendJson(response: NodeJS.WritableStream & { statusCode: number; setHeader: (name: string, value: string) => void }, statusCode: number, payload: unknown) {
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.write(JSON.stringify(payload, null, 2))
  response.end()
}

function normalizeUploadedAbi(body: Record<string, unknown>): UploadedAbiRecord {
  if (typeof body.address !== 'string') {
    throw new Error('address is required')
  }

  const address = normalizeAbiAddress(body.address)
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : undefined
  const updatedAt = typeof body.updatedAt === 'number' ? body.updatedAt : Date.now()
  let source = ''

  if (typeof body.source === 'string') {
    source = body.source
  } else if (body.source && typeof body.source === 'object') {
    source = JSON.stringify(body.source, null, 2)
  } else if (Array.isArray(body.abi)) {
    source = JSON.stringify(body.abi, null, 2)
  } else if (body.artifact && typeof body.artifact === 'object') {
    source = JSON.stringify(body.artifact, null, 2)
  } else {
    throw new Error('source, abi, or artifact is required')
  }

  parseAbiInput(source)

  return {
    address,
    label,
    source,
    updatedAt,
  }
}

function abiApiPlugin(): Plugin {
  async function handle(request: { method?: string; url?: string }, response: NodeJS.WritableStream & { statusCode: number; setHeader: (name: string, value: string) => void }, next: () => void) {
    if (!request.url) {
      next()
      return
    }

    const url = new URL(request.url, 'http://127.0.0.1')

    if (url.pathname !== '/api/abis') {
      next()
      return
    }

    try {
      if (request.method === 'GET') {
        const records = await readAbiStore()
        sendJson(response, 200, { records })
        return
      }

      if (request.method === 'POST') {
        const body = await readJsonBody(request as NodeJS.ReadableStream)
        const record = normalizeUploadedAbi(body)
        const records = await readAbiStore()
        const nextRecords = records.filter((item) => item.address !== record.address)
        nextRecords.unshift(record)
        await writeAbiStore(nextRecords)
        sendJson(response, 200, { record, count: nextRecords.length })
        return
      }

      sendJson(response, 405, { error: 'Method not allowed' })
    } catch (caughtError: unknown) {
      const message = caughtError instanceof Error ? caughtError.message : 'ABI API request failed'
      sendJson(response, 400, { error: message })
    }
  }

  return {
    name: 'abi-api',
    configureServer(server) {
      server.middlewares.use(handle)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [preact(), abiApiPlugin()],
  server: {
    port: 7777,
    strictPort: true,
  },
})
