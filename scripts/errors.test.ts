import assert from 'node:assert/strict'
import test from 'node:test'
import { errorPayload } from './errors.js'

test('maps safety failures to stable structured error codes', () => {
  assert.deepEqual(errorPayload(new Error('Mutation plans require allowWrites: true in the selected profile.')), {
    error: { code: 'WRITE_NOT_ALLOWED', message: 'Mutation plans require allowWrites: true in the selected profile.' },
  })
  assert.equal(errorPayload(new Error('Mutation execution requires the matching preview fingerprint.')).error.code, 'PLAN_FINGERPRINT_MISMATCH')
  assert.equal(errorPayload(new Error('Unknown table in observed schema: users')).error.code, 'TABLE_NOT_FOUND')
})

test('redacts low-level connection errors and credentials', () => {
  const failure = Object.assign(new Error('connect ECONNREFUSED mysql://root:secret@127.0.0.1/app'), { code: 'ECONNREFUSED' })
  const payload = errorPayload(failure)
  assert.deepEqual(payload, { error: { code: 'CONNECTION_FAILED', message: 'Could not connect to the configured database.' } })
  assert.doesNotMatch(JSON.stringify(payload), /secret|root/)
})
