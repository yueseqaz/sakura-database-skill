import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureReadOnlyStatement, makeExplainStatement } from './db-agent.js'

test('permits a single SELECT statement', () => {
  assert.equal(ensureReadOnlyStatement('select id from users;'), 'select id from users')
})

test('rejects multiple and modifying statements', () => {
  assert.throws(() => ensureReadOnlyStatement('select 1; delete from users'), /one SQL statement/)
  assert.throws(() => ensureReadOnlyStatement('update users set admin = true'), /Only SELECT/)
  assert.throws(() => ensureReadOnlyStatement('with deleted as (delete from users returning id) select * from deleted'), /not allowed/)
})

test('selects a dialect-appropriate EXPLAIN form', () => {
  assert.equal(makeExplainStatement('postgres', 'select 1'), 'EXPLAIN select 1')
  assert.equal(makeExplainStatement('sqlite', 'select 1'), 'EXPLAIN QUERY PLAN select 1')
})
