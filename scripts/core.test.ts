import assert from 'node:assert/strict'
import test from 'node:test'
import { compileSelectPlan, maskRows, safeStatement, validatePlanPolicy, validatePlanSchema, validatePolicy, validateRawSqlAccess, validateSensitiveAccess } from './core.js'

test('compiles a structured select plan with bound values and a capped limit', () => {
  const compiled = compileSelectPlan({
    table: 'users',
    columns: ['id', 'email'],
    where: [{ column: 'status', op: '=', value: 'active' }],
    limit: 10_000,
  }, { maxRows: 100 })

  assert.equal(compiled.sql, 'select `id`, `email` from `users` where `status` = ? limit ?')
  assert.deepEqual(compiled.parameters, ['active', 100])
})

test('rejects unsafe identifiers and unsupported comparison operators', () => {
  assert.throws(() => compileSelectPlan({ table: 'users; drop table users', columns: ['id'] }), /identifier/)
  assert.throws(() => compileSelectPlan({ table: 'users', columns: ['id'], where: [{ column: 'id', op: 'raw' as never, value: 1 }] }), /operator/)
})

test('masks sensitive result fields by default', () => {
  assert.deepEqual(maskRows([{ id: 7, email: 'person@example.test', password: 'hash', displayName: 'Ada' }]), [{
    id: 7,
    email: '[REDACTED]',
    password: '[REDACTED]',
    displayName: 'Ada',
  }])
})

test('requires an explicit approval token for protected profiles', () => {
  assert.throws(() => validatePolicy({ environment: 'production' }, { action: 'query', approvalToken: undefined }), /approval token/)
  assert.doesNotThrow(() => validatePolicy({ environment: 'production' }, { action: 'query', approvalToken: 'approved' }))
})

test('parses SQL and rejects write-capable CTEs and SELECT INTO', () => {
  assert.equal(safeStatement('with recent as (select id from users) select id from recent', 'postgres'), 'with recent as (select id from users) select id from recent')
  assert.throws(() => safeStatement('with changed as (update users set active = false returning id) select id from changed', 'postgres'), /read-only/i)
  assert.throws(() => safeStatement('select id into copied_users from users', 'postgres'), /read-only/i)
})

test('validates plans against observed tables and columns', () => {
  const schema = [{ name: 'users', columns: [{ name: 'id' }, { name: 'status' }] }]
  assert.doesNotThrow(() => validatePlanSchema({ table: 'users', columns: ['id'], where: [{ column: 'status', op: '=', value: 'active' }] }, schema))
  assert.throws(() => validatePlanSchema({ table: 'accounts', columns: ['id'] }, schema), /Unknown table/)
  assert.throws(() => validatePlanSchema({ table: 'users', columns: ['email'] }, schema), /Unknown column/)
})

test('requires profile authorization before returning sensitive fields', () => {
  assert.throws(() => validateSensitiveAccess({}, true), /allowSensitive/)
  assert.doesNotThrow(() => validateSensitiveAccess({ allowSensitive: true }, true))
  assert.doesNotThrow(() => validateSensitiveAccess({}, false))
})

test('compiles nested filters, aggregates, grouping, HAVING, and a controlled join', () => {
  const compiled = compileSelectPlan({
    table: 'orders',
    as: 'o',
    columns: [
      { column: 'o.customer_id', as: 'customer_id' },
      { aggregate: 'count', column: 'o.id', as: 'order_count' },
    ],
    joins: [{ table: 'customers', as: 'c', type: 'left', on: [{ left: 'o.customer_id', op: '=', right: 'c.id' }] }],
    where: { and: [
      { column: 'o.status', op: 'in', value: ['paid', 'shipped'] },
      { or: [
        { column: 'c.deleted_at', op: 'is null' },
        { column: 'o.created_at', op: 'between', value: ['2026-01-01', '2026-12-31'] },
      ] },
    ] },
    groupBy: ['o.customer_id'],
    having: { column: { aggregate: 'count', column: 'o.id' }, op: '>', value: 1 },
    orderBy: [{ column: 'o.customer_id', direction: 'asc' }],
    limit: 50,
  }, { maxRows: 100 }, 'postgres')

  assert.equal(compiled.sql, 'select "o"."customer_id" as "customer_id", COUNT("o"."id") as "order_count" from "orders" as "o" left join "customers" as "c" on "o"."customer_id" = "c"."id" where ("o"."status" IN ($1, $2) and ("c"."deleted_at" IS NULL or "o"."created_at" BETWEEN $3 AND $4)) group by "o"."customer_id" having COUNT("o"."id") > $5 order by "o"."customer_id" ASC limit $6')
  assert.deepEqual(compiled.parameters, ['paid', 'shipped', '2026-01-01', '2026-12-31', 1, 50])
})

test('validates joined plans against observed schema aliases', () => {
  const schema = [
    { name: 'orders', columns: [{ name: 'id' }, { name: 'customer_id' }] },
    { name: 'customers', columns: [{ name: 'id' }, { name: 'name' }] },
  ]
  assert.doesNotThrow(() => validatePlanSchema({
    table: 'orders', as: 'o', columns: ['c.name'],
    joins: [{ table: 'customers', as: 'c', on: [{ left: 'o.customer_id', op: '=', right: 'c.id' }] }],
  }, schema))
  assert.throws(() => validatePlanSchema({
    table: 'orders', as: 'o', columns: ['c.email'],
    joins: [{ table: 'customers', as: 'c', on: [{ left: 'o.customer_id', op: '=', right: 'c.id' }] }],
  }, schema), /Unknown column/)
})

test('enforces table, column, required-filter, and raw SQL profile policies', () => {
  const plan = {
    table: 'orders', columns: ['id', 'status'],
    where: [{ column: 'tenant_id', op: '=' as const, value: 7 }],
  }
  assert.doesNotThrow(() => validatePlanPolicy(plan, {
    allowedTables: ['orders'],
    deniedColumns: { orders: ['internal_note'] },
    requiredFilters: { orders: ['tenant_id'] },
  }))
  assert.throws(() => validatePlanPolicy({ ...plan, columns: ['id', 'internal_note'] }, { deniedColumns: { orders: ['internal_note'] } }), /denied by policy/)
  assert.throws(() => validatePlanPolicy({ ...plan, where: [] }, { requiredFilters: { orders: ['tenant_id'] } }), /required filter/)
  assert.throws(() => validatePlanPolicy({
    ...plan,
    where: { or: [{ column: 'tenant_id', op: '=', value: 7 }, { column: 'status', op: '=', value: 'open' }] },
  }, { requiredFilters: { orders: ['tenant_id'] } }), /required filter/)
  assert.throws(() => validatePlanPolicy(plan, { allowedTables: ['customers'] }), /not allowed/)
  assert.throws(() => validateRawSqlAccess({ allowRawSql: false }), /disabled/)
  assert.throws(() => validateRawSqlAccess({ allowedTables: ['orders'] }), /explicitly enabled/)
  assert.doesNotThrow(() => validateRawSqlAccess({}))
  assert.doesNotThrow(() => validateRawSqlAccess({ allowedTables: ['orders'], allowRawSql: true }))
})
