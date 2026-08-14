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
  assert.throws(() => compileMutationPlan({ operation: 'insert', table: '__sakura_database_idempotency', rows: [{ result_json: null }] }, { allowWrites: true }), /reserved internal table/i)
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

test('adds an optimistic lock to update and delete predicates', () => {
  assert.deepEqual(compileMutationPlan({
    operation: 'update', table: 'users', set: { status: 'disabled' },
    where: { column: 'id', op: '=', value: 9 },
    optimisticLock: { column: 'version', value: 3 },
  }, { allowWrites: true, maxAffectedRows: 1 }), {
    operation: 'update', table: 'users',
    sql: 'update `users` set `status` = ? where (`id` = ? and `version` = ?) limit ?',
    parameters: ['disabled', 9, 3, 2], maximumAffectedRows: 1,
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
  await assert.rejects(() => executeMutation(db, plan, policy, {
    approvalToken: 'ticket-42', confirmFingerprint: mutationPlanFingerprint('default', plan, policy),
  }), /affected-row limit/)
  assert.equal(committed, false)
  assert.equal(rolledBack, true)
})

test('rejects an optimistic write when the observed version changed', async () => {
  const transaction: TransactionClient = { async execute() { return { rows: [], affectedRows: 0 } } }
  const db: DatabaseClient = {
    async execute() { return { rows: [] } },
    async transaction(run) { return run(transaction) },
    async destroy() {},
  }
  const plan = {
    operation: 'update', table: 'users', set: { status: 'disabled' },
    where: { column: 'id', op: '=', value: 9 }, optimisticLock: { column: 'version', value: 3 },
  } as const
  const policy = { allowWrites: true, maxAffectedRows: 1 }
  await assert.rejects(() => executeMutation(db, plan, policy, {
    approvalToken: 'ticket-42', profileName: 'writer',
    confirmFingerprint: mutationPlanFingerprint('writer', plan, policy),
  }), /changed since preview/i)
})

test('executes the same idempotency key once and rejects key reuse for another plan', async () => {
  const records = new Map<string, { fingerprint: string; owner: string; result?: string }>()
  let businessExecutions = 0
  const transaction: TransactionClient = {
    async execute(statement, parameters = []) {
      if (statement.startsWith('insert ignore into `__sakura_database_idempotency`')) {
        const [profile, key, fingerprint, owner] = parameters.map(String)
        const inserted = !records.has(`${profile}:${key}`)
        if (inserted) records.set(`${profile}:${key}`, { fingerprint, owner })
        return { rows: [], affectedRows: inserted ? 1 : 0 }
      }
      if (statement.startsWith('select plan_fingerprint')) {
        const record = records.get(`${parameters[0]}:${parameters[1]}`) as { fingerprint: string; owner: string; result?: string }
        return { rows: [{ plan_fingerprint: record.fingerprint, owner_token: record.owner, result_json: record.result ?? null }] }
      }
      if (statement.startsWith('update `__sakura_database_idempotency`')) {
        const record = records.get(`${parameters[1]}:${parameters[2]}`) as { fingerprint: string; owner: string; result?: string }
        record.result = String(parameters[0])
        return { rows: [], affectedRows: 1 }
      }
      businessExecutions += 1
      return { rows: [], affectedRows: 1, insertId: 81 }
    },
  }
  const db: DatabaseClient = {
    async execute() { return { rows: [] } },
    async transaction(run) { return run(transaction) },
    async ensureIdempotencyStore() {},
    async destroy() {},
  }
  const plan: MutationPlan = { operation: 'insert', table: 'users', rows: [{ name: 'Ada' }] }
  const changedPlan: MutationPlan = { operation: 'insert', table: 'users', rows: [{ name: 'Lin' }] }
  const policy = { allowWrites: true, maxAffectedRows: 1 }
  const execute = (input: MutationPlan, key?: string) => executeMutation(db, input, policy, {
    approvalToken: 'ticket-42', profileName: 'writer', idempotencyKey: key,
    confirmFingerprint: mutationPlanFingerprint('writer', input, policy),
  })
  await assert.rejects(() => execute(plan), /idempotency key/i)
  assert.deepEqual(await execute(plan, 'task-9321'), { operation: 'insert', table: 'users', affectedRows: 1, insertId: 81, idempotentReplay: false })
  assert.deepEqual(await execute(plan, 'task-9321'), { operation: 'insert', table: 'users', affectedRows: 1, insertId: 81, idempotentReplay: true })
  assert.equal(businessExecutions, 1)
  await assert.rejects(() => executeMutation(db, changedPlan, policy, {
    approvalToken: 'ticket-42', profileName: 'writer', idempotencyKey: 'task-9321',
    confirmFingerprint: mutationPlanFingerprint('writer', changedPlan, policy),
  }), /different mutation plan/i)
})
