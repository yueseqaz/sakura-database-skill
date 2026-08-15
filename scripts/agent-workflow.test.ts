import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { errorPayload } from './errors.js'

test('agent recovery contract covers the complete safe mutation workflow', async () => {
  const skill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8')
  const errors = await readFile(new URL('../references/errors.md', import.meta.url), 'utf8')

  assert.match(skill, /default to read-only unless the user explicitly requests/i)
  assert.match(skill, /never invent an approval token/i)
  assert.match(skill, /preview again/i)
  assert.match(skill, /reuse.*idempotency/i)
  assert.match(skill, /never remove the lock/i)
  assert.match(skill, /audit.*before retrying/i)
  assert.match(skill, /database_audit_list/i)

  const expectations = [
    ['APPROVAL_REQUIRED', 'REQUEST_APPROVAL'],
    ['PLAN_FINGERPRINT_MISMATCH', 'REDISCOVER_AND_PREVIEW'],
    ['CONCURRENT_MODIFICATION', 'REDISCOVER_AND_PREVIEW'],
    ['IDEMPOTENCY_CONFLICT', 'CHECK_AUDIT_BEFORE_RETRY'],
    ['AUDIT_OUTCOME_FAILED', 'CHECK_AUDIT_BEFORE_RETRY'],
  ] as const
  for (const [code, action] of expectations) {
    assert.match(errors, new RegExp(`${code}.*${action}`, 's'))
  }

  assert.equal(errorPayload(new Error('The row changed since preview.'), 'workflow-1').error.correlationId, 'workflow-1')
})
