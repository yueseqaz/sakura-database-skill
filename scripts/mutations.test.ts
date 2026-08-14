import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compileMutationPlan,
  executeMutation,
  mutationPlanFingerprint,
  previewMutation,
  validateMutationExecution,
  type MutationPlan,
} from './mutations.js'
import type { DatabaseClient, TransactionClient } from './database.js'

test('compiles a bounded parameterized insert plan', () => {
  assert.deepEqual(compileMutationPlan({
    operation: 'insert', table: 'users', rows: [
      { tenant_id: 7, name: 'Ada' },
      { tenant_id: 7, name: 'Lin' },
    ],
  }, { allowWrites: true, maxAffectedRows: 10, requiredFilters: { users: ['tenant_id'] } }), {
    operation: 'insert',
    table: 'users',
    sql: 'insert into `users` (`tenant_id`, `name`) values (?, ?), (?, ?)',
    parameters: [7, 'Ada', 7, 'Lin'],
    maximumAffectedRows: 10,
  })
})

test('requires filters for update and delete plans', () => {
  assert.throws(() => compileMutationPlan({ operation: 'update', table: 'users', set: { status: 'disabled' } } as unknown as MutationPlan, { allowWrites: true }), /filter/i)
  assert.throws(() => compileMutationPlan({ operation: 'delete', table: 'users' } as unknown as MutationPlan, { allowWrites: true, allowDelete: true }), /filter/i)
})

test('compiles bounded update and delete plans and previews matching rows', async () => {
  assert.deepEqual(compileMutationPlan({
    operation: 'update', table: 'users', set: { status: 'disabled' }, where: { column: 'tenant_id', op: '=', value: 7 },
  }, { allowWrites: true, maxAffectedRows: 2, requiredFilters: { users: ['tenant_id'] } }), {
    operation: 'update', table: 'users', sql: 'update `users` set `status` = ? where `tenant_id` = ? limit ?',
    parameters: ['disabled', 7, 3], maximumAffectedRows: 2,
  })
  assert.deepEqual(compileMutationPlan({
    operation: 'delete', table: 'users', where: { column: 'tenant_id', op: '=', value: 7 },
  }, { allowWrites: true, allowDelete: true, maxAffectedRows: 2 }), {
    operation: 'delete', table: 'users', sql: 'delete from `users` where `tenant_id` = ? limit ?',
    parameters: [7, 3], maximumAffectedRows: 2,
  })
  const db: DatabaseClient = {
    async execute() { return { rows: [{ affected_rows: '3' }] } },
    async transaction(run) { return run({ execute: db.execute }) },
    async destroy() {},
  }
  assert.deepEqual(await previewMutation(db, {
    operation: 'update', table: 'users', set: { status: 'disabled' }, where: { column: 'tenant_id', op: '=', value: 7 },
  }, { allowWrites: true, maxAffectedRows: 2 }), {
    operation: 'update', table: 'users', estimatedRows: 3, maximumAffectedRows: 2, exceedsLimit: true,
    planFingerprint: mutationPlanFingerprint('default', {
      operation: 'update', table: 'users', set: { status: 'disabled' }, where: { column: 'tenant_id', op: '=', value: 7 },
    }, { allowWrites: true, maxAffectedRows: 2 }),
  })
})

test('enforces write, delete, column, and approval policies', () => {
  assert.throws(() => compileMutationPlan({ operation: 'insert', table: 'users', rows: [{ name: 'Ada' }] }, {}), /allowWrites/)
  assert.throws(() => compileMutationPlan({ operation: 'delete', table: 'users', where: { column: 'id', op: '=', value: 1 } }, { allowWrites: true }), /allowDelete/)
  assert.throws(() => compileMutationPlan({ operation: 'update', table: 'users', set: { role: 'admin' }, where: { column: 'id', op: '=', value: 1 } }, { allowWrites: true, deniedColumns: { users: ['role'] } }), /denied/)
  assert.throws(() => validateMutationExecution({ allowWrites: true }, true, undefined), /approval token/)
  assert.doesNotThrow(() => validateMutationExecution({ allowWrites: true }, true, 'ticket-42', 'fingerprint', 'fingerprint'))
})

test('binds mutation execution to a stable preview fingerprint', () => {
  const first = { operation: 'update', table: 'users', set: { status: 'disabled', name: 'Ada' }, where: { column: 'tenant_id', op: '=', value: 7 } } as const
  const reordered = { operation: 'update', table: 'users', set: { name: 'Ada', status: 'disabled' }, where: { value: 7, op: '=', column: 'tenant_id' } } as const
  const policy = { allowWrites: true, maxAffectedRows: 2, allowedTables: ['users'] }
  const fingerprint = mutationPlanFingerprint('writer', first, policy)
  assert.equal(fingerprint, mutationPlanFingerprint('writer', reordered, policy))
  assert.notEqual(fingerprint, mutationPlanFingerprint('writer', { ...first, set: { ...first.set, status: 'active' } }, policy))
  assert.notEqual(fingerprint, mutationPlanFingerprint('writer', first, { ...policy, maxAffectedRows: 3 }))
  assert.throws(() => validateMutationExecution(policy, true, 'ticket-42', undefined, fingerprint), /fingerprint/i)
  assert.throws(() => validateMutationExecution(policy, true, 'ticket-42', 'wrong', fingerprint), /fingerprint/i)
  assert.doesNotThrow(() => validateMutationExecution(policy, true, 'ticket-42', fingerprint, fingerprint))
})

test('rolls back when a mutation exceeds the affected-row limit', async () => {
  let committed = false
  let rolledBack = false
  const transaction: TransactionClient = {
    async execute() { return { rows: [], affectedRows: 3 } },
  }
  const db: DatabaseClient = {
    async execute() { return { rows: [] } },
    async transaction(run) {
      try {
        const value = await run(transaction)
        committed = true
        return value
      } catch (error) {
        rolledBack = true
        throw error
      }
    },
    async destroy() {},
  }
  const plan = {
    operation: 'update', table: 'users', set: { status: 'disabled' }, where: { column: 'tenant_id', op: '=', value: 7 },
  } as const
  const policy = { allowWrites: true, maxAffectedRows: 2 }
  await assert.rejects(() => executeMutation(db, plan, policy, 'ticket-42', mutationPlanFingerprint('default', plan, policy)), /affected-row limit/)
  assert.equal(committed, false)
  assert.equal(rolledBack, true)
})
