import { getAddress, isAddress, toFunctionSelector, type Abi } from 'viem'
import { parseAbiInput } from './decode.ts'
import type { AbiRecord, ByteRange, CodeImageRecord, GeneratedSource, SourceAstNode, SourceFileRecord, StorageLayout } from './types.ts'

export type BytecodeMatchCandidate = {
  name: string
  sourcePath: string | null
  artifactPath: string
  source: string
  score: number
  matchedSelectors: number
  totalAbiSelectors: number
  onChainSelectors: number
  bytecodeMatch: boolean
  hasSourceImages: boolean
  /** On-chain deployed bytecode size in bytes, for mismatch diagnostics. */
  onChainBytes: number
  /** Compiled deployed bytecode size in bytes, or 0 if no bytecode available. */
  compiledBytes: number
}

export type BytecodeMatchScanResult = {
  candidates: BytecodeMatchCandidate[]
  sourceFiles: SourceFileRecord[]
  codeImagesByArtifact: Map<string, CodeImageRecord[]>
}

export type MatchedImport = {
  name: string
  address: string
  source: string
  hasSourceImages: boolean
}

export type ImportScanResult = {
  matched: MatchedImport[]
  unmatched: Array<{ name: string; source: string; hasSourceImages: boolean }>
  sourceFiles: SourceFileRecord[]
  codeImages: CodeImageRecord[]
}

type BroadcastTransaction = {
  contractName?: string
  contractAddress?: string
  transactionType?: string
}

type BroadcastFile = {
  transactions?: BroadcastTransaction[]
}

type BuildInfoContractArtifact = {
  contractName: string
  sourcePath: string
  buildInfoPath: string
  fileIndexMap: Record<number, string>
  creation?: ExtractedBytecodeImage
  runtime?: ExtractedBytecodeImage
  storageLayout?: StorageLayout | null
}

type BuildInfoSourceMetadata = {
  id: number
  ast?: SourceAstNode | null
  content?: string | null
}

type ExtractedBytecodeImage = {
  bytecode: string
  sourceMap: string
  generatedSources: GeneratedSource[]
  immutableRanges: ByteRange[]
  libraryRanges: ByteRange[]
}

type ArtifactData = {
  name: string
  source: string
  sourcePath: string | null
  artifactPath: string
  hasSourceImages: boolean
}

async function readJsonFile(fileHandle: FileSystemFileHandle): Promise<unknown> {
  const file = await fileHandle.getFile()
  const text = await file.text()
  return JSON.parse(text)
}

async function readTextFile(fileHandle: FileSystemFileHandle): Promise<string> {
  const file = await fileHandle.getFile()
  return file.text()
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
  return Array.isArray(abi)
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
  const fileName = filePath.split('/').pop() ?? ''
  return fileName.replace(/\.json$/, '')
}

function parseArtifactMetadata(parsed: Record<string, unknown>) {
  const metadata = parsed.metadata
  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata) as Record<string, unknown>
    } catch {
      return null
    }
  }

  return metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : null
}

function extractArtifactSourcePath(
  parsed: Record<string, unknown>,
  artifactPath: string,
  contractName: string,
): string | null {
  const metadata = parseArtifactMetadata(parsed)
  const compilationTarget = metadata?.settings && typeof metadata.settings === 'object'
    ? (metadata.settings as Record<string, unknown>).compilationTarget
    : null

  if (compilationTarget && typeof compilationTarget === 'object') {
    for (const [sourcePath, targetContract] of Object.entries(compilationTarget as Record<string, unknown>)) {
      if (typeof targetContract === 'string' && targetContract === contractName) {
        return sourcePath
      }
    }
  }

  const ast = parsed.ast
  if (ast && typeof ast === 'object') {
    const absolutePath = (ast as Record<string, unknown>).absolutePath
    if (typeof absolutePath === 'string' && absolutePath.length > 0) {
      return absolutePath
    }
  }

  const artifactMatch = artifactPath.match(/^out\/(.+)\/[^/]+\.json$/)
  if (artifactMatch) {
    return artifactMatch[1]
  }

  return null
}

function extractByteRanges(references: unknown): ByteRange[] {
  const result: ByteRange[] = []

  function visit(value: unknown) {
    if (!value) {
      return
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (
          item &&
          typeof item === 'object' &&
          typeof (item as { start?: unknown }).start === 'number' &&
          typeof (item as { length?: unknown }).length === 'number'
        ) {
          result.push({
            start: (item as { start: number }).start,
            length: (item as { length: number }).length,
          })
          continue
        }

        visit(item)
      }
      return
    }

    if (typeof value === 'object') {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        visit(nested)
      }
    }
  }

  visit(references)
  return result.sort((left, right) => left.start - right.start)
}

function extractGeneratedSources(value: unknown): GeneratedSource[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      id: typeof item.id === 'number' ? item.id : -1,
      name: typeof item.name === 'string' ? item.name : `<generated:${String(item.id ?? 'unknown')}>`,
      contents: typeof item.contents === 'string' ? item.contents : '',
      language: typeof item.language === 'string' ? item.language : null,
    }))
    .filter((item) => item.id >= 0)
}

function extractBytecodeImage(value: unknown): ExtractedBytecodeImage | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const obj = value as Record<string, unknown>
  const bytecode = typeof obj.object === 'string' ? obj.object : undefined
  const sourceMap = typeof obj.sourceMap === 'string' ? obj.sourceMap : undefined

  if (!bytecode || !sourceMap) {
    return undefined
  }

  return {
    bytecode,
    sourceMap,
    generatedSources: extractGeneratedSources(obj.generatedSources),
    immutableRanges: extractByteRanges(obj.immutableReferences),
    libraryRanges: extractByteRanges(obj.linkReferences),
  }
}

function extractBuildInfoSourceMetadata(parsed: unknown): Map<string, BuildInfoSourceMetadata> {
  const obj = parsed as Record<string, unknown>
  const output = obj.output as Record<string, unknown> | undefined
  if (!output) {
    return new Map()
  }

  const sources = output.sources as Record<string, { id?: number; ast?: SourceAstNode | null }> | undefined
  if (!sources) {
    return new Map()
  }

  // Extract compiler input source content — this is what byte offsets in source maps are relative to
  const input = obj.input as Record<string, unknown> | undefined
  const inputSources = input?.sources as Record<string, { content?: string }> | undefined

  const result = new Map<string, BuildInfoSourceMetadata>()
  for (const [sourcePath, info] of Object.entries(sources)) {
    if (typeof info?.id === 'number') {
      result.set(sourcePath, {
        id: info.id,
        ast: info.ast ?? null,
        content: inputSources?.[sourcePath]?.content ?? null,
      })
    }
  }

  return result
}

function extractStorageLayout(value: unknown): StorageLayout | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const obj = value as Record<string, unknown>
  const storage = obj.storage
  const types = obj.types

  if (!Array.isArray(storage) || !types || typeof types !== 'object') {
    return null
  }

  const validEntries = storage
    .filter((entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === 'object' &&
      typeof (entry as Record<string, unknown>).label === 'string' &&
      typeof (entry as Record<string, unknown>).slot === 'string',
    )
    .map((entry) => ({
      label: entry.label as string,
      slot: entry.slot as string,
      offset: typeof entry.offset === 'number' ? entry.offset : 0,
      type: typeof entry.type === 'string' ? entry.type : '',
    }))

  if (validEntries.length === 0) {
    return null
  }

  const validTypes: StorageLayout['types'] = {}
  for (const [typeName, typeInfo] of Object.entries(types as Record<string, unknown>)) {
    if (!typeInfo || typeof typeInfo !== 'object') {
      continue
    }
    const info = typeInfo as Record<string, unknown>
    validTypes[typeName] = {
      encoding: typeof info.encoding === 'string' ? info.encoding : 'inplace',
      label: typeof info.label === 'string' ? info.label : typeName,
      numberOfBytes: typeof info.numberOfBytes === 'string' ? info.numberOfBytes : '32',
      key: typeof info.key === 'string' ? info.key : undefined,
      value: typeof info.value === 'string' ? info.value : undefined,
      base: typeof info.base === 'string' ? info.base : undefined,
      members: Array.isArray(info.members)
        ? info.members
            .filter((m): m is Record<string, unknown> => m !== null && typeof m === 'object')
            .map((m) => ({
              label: typeof m.label === 'string' ? m.label : '',
              slot: typeof m.slot === 'string' ? m.slot : '0',
              offset: typeof m.offset === 'number' ? m.offset : 0,
              type: typeof m.type === 'string' ? m.type : '',
            }))
        : undefined,
    }
  }

  return { storage: validEntries, types: validTypes }
}

function parseBuildInfoContracts(path: string, parsed: unknown): BuildInfoContractArtifact[] {
  const obj = parsed as Record<string, unknown>
  const output = obj.output as Record<string, unknown> | undefined
  if (!output) {
    return []
  }

  const sources = extractBuildInfoSourceMetadata(parsed)
  const contracts = output.contracts as Record<string, Record<string, unknown>> | undefined
  if (sources.size === 0 || !contracts) {
    return []
  }

  const fileIndexMap: Record<number, string> = {}
  for (const [sourcePath, info] of sources) {
    fileIndexMap[info.id] = sourcePath
  }

  const result: BuildInfoContractArtifact[] = []

  for (const [sourcePath, sourceContracts] of Object.entries(contracts)) {
    for (const [contractName, contractOutput] of Object.entries(sourceContracts ?? {})) {
      const contractObj = contractOutput && typeof contractOutput === 'object'
        ? contractOutput as Record<string, unknown>
        : null
      const evm = contractObj?.evm
      const evmObj = evm && typeof evm === 'object' ? evm as Record<string, unknown> : null
      const creation = extractBytecodeImage(evmObj?.bytecode)
      const runtime = extractBytecodeImage(evmObj?.deployedBytecode)

      if (!creation && !runtime) {
        continue
      }

      const storageLayout = extractStorageLayout(contractObj?.storageLayout)

      result.push({
        contractName,
        sourcePath,
        buildInfoPath: path,
        fileIndexMap,
        creation,
        runtime,
        storageLayout,
      })
    }
  }

  return result
}

function buildGeneratedPath(
  buildInfoPath: string,
  sourcePath: string,
  contractName: string,
  kind: 'creation' | 'runtime',
  generated: GeneratedSource,
) {
  return `<generated:${buildInfoPath}:${sourcePath}:${contractName}:${kind}:${generated.id}:${generated.name}>`
}

function toCodeImageRecord(
  artifactPath: string | null,
  contract: BuildInfoContractArtifact,
  kind: 'creation' | 'runtime',
  image: ExtractedBytecodeImage,
): CodeImageRecord {
  const fileIndexMap: Record<number, string> = { ...contract.fileIndexMap }

  for (const generated of image.generatedSources) {
    fileIndexMap[generated.id] = buildGeneratedPath(
      contract.buildInfoPath,
      contract.sourcePath,
      contract.contractName,
      kind,
      generated,
    )
  }

  return {
    id: `${contract.buildInfoPath}:${contract.sourcePath}:${contract.contractName}:${kind}`,
    contractName: contract.contractName,
    sourcePath: contract.sourcePath,
    kind,
    artifactPath,
    buildInfoPath: contract.buildInfoPath,
    bytecode: image.bytecode,
    sourceMap: image.sourceMap,
    fileIndexMap,
    generatedSources: image.generatedSources,
    immutableRanges: image.immutableRanges,
    libraryRanges: image.libraryRanges,
    storageLayout: kind === 'runtime' ? contract.storageLayout : null,
    updatedAt: Date.now(),
  }
}

function findBuildInfoContract(
  buildContractsByKey: Map<string, BuildInfoContractArtifact>,
  buildContractsByName: Map<string, BuildInfoContractArtifact[]>,
  sourcePath: string | null,
  contractName: string,
) {
  if (sourcePath) {
    const exact = buildContractsByKey.get(`${sourcePath}:${contractName}`)
    if (exact) {
      return exact
    }
  }

  const byName = buildContractsByName.get(contractName) ?? []
  return byName.length === 1 ? byName[0] : null
}

export async function scanDirectory(dirHandle: FileSystemDirectoryHandle): Promise<ImportScanResult> {
  const artifacts = new Map<string, ArtifactData>()
  const addressesByName = new Map<string, string>()
  const sourceFilesByPath = new Map<string, SourceFileRecord>()
  const buildContractsByKey = new Map<string, BuildInfoContractArtifact>()
  const buildContractsByName = new Map<string, BuildInfoContractArtifact[]>()
  const buildSourceMetadataByPath = new Map<string, BuildInfoSourceMetadata>()

  for await (const { path, handle } of walkDirectory(dirHandle)) {
    if (handle.name.endsWith('.sol')) {
      try {
        const content = await readTextFile(handle)
        sourceFilesByPath.set(path, {
          path,
          content,
          sourceId: buildSourceMetadataByPath.get(path)?.id,
          ast: buildSourceMetadataByPath.get(path)?.ast ?? null,
        })
      } catch {
        // Skip unreadable sources.
      }
      continue
    }

    if (!handle.name.endsWith('.json')) {
      continue
    }

    try {
      const parsed = await readJsonFile(handle)

      if (path.includes('build-info')) {
        const buildSourceMetadata = extractBuildInfoSourceMetadata(parsed)
        for (const [sourcePath, metadata] of buildSourceMetadata) {
          buildSourceMetadataByPath.set(sourcePath, metadata)
          const existing = sourceFilesByPath.get(sourcePath)
          if (existing) {
            sourceFilesByPath.set(sourcePath, {
              ...existing,
              sourceId: metadata.id,
              ast: metadata.ast ?? null,
            })
          }
        }

        const contracts = parseBuildInfoContracts(path, parsed)
        for (const contract of contracts) {
          buildContractsByKey.set(`${contract.sourcePath}:${contract.contractName}`, contract)
          const existing = buildContractsByName.get(contract.contractName) ?? []
          existing.push(contract)
          buildContractsByName.set(contract.contractName, existing)
        }
        continue
      }

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

      if (!isForgeArtifact(parsed)) {
        continue
      }

      const parsedObj = parsed as Record<string, unknown>
      const name = typeof parsed.contractName === 'string' && parsed.contractName.length > 0
        ? parsed.contractName
        : contractNameFromPath(path)
      const source = JSON.stringify(parsed, null, 2)
      parseAbiInput(source)

      const sourcePath = extractArtifactSourcePath(parsedObj, path, name)
      const buildContract = findBuildInfoContract(buildContractsByKey, buildContractsByName, sourcePath, name)

      artifacts.set(path, {
        name,
        source,
        sourcePath,
        artifactPath: path,
        hasSourceImages: !!(buildContract?.creation || buildContract?.runtime),
      })
    } catch {
      // Skip invalid JSON and invalid ABI artifacts.
    }
  }

  // Second pass: overlay compiler input content onto source files.
  // The compiler's input.sources content is authoritative — source map byte offsets are relative to it.
  // This must happen after the walk so it wins regardless of .sol vs .json processing order.
  for (const [compilerPath, metadata] of buildSourceMetadataByPath) {
    if (!metadata.content) continue

    // Try exact match first
    const existing = sourceFilesByPath.get(compilerPath)
    if (existing) {
      sourceFilesByPath.set(compilerPath, { ...existing, content: metadata.content })
      continue
    }

    // Try suffix match (walk path may differ from compiler path)
    let matched = false
    for (const [walkPath, record] of sourceFilesByPath) {
      if (walkPath.endsWith(compilerPath) || compilerPath.endsWith(walkPath)) {
        sourceFilesByPath.set(walkPath, { ...record, content: metadata.content })
        matched = true
        break
      }
    }

    if (!matched) {
      // No disk file found — store compiler's copy
      sourceFilesByPath.set(compilerPath, {
        path: compilerPath,
        content: metadata.content,
        sourceId: metadata.id,
        ast: metadata.ast ?? null,
      })
    }
  }

  const codeImages: CodeImageRecord[] = []
  for (const artifact of artifacts.values()) {
    const buildContract = findBuildInfoContract(buildContractsByKey, buildContractsByName, artifact.sourcePath, artifact.name)
    if (!buildContract) {
      continue
    }

    if (buildContract.creation) {
      codeImages.push(toCodeImageRecord(artifact.artifactPath, buildContract, 'creation', buildContract.creation))
    }
    if (buildContract.runtime) {
      codeImages.push(toCodeImageRecord(artifact.artifactPath, buildContract, 'runtime', buildContract.runtime))
    }
  }

  const matched: ImportScanResult['matched'] = []
  const unmatched: ImportScanResult['unmatched'] = []

  for (const artifact of artifacts.values()) {
    const address = addressesByName.get(artifact.name)
    if (address) {
      matched.push({
        name: artifact.name,
        address,
        source: artifact.source,
        hasSourceImages: artifact.hasSourceImages,
      })
    } else {
      unmatched.push({
        name: artifact.name,
        source: artifact.source,
        hasSourceImages: artifact.hasSourceImages,
      })
    }
  }

  matched.sort((left, right) => left.name.localeCompare(right.name))
  unmatched.sort((left, right) => left.name.localeCompare(right.name))
  codeImages.sort((left, right) => left.id.localeCompare(right.id))

  const sourceFiles = [...sourceFilesByPath.values()].sort((left, right) => left.path.localeCompare(right.path))
  return { matched, unmatched, sourceFiles, codeImages }
}

export function toAbiRecords(items: ImportScanResult['matched']): AbiRecord[] {
  return items.map((item) => ({
    address: getAddress(item.address),
    abi: parseAbiInput(item.source),
    source: item.source,
    updatedAt: Date.now(),
  }))
}

/** Extract 4-byte function selectors embedded as PUSH4 operands in EVM bytecode. */
function extractSelectorsFromBytecode(hex: string): Set<string> {
  const selectors = new Set<string>()
  for (let i = 0; i < hex.length - 8; i += 2) {
    if (hex[i] === '6' && hex[i + 1] === '3') {
      // PUSH4 opcode (0x63)
      selectors.add(hex.slice(i + 2, i + 10))
      i += 8 // skip past the 4 pushed bytes
    }
  }
  return selectors
}

/** Compute function selectors from a parsed ABI. */
function getAbiSelectors(abi: Abi): Set<string> {
  const selectors = new Set<string>()
  for (const item of abi) {
    if (item.type !== 'function') continue
    try {
      const selector = toFunctionSelector(item).slice(2).toLowerCase()
      selectors.add(selector)
    } catch {
      // skip malformed entries
    }
  }
  return selectors
}

function stripSolidityMetadata(hex: string): string {
  if (hex.length < 4) return hex
  const metaLength = parseInt(hex.slice(-4), 16)
  if (metaLength > 0 && metaLength < 512) {
    const totalChars = (metaLength + 2) * 2
    if (totalChars <= hex.length) {
      return hex.slice(0, -totalChars)
    }
  }
  return hex
}

function hasBytecodeMatch(
  onChainHex: string,
  compiledHex: string,
  immutableRanges: ByteRange[],
  libraryRanges: ByteRange[],
): boolean {
  const a = stripSolidityMetadata(onChainHex)
  const b = stripSolidityMetadata(compiledHex)
  if (a.length !== b.length || a.length === 0) return false

  const masked = new Set<number>()
  for (const range of [...immutableRanges, ...libraryRanges]) {
    for (let i = 0; i < range.length; i++) {
      masked.add((range.start + i) * 2)
      masked.add((range.start + i) * 2 + 1)
    }
  }

  let matching = 0
  let compared = 0
  for (let i = 0; i < a.length; i++) {
    if (masked.has(i)) continue
    compared++
    if (a[i] === b[i]) matching++
  }

  return compared > 0 && matching / compared > 0.95
}

export async function scanDirectoryForBytecodeMatch(
  dirHandle: FileSystemDirectoryHandle,
  onChainBytecode: string,
): Promise<BytecodeMatchScanResult> {
  const onChainHex = (onChainBytecode.startsWith('0x') ? onChainBytecode.slice(2) : onChainBytecode).toLowerCase()
  const onChainSelectors = extractSelectorsFromBytecode(onChainHex)

  const artifacts = new Map<string, ArtifactData>()
  const artifactAbis = new Map<string, Abi>()
  const sourceFilesByPath = new Map<string, SourceFileRecord>()
  const buildContractsByKey = new Map<string, BuildInfoContractArtifact>()
  const buildContractsByName = new Map<string, BuildInfoContractArtifact[]>()
  const buildSourceMetadataByPath = new Map<string, BuildInfoSourceMetadata>()
  const artifactDeployedBytecode = new Map<string, ExtractedBytecodeImage>()

  for await (const { path, handle } of walkDirectory(dirHandle)) {
    if (handle.name.endsWith('.sol')) {
      try {
        const content = await readTextFile(handle)
        sourceFilesByPath.set(path, {
          path,
          content,
          sourceId: buildSourceMetadataByPath.get(path)?.id,
          ast: buildSourceMetadataByPath.get(path)?.ast ?? null,
        })
      } catch {
        // Skip unreadable sources.
      }
      continue
    }

    if (!handle.name.endsWith('.json')) continue

    try {
      const parsed = await readJsonFile(handle)

      if (path.includes('build-info')) {
        const buildSourceMetadata = extractBuildInfoSourceMetadata(parsed)
        for (const [sourcePath, metadata] of buildSourceMetadata) {
          buildSourceMetadataByPath.set(sourcePath, metadata)
          const existing = sourceFilesByPath.get(sourcePath)
          if (existing) {
            sourceFilesByPath.set(sourcePath, { ...existing, sourceId: metadata.id, ast: metadata.ast ?? null })
          }
        }

        const contracts = parseBuildInfoContracts(path, parsed)
        for (const contract of contracts) {
          buildContractsByKey.set(`${contract.sourcePath}:${contract.contractName}`, contract)
          const existing = buildContractsByName.get(contract.contractName) ?? []
          existing.push(contract)
          buildContractsByName.set(contract.contractName, existing)
        }
        continue
      }

      if (isBroadcastFile(parsed)) continue
      if (!isForgeArtifact(parsed)) continue

      const parsedObj = parsed as Record<string, unknown>
      const name = typeof parsed.contractName === 'string' && parsed.contractName.length > 0
        ? parsed.contractName
        : contractNameFromPath(path)
      const source = JSON.stringify(parsed, null, 2)
      const abi = parseAbiInput(source)

      const sourcePath = extractArtifactSourcePath(parsedObj, path, name)
      const buildContract = findBuildInfoContract(buildContractsByKey, buildContractsByName, sourcePath, name)

      artifacts.set(path, {
        name,
        source,
        sourcePath,
        artifactPath: path,
        hasSourceImages: !!(buildContract?.creation || buildContract?.runtime),
      })
      artifactAbis.set(path, abi)

      const deployedBytecode = extractBytecodeImage(
        (parsedObj.deployedBytecode ?? (parsedObj.evm as Record<string, unknown> | undefined)?.deployedBytecode) as unknown,
      )
      if (deployedBytecode) {
        artifactDeployedBytecode.set(path, deployedBytecode)
      }
    } catch {
      // Skip invalid files.
    }
  }

  // Overlay compiler input content onto source files
  for (const [compilerPath, metadata] of buildSourceMetadataByPath) {
    if (!metadata.content) continue
    const existing = sourceFilesByPath.get(compilerPath)
    if (existing) {
      sourceFilesByPath.set(compilerPath, { ...existing, content: metadata.content })
      continue
    }
    let matched = false
    for (const [walkPath, record] of sourceFilesByPath) {
      if (walkPath.endsWith(compilerPath) || compilerPath.endsWith(walkPath)) {
        sourceFilesByPath.set(walkPath, { ...record, content: metadata.content })
        matched = true
        break
      }
    }
    if (!matched) {
      sourceFilesByPath.set(compilerPath, {
        path: compilerPath,
        content: metadata.content,
        sourceId: metadata.id,
        ast: metadata.ast ?? null,
      })
    }
  }

  // Score each artifact by selector matching against on-chain bytecode.
  // Re-resolve hasSourceImages now that build-info is fully parsed.
  type ScoredCandidate = BytecodeMatchCandidate & { matchedSelectorSet: Set<string> }
  const scored: ScoredCandidate[] = []

  for (const [artifactPath, artifact] of artifacts) {
    const abi = artifactAbis.get(artifactPath)
    if (!abi) continue

    const abiSelectors = getAbiSelectors(abi)
    if (abiSelectors.size === 0) continue

    // Collect which ABI selectors appear in the on-chain bytecode
    const matchedSelectorSet = new Set<string>()
    for (const selector of abiSelectors) {
      if (onChainSelectors.has(selector)) matchedSelectorSet.add(selector)
    }

    // Require at least 1 selector match and at least 50% of ABI selectors present
    if (matchedSelectorSet.size === 0 || matchedSelectorSet.size / abiSelectors.size < 0.5) continue

    // Check for exact bytecode match as bonus signal
    const buildContract = findBuildInfoContract(buildContractsByKey, buildContractsByName, artifact.sourcePath, artifact.name)
    const image = buildContract?.runtime ?? artifactDeployedBytecode.get(artifactPath)
    const bytecodeMatch = image
      ? hasBytecodeMatch(
          onChainHex,
          (image.bytecode.startsWith('0x') ? image.bytecode.slice(2) : image.bytecode).toLowerCase(),
          image.immutableRanges,
          image.libraryRanges,
        )
      : false

    const selectorCoverage = matchedSelectorSet.size / onChainSelectors.size
    const score = bytecodeMatch ? 1.0 : selectorCoverage

    const compiledHex = image
      ? (image.bytecode.startsWith('0x') ? image.bytecode.slice(2) : image.bytecode)
      : ''

    scored.push({
      name: artifact.name,
      sourcePath: artifact.sourcePath,
      artifactPath,
      source: artifact.source,
      score,
      matchedSelectors: matchedSelectorSet.size,
      totalAbiSelectors: abiSelectors.size,
      onChainSelectors: onChainSelectors.size,
      bytecodeMatch,
      hasSourceImages: !!(buildContract?.creation || buildContract?.runtime),
      onChainBytes: onChainHex.length / 2,
      compiledBytes: compiledHex.length / 2,
      matchedSelectorSet,
    })
  }

  // Sort: bytecode matches first, then by matched selector count descending
  scored.sort((a, b) => {
    if (a.bytecodeMatch !== b.bytecodeMatch) return a.bytecodeMatch ? -1 : 1
    return b.matchedSelectors - a.matchedSelectors
  })

  // Remove artifacts whose matched selectors are a strict subset of a higher-ranked one
  const candidates: BytecodeMatchCandidate[] = []
  const keptSelectorSets: Set<string>[] = []

  for (const entry of scored) {
    const isSubset = keptSelectorSets.some((kept) => {
      if (entry.matchedSelectorSet.size >= kept.size) return false
      for (const sel of entry.matchedSelectorSet) {
        if (!kept.has(sel)) return false
      }
      return true
    })
    if (isSubset) continue

    keptSelectorSets.push(entry.matchedSelectorSet)
    const { matchedSelectorSet: _, ...candidate } = entry
    candidates.push(candidate)
  }

  // Build code images for all candidates, keyed by artifact path
  const codeImagesByArtifact = new Map<string, CodeImageRecord[]>()

  for (const candidate of candidates) {
    const artifact = artifacts.get(candidate.artifactPath)
    if (!artifact) continue
    const buildContract = findBuildInfoContract(buildContractsByKey, buildContractsByName, artifact.sourcePath, artifact.name)
    if (!buildContract) continue
    const images: CodeImageRecord[] = []
    if (buildContract.creation) {
      images.push(toCodeImageRecord(artifact.artifactPath, buildContract, 'creation', buildContract.creation))
    }
    if (buildContract.runtime) {
      images.push(toCodeImageRecord(artifact.artifactPath, buildContract, 'runtime', buildContract.runtime))
    }
    if (images.length > 0) {
      codeImagesByArtifact.set(candidate.artifactPath, images)
    }
  }

  const sourceFiles = [...sourceFilesByPath.values()].sort((a, b) => a.path.localeCompare(b.path))
  return { candidates, sourceFiles, codeImagesByArtifact }
}

export function isDirectoryPickerSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  // @ts-expect-error -- showDirectoryPicker is not in all TS lib targets
  return window.showDirectoryPicker({ mode: 'read' })
}
