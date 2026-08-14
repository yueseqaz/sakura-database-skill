import { appendFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'

export interface AuditEvent {
  action: string
  profile?: string
  dialect?: string
  success: boolean
  rowCount?: number
  statement?: string
  error?: string
  fingerprint?: string
  durationMs?: number
}

export function fingerprintStatement(statement: string): string {
  const normalized = statement.trim().replace(/\s+/g, ' ').toLowerCase()
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

export function defaultAuditPath(): string {
  return resolve(homedir(), '.local', 'share', 'sakura-database-skill', 'audit.jsonl')
}

export async function writeAudit(event: AuditEvent, path = defaultAuditPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const record = { timestamp: new Date().toISOString(), ...event }
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
}
