import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { auditStats, listAudit, verifyAudit, writeAudit } from './audit.js'

test('chains audit records and detects tampering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sakura-audit-chain-'))
  const path = join(directory, 'audit.jsonl')
  try {
    await writeAudit({ action: 'discover', success: true, correlationId: 'task-1' }, path)
    await writeAudit({ action: 'plan:users', success: true, correlationId: 'task-1' }, path)
    const valid = await verifyAudit(path)
    assert.equal(valid.valid, true)
    assert.equal(valid.recordCount, 2)

    const content = await readFile(path, 'utf8')
    await writeFile(path, content.replace('plan:users', 'plan:admins'))
    const invalid = await verifyAudit(path)
    assert.equal(invalid.valid, false)
    assert.match(invalid.issues.join('\n'), /hash/i)

    const records = content.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    delete records[0].hash
    await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
    const malformed = await verifyAudit(path)
    assert.equal(malformed.valid, false)
    assert.match(malformed.issues.join('\n'), /malformed hash-chain/i)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rotates by size and retains only the configured history files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sakura-audit-rotation-'))
  const path = join(directory, 'audit.jsonl')
  try {
    for (let index = 0; index < 12; index += 1) {
      await writeAudit({ action: `plan:${index}`, success: true }, path, { maxBytes: 350, retentionFiles: 2 })
    }
    const files = (await readdir(directory)).filter((file) => file.startsWith('audit.jsonl') && !file.endsWith('.lock'))
    assert.ok(files.includes('audit.jsonl'))
    assert.ok(files.includes('audit.jsonl.1'))
    assert.ok(files.length <= 3)
    assert.equal((await verifyAudit(path)).valid, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('serializes concurrent writers and supports audit filters and statistics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sakura-audit-concurrent-'))
  const path = join(directory, 'audit.jsonl')
  try {
    await Promise.all(Array.from({ length: 20 }, (_, index) => writeAudit({
      action: index % 2 === 0 ? 'discover' : 'plan:users',
      profile: 'development',
      success: index % 3 !== 0,
      correlationId: index < 10 ? 'task-a' : 'task-b',
    }, path)))
    const verification = await verifyAudit(path)
    assert.equal(verification.valid, true)
    assert.equal(verification.recordCount, 20)
    const records = await listAudit(path, { correlationId: 'task-a', action: 'discover', limit: 3 })
    assert.equal(records.length, 3)
    assert.ok(records.every((record) => record.correlationId === 'task-a' && record.action === 'discover'))
    const stats = await auditStats(path)
    assert.equal(stats.recordCount, 20)
    assert.ok(stats.totalBytes > 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
