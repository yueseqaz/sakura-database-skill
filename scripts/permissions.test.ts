import assert from 'node:assert/strict'
import test from 'node:test'
import type { DatabaseClient } from './database.js'
import { hasPrivilege, permissions } from './permissions.js'

test('reports effective account capabilities from MySQL metadata', async () => {
  const db: DatabaseClient = {
    async execute(statement) {
      if (statement.includes('current_user()')) return { rows: [{ account: 'agent@localhost', database_name: 'app' }] }
      return { rows: [
        { privilege: 'SELECT', scope_name: 'database', table_name: null },
        { privilege: 'INSERT', scope_name: 'database', table_name: null },
        { privilege: 'ALTER', scope_name: 'table', table_name: 'users' },
      ] }
    },
    async transaction(run) { return run({ execute: db.execute }) },
    async destroy() {},
  }
  const report = await permissions(db)
  assert.equal(report.account, 'agent@localhost')
  assert.equal(report.capabilities.query, true)
  assert.equal(report.capabilities.update, false)
  assert.equal(report.capabilities.alterTable, true)
  assert.equal(hasPrivilege(report, 'ALTER', 'users'), true)
  assert.equal(hasPrivilege(report, 'ALTER', 'orders'), false)
})

test('caches permission metadata for the life of a database connection', async () => {
  let calls = 0
  const db: DatabaseClient = {
    async execute(statement) {
      calls += 1
      if (statement.includes('current_user()')) return { rows: [{ account: 'agent@localhost', database_name: 'app' }] }
      return { rows: [] }
    },
    async transaction(run) { return run({ execute: db.execute }) },
    async destroy() {},
  }
  await permissions(db)
  await permissions(db)
  assert.equal(calls, 2)
  await permissions(db, true)
  assert.equal(calls, 4)
})
