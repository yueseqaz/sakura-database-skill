import assert from 'node:assert/strict'
import test from 'node:test'
import { errorPayload } from './errors.js'

test('maps safety failures to stable structured error codes', () => {
  assert.deepEqual(errorPayload(new Error('Mutation plans require allowWrites: true in the selected profile.')), {
    error: {
      code: 'WRITE_NOT_ALLOWED', message: 'Mutation plans require allowWrites: true in the selected profile.',
      retryable: false, requiredAction: 'STOP',
    },
  })
  assert.equal(errorPayload(new Error('Mutation execution requires the matching preview fingerprint.')).error.code, 'PLAN_FINGERPRINT_MISMATCH')
  assert.equal(errorPayload(new Error('Unknown table in observed schema: users')).error.code, 'TABLE_NOT_FOUND')
  assert.equal(errorPayload(new Error('The row changed since preview.')).error.code, 'CONCURRENT_MODIFICATION')
  assert.equal(errorPayload(new Error('Idempotency key was already used for a different mutation plan.')).error.code, 'IDEMPOTENCY_CONFLICT')
  assert.equal(errorPayload(new Error('Schema changes require allowSchemaChanges: true in the selected profile.')).error.code, 'SCHEMA_CHANGE_NOT_ALLOWED')
  assert.equal(errorPayload(new Error('The schema state changed since preview.')).error.code, 'SCHEMA_STATE_CHANGED')
  assert.equal(errorPayload(new Error('Destructive schema execution requires a backup reference.')).error.code, 'BACKUP_CONFIRMATION_REQUIRED')
})

test('returns deterministic machine-actionable recovery instructions', () => {
  assert.deepEqual(errorPayload(new Error('An approval token is required for query against this profile.'), 'task-42').error, {
    code: 'APPROVAL_REQUIRED',
    message: 'An approval token is required for query against this profile.',
    correlationId: 'task-42',
    retryable: true,
    requiredAction: 'REQUEST_APPROVAL',
  })
  assert.equal(errorPayload(new Error('The row changed since preview.'), 'task-42').error.requiredAction, 'REDISCOVER_AND_PREVIEW')
  assert.equal(errorPayload(new Error('The schema state changed since preview.'), 'task-42').error.requiredAction, 'REDISCOVER_SCHEMA')
  assert.equal(errorPayload(new Error('The mutation exceeds the affected-row limit.'), 'task-42').error.requiredAction, 'NARROW_FILTER')
  assert.equal(errorPayload(new Error('Drop operations require allowDrop: true.'), 'task-42').error.requiredAction, 'STOP')
  assert.equal(errorPayload(new Error('The database operation succeeded, but its audit outcome could not be written.'), 'task-42').error.requiredAction, 'CHECK_AUDIT_BEFORE_RETRY')
})

test('redacts low-level connection errors and credentials', () => {
  const failure = Object.assign(new Error('connect ECONNREFUSED mysql://root:secret@127.0.0.1/app'), { code: 'ECONNREFUSED' })
  const payload = errorPayload(failure)
  assert.deepEqual(payload, { error: {
    code: 'CONNECTION_FAILED', message: 'Could not connect to the configured database.',
    retryable: true, requiredAction: 'FIX_PROFILE',
  } })
  assert.doesNotMatch(JSON.stringify(payload), /secret|root/)
})
