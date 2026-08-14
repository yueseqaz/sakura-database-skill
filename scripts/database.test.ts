import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { fingerprintStatement, writeAudit } from './audit.js'
import { connect, discover, query, queryPlan, statistics } from './database.js'
import { maskRows } from './core.js'

test('executes a parameterized plan and masks the returned email', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-agent-'))
  const path = join(directory, 'test.db')
  const setup = new Database(path)
  setup.exec("create table users (id integer primary key, email text, status text); insert into users (email, status) values ('person@example.test', 'active')")
  setup.close()

  const db = connect('sqlite', `sqlite://${path}`)
  try {
    const tables = await discover(db, 'users')
    assert.equal(tables.length, 1)
    const stats = await statistics(db, 'sqlite') as Array<Record<string, unknown>>
    assert.equal(stats[0].table_count, 1)
    const result = await queryPlan(db, 'sqlite', {
      table: 'users', columns: ['id', 'email'], where: [{ column: 'status', op: '=', value: 'active' }],
    }, { maxRows: 5 })
    assert.deepEqual(maskRows(result.rows as Array<Record<string, unknown>>), [{ id: 1, email: '[REDACTED]' }])
    await assert.rejects(() => query(db, "update users set status = 'disabled'"), /readonly/i)
  } finally {
    await db.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})

test('writes audit events without query values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-agent-audit-'))
  const path = join(directory, 'audit.jsonl')
  try {
    await writeAudit({ action: 'plan:users', success: true, rowCount: 1 }, path)
    const record = JSON.parse((await readFile(path, 'utf8')).trim()) as Record<string, unknown>
    assert.equal(record.action, 'plan:users')
    assert.equal(record.rowCount, 1)
    assert.equal(typeof record.timestamp, 'string')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('creates a stable query fingerprint without retaining SQL text', () => {
  const first = fingerprintStatement('select id from users where status = ?')
  const second = fingerprintStatement('  select  id  from users where status = ?  ')
  assert.equal(first, second)
  assert.equal(first.length, 16)
  assert.ok(!first.includes('users'))
})
