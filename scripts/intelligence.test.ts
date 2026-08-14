import assert from 'node:assert/strict'
import test from 'node:test'
import { assessExplain, paginatePlan, summarizeSchema } from './intelligence.js'

const tables = [
  {
    name: 'orders',
    columns: [
      { name: 'id', type: 'integer', nullable: false },
      { name: 'email', type: 'varchar', nullable: true },
      { name: 'status', type: 'varchar', nullable: true },
      { name: 'customer_id', type: 'integer', nullable: true },
    ],
  },
  { name: 'customers', columns: [{ name: 'id', type: 'integer', nullable: false }, { name: 'name', type: 'varchar', nullable: true }] },
]

test('summarizes only observed schema facts without guessing relationships', () => {
  const summary = summarizeSchema(tables)
  assert.deepEqual(summary, {
    tableCount: 2,
    tables: [
      { name: 'orders', columnCount: 4, sensitiveColumns: ['email'] },
      { name: 'customers', columnCount: 2, sensitiveColumns: [] },
    ],
  })
})

test('reads PostgreSQL row estimates from textual EXPLAIN output', () => {
  assert.deepEqual(assessExplain('postgres', [{ 'QUERY PLAN': 'Seq Scan on events  (cost=0.00..2000.00 rows=50000 width=8)' }]), {
    risk: 'high', reasons: ['full table scan', 'estimated 50000 rows'], requiresApproval: true, estimatedRows: 50_000,
  })
})

test('uses a profile-specific estimated-row threshold', () => {
  assert.deepEqual(assessExplain('mysql', [{ type: 'ALL', rows: 2_000 }], 1_000), {
    risk: 'high', reasons: ['full table scan', 'estimated 2000 rows'], requiresApproval: true, estimatedRows: 2_000,
  })
})

test('calculates pagination and flags full table scans', () => {
  assert.deepEqual(paginatePlan({ table: 'users', columns: ['id'], limit: 10, offset: 20 }, 11), { returned: 10, hasMore: true, nextOffset: 30 })
  assert.deepEqual(assessExplain('mysql', [{ type: 'ALL', rows: 50_000, Extra: 'Using where' }]), {
    risk: 'high', reasons: ['full table scan', 'estimated 50000 rows'], requiresApproval: true, estimatedRows: 50_000,
  })
})
