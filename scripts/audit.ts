import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const DEFAULT_AUDIT_MAX_BYTES = 5 * 1024 * 1024
export const DEFAULT_AUDIT_RETENTION_FILES = 10
const GENESIS_HASH = '0'.repeat(64)

export interface AuditEvent {
  action: string
  profile?: string
  dialect?: string
  success?: boolean
  correlationId?: string
  phase?: 'intent' | 'outcome'
  rowCount?: number
  error?: string
  fingerprint?: string
  durationMs?: number
}

export interface AuditRecord extends AuditEvent {
  schemaVersion: 1
  eventId: string
  correlationId: string
  timestamp: string
  sequence: number
  previousHash: string
  hash: string
}

export interface AuditOptions {
  maxBytes?: number
  retentionFiles?: number
}

export interface AuditFilters {
  profile?: string
  correlationId?: string
  action?: string
  success?: boolean
  since?: string
  until?: string
  limit?: number
}

export interface AuditVerification {
  valid: boolean
  recordCount: number
  legacyRecordCount: number
  files: string[]
  issues: string[]
}

export function fingerprintStatement(statement: string): string {
  const normalized = statement.trim().replace(/\s+/g, ' ').toLowerCase()
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

export function defaultAuditPath(): string {
  return resolve(homedir(), '.local', 'share', 'sakura-database-skill', 'audit.jsonl')
}

function recordHash(record: Omit<AuditRecord, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex')
}

function isAuditRecord(value: unknown): value is AuditRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<AuditRecord>
  return record.schemaVersion === 1
    && typeof record.eventId === 'string'
    && typeof record.correlationId === 'string'
    && typeof record.timestamp === 'string'
    && typeof record.action === 'string'
    && Number.isInteger(record.sequence)
    && (record.sequence as number) > 0
    && typeof record.previousHash === 'string'
    && /^[a-f0-9]{64}$/.test(record.previousHash)
    && typeof record.hash === 'string'
    && /^[a-f0-9]{64}$/.test(record.hash)
}

function hasChainMetadata(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  return ['schemaVersion', 'eventId', 'correlationId', 'sequence', 'previousHash', 'hash'].some((key) => key in value)
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function rotatedPath(path: string, index: number): string {
  return `${path}.${index}`
}

async function auditFiles(path: string): Promise<string[]> {
  const directory = dirname(path)
  const name = basename(path)
  let entries: string[]
  try { entries = await readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return entries
    .map((entry) => {
      if (entry === name) return { path, index: 0 }
      const match = entry.match(new RegExp(`^${escapedName}\\.(\\d+)$`))
      return match ? { path: resolve(directory, entry), index: Number(match[1]) } : undefined
    })
    .filter((entry): entry is { path: string; index: number } => entry !== undefined)
    .sort((left, right) => right.index - left.index)
    .map((entry) => entry.path)
}

async function parseFile(path: string): Promise<Array<{ value?: unknown; line: number; error?: string }>> {
  let content: string
  try { content = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const entries: Array<{ value?: unknown; line: number; error?: string }> = []
  for (const [index, line] of content.split('\n').entries()) {
    if (!line.trim()) continue
    try { entries.push({ value: JSON.parse(line) as unknown, line: index + 1 }) }
    catch { entries.push({ line: index + 1, error: 'invalid JSON' }) }
  }
  return entries
}

async function lastValue(path: string): Promise<unknown> {
  const files = (await auditFiles(path)).reverse()
  for (const file of files) {
    const entries = await parseFile(file)
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index].value !== undefined) return entries[index].value
    }
  }
  return undefined
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`
  await mkdir(dirname(path), { recursive: true })
  const deadline = Date.now() + 5_000
  while (true) {
    try {
      await mkdir(lockPath)
      return () => rm(lockPath, { recursive: true, force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const lockStat = await stat(lockPath)
        if (Date.now() - lockStat.mtimeMs > 30_000) {
          await rm(lockPath, { recursive: true, force: true })
          continue
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code !== 'ENOENT') throw lockError
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for audit lock: ${lockPath}`)
      await delay(20)
    }
  }
}

async function rotateUnlocked(path: string, retentionFiles: number): Promise<boolean> {
  if (!await exists(path)) return false
  if (retentionFiles === 0) {
    await rm(path, { force: true })
    return true
  }
  await rm(rotatedPath(path, retentionFiles), { force: true })
  for (let index = retentionFiles - 1; index >= 1; index -= 1) {
    const source = rotatedPath(path, index)
    if (await exists(source)) await rename(source, rotatedPath(path, index + 1))
  }
  await rename(path, rotatedPath(path, 1))
  return true
}

export async function rotateAudit(path = defaultAuditPath(), options: Pick<AuditOptions, 'retentionFiles'> = {}): Promise<boolean> {
  const release = await acquireLock(path)
  try {
    return await rotateUnlocked(path, options.retentionFiles ?? DEFAULT_AUDIT_RETENTION_FILES)
  } finally {
    await release()
  }
}

export async function writeAudit(event: AuditEvent, path = defaultAuditPath(), options: AuditOptions = {}): Promise<AuditRecord> {
  const maxBytes = options.maxBytes ?? DEFAULT_AUDIT_MAX_BYTES
  const retentionFiles = options.retentionFiles ?? DEFAULT_AUDIT_RETENTION_FILES
  if (!Number.isInteger(maxBytes) || maxBytes < 256) throw new Error('auditMaxBytes must be an integer of at least 256.')
  if (!Number.isInteger(retentionFiles) || retentionFiles < 0 || retentionFiles > 1_000) throw new Error('auditRetentionFiles must be an integer between 0 and 1000.')

  const release = await acquireLock(path)
  try {
    const previous = await lastValue(path)
    const previousRecord = isAuditRecord(previous) ? previous : undefined
    if (previous !== undefined && !previousRecord && await exists(path)) await rotateUnlocked(path, retentionFiles)

    const unsigned: Omit<AuditRecord, 'hash'> = {
      schemaVersion: 1,
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      sequence: (previousRecord?.sequence ?? 0) + 1,
      previousHash: previousRecord?.hash ?? GENESIS_HASH,
      ...event,
      correlationId: event.correlationId ?? randomUUID(),
    }
    const record: AuditRecord = { ...unsigned, hash: recordHash(unsigned) }
    const line = `${JSON.stringify(record)}\n`
    const currentSize = await stat(path).then((value) => value.size).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return 0
      throw error
    })
    if (currentSize > 0 && currentSize + Buffer.byteLength(line) > maxBytes) await rotateUnlocked(path, retentionFiles)
    await appendFile(path, line, { mode: 0o600 })
    return record
  } finally {
    await release()
  }
}

export async function listAudit(path = defaultAuditPath(), filters: AuditFilters = {}): Promise<AuditRecord[]> {
  const since = filters.since ? Date.parse(filters.since) : undefined
  const until = filters.until ? Date.parse(filters.until) : undefined
  if (filters.since && Number.isNaN(since)) throw new Error('Invalid --since timestamp.')
  if (filters.until && Number.isNaN(until)) throw new Error('Invalid --until timestamp.')
  const records: AuditRecord[] = []
  for (const file of await auditFiles(path)) {
    for (const entry of await parseFile(file)) {
      if (!isAuditRecord(entry.value)) continue
      const record = entry.value
      const timestamp = Date.parse(record.timestamp)
      if (filters.profile && record.profile !== filters.profile) continue
      if (filters.correlationId && record.correlationId !== filters.correlationId) continue
      if (filters.action && record.action !== filters.action && !record.action.startsWith(`${filters.action}:`)) continue
      if (filters.success !== undefined && record.success !== filters.success) continue
      if (since !== undefined && timestamp < since) continue
      if (until !== undefined && timestamp > until) continue
      records.push(record)
    }
  }
  const limit = filters.limit ?? 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error('--limit must be an integer between 1 and 10000.')
  return records.slice(-limit)
}

export async function verifyAudit(path = defaultAuditPath()): Promise<AuditVerification> {
  const files = await auditFiles(path)
  const issues: string[] = []
  let previous: AuditRecord | undefined
  let recordCount = 0
  let legacyRecordCount = 0
  for (const file of files) {
    for (const entry of await parseFile(file)) {
      const location = `${basename(file)}:${entry.line}`
      if (entry.error) {
        issues.push(`${location}: ${entry.error}`)
        continue
      }
      if (!isAuditRecord(entry.value)) {
        if (hasChainMetadata(entry.value)) {
          issues.push(`${location}: malformed hash-chain record`)
          continue
        }
        legacyRecordCount += 1
        if (previous) issues.push(`${location}: legacy record interrupts the hash chain`)
        continue
      }
      const record = entry.value
      recordCount += 1
      const { hash, ...unsigned } = record
      if (recordHash(unsigned) !== hash) issues.push(`${location}: record hash mismatch`)
      if (previous) {
        if (record.previousHash !== previous.hash) issues.push(`${location}: previous hash mismatch`)
        if (record.sequence !== previous.sequence + 1) issues.push(`${location}: sequence mismatch`)
      }
      previous = record
    }
  }
  return { valid: issues.length === 0, recordCount, legacyRecordCount, files, issues }
}

export async function auditStats(path = defaultAuditPath()): Promise<{
  path: string
  fileCount: number
  recordCount: number
  legacyRecordCount: number
  totalBytes: number
  valid: boolean
}> {
  const files = await auditFiles(path)
  const verification = await verifyAudit(path)
  const sizes = await Promise.all(files.map((file) => stat(file).then((value) => value.size)))
  return {
    path,
    fileCount: files.length,
    recordCount: verification.recordCount,
    legacyRecordCount: verification.legacyRecordCount,
    totalBytes: sizes.reduce((total, size) => total + size, 0),
    valid: verification.valid,
  }
}
