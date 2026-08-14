import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import Database from 'better-sqlite3'

const execFileAsync = promisify(execFile)
const root = new URL('..', import.meta.url).pathname

async function cli(args: string[], environment: NodeJS.ProcessEnv) {
  return execFileAsync('npx', ['tsx', 'scripts/db-agent.ts', ...args], { cwd: root, env: { ...process.env, ...environment } })
}

test('runs a plan through the CLI, masks results, and emits an audit event', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-agent-cli-'))
  const databasePath = join(directory, 'app.db')
  const planPath = join(directory, 'plan.json')
  const auditPath = join(directory, 'audit.jsonl')
  const setup = new Database(databasePath)
  setup.exec("create table users (id integer primary key, email text, status text); insert into users (email, status) values ('person@example.test', 'active')")
  setup.close()
  await writeFile(planPath, JSON.stringify({ table: 'users', columns: ['id', 'email'], where: [{ column: 'status', op: '=', value: 'active' }] }))
  try {
    const { stdout } = await cli(['plan', '--file', planPath, '--audit-log', auditPath], { DB_DIALECT: 'sqlite', DATABASE_URL: `sqlite://${databasePath}` })
    assert.deepEqual(JSON.parse(stdout), { rows: [{ id: 1, email: '[REDACTED]' }], rowCount: 1 })
    assert.match(await readFile(auditPath, 'utf8'), /plan:users/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('creates a profile template through the CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-agent-config-'))
  const configPath = join(directory, 'profiles.json')
  try {
    const { stdout } = await cli(['config', 'init', '--config', configPath], {})
    assert.equal(JSON.parse(stdout).created, configPath)
    assert.ok(JSON.parse(await readFile(configPath, 'utf8')).profiles.production)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
