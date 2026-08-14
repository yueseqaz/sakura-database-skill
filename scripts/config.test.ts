import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadConfig } from './config.js'

test('validates profile configuration before it is used', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-agent-config-validation-'))
  const path = join(directory, 'profiles.json')
  try {
    await writeFile(path, JSON.stringify({ profiles: { broken: { dialect: 'oracle', maxRows: -1 } } }))
    await assert.rejects(() => loadConfig(path), /Invalid configuration/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects non-MySQL profiles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-agent-mysql-only-'))
  const path = join(directory, 'profiles.json')
  try {
    await writeFile(path, JSON.stringify({ profiles: { legacy: { dialect: 'postgres', urlEnv: 'DATABASE_URL' } } }))
    await assert.rejects(() => loadConfig(path), /Invalid configuration/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('accepts explicit schema-change policy controls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-agent-schema-policy-'))
  const path = join(directory, 'profiles.json')
  try {
    await writeFile(path, JSON.stringify({ profiles: { admin: {
      dialect: 'mysql', urlEnv: 'DATABASE_URL', allowSchemaChanges: true, allowDrop: false,
      allowCreateDatabase: true, allowedDatabases: ['sandbox'], allowedTables: ['users'],
    } } }))
    const config = await loadConfig(path)
    assert.equal(config.profiles.admin.allowSchemaChanges, true)
    assert.deepEqual(config.profiles.admin.allowedDatabases, ['sandbox'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
