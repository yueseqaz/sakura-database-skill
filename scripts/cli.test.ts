import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { createPool, type RowDataPacket } from 'mysql2/promise'

const execFileAsync = promisify(execFile)
const root = new URL('..', import.meta.url).pathname

async function cli(args: string[], environment: NodeJS.ProcessEnv) {
  return execFileAsync('npx', ['tsx', 'scripts/db-agent.ts', ...args], { cwd: root, env: { ...process.env, ...environment } })
}

test('runs a plan through the CLI, masks results, and emits an audit event', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-agent-cli-'))
  const planPath = join(directory, 'plan.json')
  const auditPath = join(directory, 'audit.jsonl')
  const table = `cli_users_${process.pid}`
  const setup = createPool(process.env.TEST_MYSQL_URL as string)
  await setup.query(`create table \`${table}\` (id integer primary key auto_increment, email varchar(255), status varchar(32))`)
  await setup.query(`insert into \`${table}\` (email, status) values ('person@example.test', 'active')`)
  await writeFile(planPath, JSON.stringify({ table, columns: ['id', 'email'], where: [{ column: 'status', op: '=', value: 'active' }] }))
  try {
    const { stdout } = await cli(['plan', '--file', planPath, '--audit-log', auditPath], { DATABASE_URL: process.env.TEST_MYSQL_URL })
    assert.deepEqual(JSON.parse(stdout), { rows: [{ id: 1, email: '[REDACTED]' }], rowCount: 1, page: { returned: 1, hasMore: false } })
    assert.match(await readFile(auditPath, 'utf8'), new RegExp(`plan:${table}`))
  } finally {
    await setup.query(`drop table if exists \`${table}\``)
    await setup.end()
    await rm(directory, { recursive: true, force: true })
  }
})

test('previews and transactionally executes insert, update, and delete plans', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-agent-mutation-'))
  const configPath = join(directory, 'profiles.json')
  const planPath = join(directory, 'mutation.json')
  const auditPath = join(directory, 'audit.jsonl')
  const table = `mutation_users_${process.pid}`
  const setup = createPool(process.env.TEST_MYSQL_URL as string)
  await setup.query(`create table \`${table}\` (id integer primary key auto_increment, tenant_id integer not null, name varchar(255), status varchar(32), version integer not null default 1)`)
  await writeFile(configPath, JSON.stringify({ profiles: { writer: {
    dialect: 'mysql', urlEnv: 'TEST_MYSQL_URL', environment: 'development', allowWrites: true, allowDelete: true,
    maxAffectedRows: 2, allowedTables: [table], requiredFilters: { [table]: ['tenant_id'] }, auditLog: auditPath,
  } } }))
  const runMutation = async (plan: unknown, execute = false) => {
    await writeFile(planPath, JSON.stringify(plan))
    const args = ['mutate', '--file', planPath, '--profile', 'writer', '--config', configPath]
    if (execute) {
      const preview = JSON.parse((await cli(args, { TEST_MYSQL_URL: process.env.TEST_MYSQL_URL })).stdout) as { planFingerprint: string }
      args.push('--execute', '--approve', 'test-ticket', '--confirm', preview.planFingerprint)
      if ((plan as { operation?: string }).operation === 'insert') args.push('--idempotency-key', `${table}:insert`)
    }
    return JSON.parse((await cli(args, { TEST_MYSQL_URL: process.env.TEST_MYSQL_URL })).stdout) as Record<string, unknown>
  }
  try {
    const insert = { operation: 'insert', table, rows: [{ tenant_id: 7, name: 'Ada', status: 'active' }] }
    assert.equal((await runMutation(insert)).mode, 'preview')
    assert.equal(((await setup.query(`select count(*) count from \`${table}\``))[0] as RowDataPacket[])[0].count, 0)
    assert.deepEqual({ affectedRows: (await runMutation(insert, true)).affectedRows, replay: (await runMutation(insert, true)).idempotentReplay }, { affectedRows: 1, replay: true })
    assert.equal(((await setup.query(`select count(*) count from \`${table}\``))[0] as RowDataPacket[])[0].count, 1)

    const update = { operation: 'update', table, set: { status: 'disabled', version: 2 }, where: { column: 'tenant_id', op: '=', value: 7 }, optimisticLock: { column: 'version', value: 1 } }
    assert.equal((await runMutation(update, true)).affectedRows, 1)
    assert.equal(((await setup.query(`select status from \`${table}\` where tenant_id = 7`))[0] as RowDataPacket[])[0].status, 'disabled')
    await assert.rejects(() => runMutation(update, true), /CONCURRENT_MODIFICATION/)

    assert.equal((await runMutation({ operation: 'delete', table, where: { column: 'tenant_id', op: '=', value: 7 }, optimisticLock: { column: 'version', value: 2 } }, true)).affectedRows, 1)
    assert.equal(((await setup.query(`select count(*) count from \`${table}\``))[0] as RowDataPacket[])[0].count, 0)
    assert.match(await readFile(auditPath, 'utf8'), new RegExp(`execute:delete:${table}`))
  } finally {
    await setup.query(`drop table if exists \`${table}\``)
    await setup.end()
    await rm(directory, { recursive: true, force: true })
  }
})

test('creates a profile template through the CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-agent-config-'))
  const configPath = join(directory, 'profiles.json')
  try {
    const { stdout } = await cli(['config', 'init', '--config', configPath], {})
    assert.equal(JSON.parse(stdout).created, configPath)
    const production = JSON.parse(await readFile(configPath, 'utf8')).profiles.production
    assert.ok(production)
    assert.equal(production.allowWrites, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('reports local readiness through the doctor command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-agent-doctor-'))
  try {
    const { stdout } = await cli(['doctor', '--config', join(directory, 'missing.json')], {
      DATABASE_URL: 'mysql://readonly:secret@127.0.0.1:3306/app',
    })
    const report = JSON.parse(stdout) as { ok: boolean; checks: Array<{ name: string; ok: boolean }> }
    assert.equal(report.ok, true)
    assert.equal(report.checks.find((check) => check.name === 'runtime')?.ok, true)
    assert.equal(report.checks.find((check) => check.name === 'connection-config')?.ok, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects the removed raw SQL command', async () => {
  await assert.rejects(() => cli(['query', '--sql', 'select 1'], {}), (error: unknown) => {
    if (!(error instanceof Error)) return false
    const payload = JSON.parse((error as Error & { stderr?: string }).stderr ?? '{}') as { error?: { code?: string; message?: string } }
    return payload.error?.code === 'INVALID_REQUEST' && payload.error.message === 'Unknown command: query'
  })
})
