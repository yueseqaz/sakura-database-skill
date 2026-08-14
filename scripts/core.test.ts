import assert from 'node:assert/strict'
import test from 'node:test'
import { compileSelectPlan, maskRows, validatePolicy } from './core.js'

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
