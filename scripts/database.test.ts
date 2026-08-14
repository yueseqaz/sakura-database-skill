import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fingerprintStatement, writeAudit } from './audit.js'
import { connect, discover, discoverPage, discoverTables, explainPlan, queryPlan, statistics, type DatabaseClient } from './database.js'
import { maskRows } from './core.js'

test('rejects non-MySQL database dialects', () => {
  assert.throws(() => connect('postgres' as never, 'postgres://localhost/app'), /only supports MySQL/i)
})

test('executes a parameterized plan and masks the returned email', async () => {
  const executed: Array<{ statement: string; parameters: unknown[] }> = []
  const db: DatabaseClient = {
    async execute(statement, parameters = []) {
      executed.push({ statement, parameters })
      if (statement.includes('information_schema.columns')) return { rows: [{
        table_name: 'users', table_type: 'BASE TABLE', column_name: 'id', data_type: 'int', is_nullable: 'NO', extra: 'auto_increment', column_default: null,
      }] }
      if (statement.includes('information_schema.tables where')) return { rows: [{ table_count: 1 }] }
      return { rows: [{ id: 1, email: 'person@example.test' }] }
    },
    async transaction(run) { return run({ execute: db.execute }) },
    async destroy() {},
  }
  const tables = await discover(db, 'users')
  assert.equal(tables.length, 1)
  const stats = await statistics(db, 'mysql') as Array<Record<string, unknown>>
  assert.equal(stats[0].table_count, 1)
  const result = await queryPlan(db, 'mysql', {
    table: 'users', columns: ['id', 'email'], where: [{ column: 'status', op: '=', value: 'active' }],
  }, { maxRows: 5 })
  assert.deepEqual(maskRows(result.rows), [{ id: 1, email: '[REDACTED]' }])
  assert.deepEqual(executed.at(-1)?.parameters, ['active', 5])
})

test('explains a structured plan without accepting raw SQL', async () => {
  let executed: { statement: string; parameters: unknown[] } | undefined
  const db: DatabaseClient = {
    async execute(statement, parameters = []) {
      executed = { statement, parameters }
      return { rows: [{ type: 'ref', rows: 5 }] }
    },
    async transaction(run) { return run({ execute: db.execute }) },
    async destroy() {},
  }
  const result = await explainPlan(db, {
    table: 'users', columns: ['id'], where: [{ column: 'status', op: '=', value: 'active' }], limit: 10,
  }, { maxRows: 50 })
  assert.equal(executed?.statement, 'EXPLAIN select `id` from `users` where `status` = ? limit ?')
  assert.deepEqual(executed?.parameters, ['active', 10])
  assert.deepEqual(result.rows, [{ type: 'ref', rows: 5 }])
})

test('discovers exact plan tables without scanning the full schema', async () => {
  const calls: Array<{ statement: string; parameters: unknown[] }> = []
  const db: DatabaseClient = {
    async execute(statement, parameters = []) {
      calls.push({ statement, parameters })
      return { rows: parameters.map((name) => ({
        table_schema: 'app', table_name: name, table_type: 'BASE TABLE', column_name: 'id', data_type: 'int', is_nullable: 'NO', extra: '', column_default: null,
      })) }
    },
    async transaction(run) { return run({ execute: db.execute }) },
    async destroy() {},
  }
  const tables = await discoverTables(db, ['users', 'orders'])
  assert.deepEqual(tables.map((table) => table.name), ['users', 'orders'])
  assert.match(calls[0].statement, /table_name in \(\?, \?\)/i)
  assert.deepEqual(calls[0].parameters, ['users', 'orders'])
  await assert.rejects(() => discoverTables(db, ['__sakura_database_idempotency']), /reserved internal table/i)
})

test('paginates schema discovery with an opaque cursor', async () => {
  let call = 0
  const db: DatabaseClient = {
    async execute(_statement, parameters = []) {
      call += 1
      if (call === 1) return { rows: [{ table_name: 'orders' }, { table_name: 'projects' }, { table_name: 'users' }] }
      return { rows: (parameters as string[]).map((name) => ({
        table_schema: 'app', table_name: name, table_type: 'BASE TABLE', column_name: 'id', data_type: 'int', is_nullable: 'NO', extra: '', column_default: null,
      })) }
    },
    async transaction(run) { return run({ execute: db.execute }) },
    async destroy() {},
  }
  const page = await discoverPage(db, { limit: 2, cursor: Buffer.from('customers').toString('base64url'), search: 'er' })
  assert.deepEqual(page.tables.map((table) => table.name), ['orders', 'projects'])
  assert.equal(page.nextCursor, Buffer.from('projects').toString('base64url'))
  await assert.rejects(() => discoverPage(db, { limit: Number.NaN }), /integer between 1 and 100/i)
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
