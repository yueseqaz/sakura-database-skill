import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { discoverProjectProfiles, importDiscoveredProfile, loadConfig, resolveConnection } from './config.js'

test('discovers and imports a dotenv connection without copying credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-agent-project-config-'))
  const configPath = join(directory, 'profiles.json')
  const projectPath = join(directory, 'project')
  await writeFile(join(directory, '.placeholder'), '')
  try {
    await mkdir(projectPath)
    await writeFile(join(projectPath, '.env.local'), 'DATABASE_URL=mysql://reader:do-not-copy@db.internal:3306/app\n')

    const candidates = await discoverProjectProfiles(projectPath)
    assert.equal(candidates.length, 1)
    assert.doesNotMatch(JSON.stringify(candidates), /do-not-copy/)
    assert.match(candidates[0].preview, /\[REDACTED\]/)

    await importDiscoveredProfile({ projectPath, candidateId: candidates[0].id, profileName: 'project-dev', configPath })
    const stored = await readFile(configPath, 'utf8')
    assert.doesNotMatch(stored, /do-not-copy/)
    assert.match(stored, /credentialSource/)

    const profile = (await loadConfig(configPath)).profiles['project-dev']
    assert.equal((await resolveConnection(profile)).url, 'mysql://reader:do-not-copy@db.internal:3306/app')
    await assert.rejects(
      () => importDiscoveredProfile({ projectPath, candidateId: candidates[0].id, profileName: 'project-dev', configPath }),
      /already exists/i,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('discovers split dotenv connection fields and ignores template env files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-agent-split-env-'))
  const configPath = join(directory, 'profiles.json')
  try {
    await writeFile(join(directory, '.env'), 'DB_HOST=mysql.internal\nDB_PORT=3307\nDB_NAME=app\nDB_USER=reader\nDB_PASSWORD=split-secret\n')
    await writeFile(join(directory, '.env.example'), 'DATABASE_URL=mysql://example:example@localhost:3306/example\n')
    const candidates = await discoverProjectProfiles(directory)
    assert.equal(candidates.length, 1)
    assert.doesNotMatch(JSON.stringify(candidates), /split-secret|example:example/)

    await importDiscoveredProfile({ projectPath: directory, candidateId: candidates[0].id, profileName: 'split', configPath })
    const profile = (await loadConfig(configPath)).profiles.split
    assert.equal((await resolveConnection(profile)).url, 'mysql://reader:split-secret@mysql.internal:3307/app')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('discovers Spring YAML datasource fields and resolves placeholders at connection time', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-agent-spring-config-'))
  const configPath = join(directory, 'profiles.json')
  const yamlPath = join(directory, 'application.yml')
  try {
    await writeFile(yamlPath, `spring:\n  datasource:\n    url: jdbc:mysql://mysql.internal:3306/talent\n    username: \${MYSQL_USER}\n    password: \${MYSQL_PASSWORD}\n`)
    const [candidate] = await discoverProjectProfiles(directory)
    assert.equal(candidate.format, 'spring-yaml')
    assert.equal(candidate.database, 'talent')
    assert.doesNotMatch(JSON.stringify(candidate), /MYSQL_PASSWORD.*secret/)

    await importDiscoveredProfile({ projectPath: directory, candidateId: candidate.id, profileName: 'spring', configPath })
    const profile = (await loadConfig(configPath)).profiles.spring
    const connection = await resolveConnection(profile, { MYSQL_USER: 'service', MYSQL_PASSWORD: 'secret' })
    assert.equal(connection.url, 'mysql://service:secret@mysql.internal:3306/talent')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

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
      auditMaxBytes: 5_242_880, auditRetentionFiles: 10,
    } } }))
    const config = await loadConfig(path)
    assert.equal(config.profiles.admin.allowSchemaChanges, true)
    assert.deepEqual(config.profiles.admin.allowedDatabases, ['sandbox'])
    assert.equal(config.profiles.admin.auditMaxBytes, 5_242_880)
    assert.equal(config.profiles.admin.auditRetentionFiles, 10)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
