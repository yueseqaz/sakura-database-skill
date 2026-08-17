import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPool } from 'mysql2/promise'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { writeAudit } from './audit.js'

const root = new URL('..', import.meta.url).pathname

test('MCP explain and assess accept plans instead of raw SQL', async () => {
  const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'scripts/mcp-server.ts'], cwd: root, stderr: 'pipe' })
  const client = new Client({ name: 'database-agent-schema-test', version: '1.0.0' })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    for (const name of ['database_explain', 'database_assess']) {
      const schema = tools.tools.find((tool) => tool.name === name)?.inputSchema as { properties?: Record<string, unknown> }
      assert.ok(schema.properties?.plan)
      assert.ok(schema.properties?.correlationId)
      assert.equal(schema.properties?.sql, undefined)
    }
    const mutation = tools.tools.find((tool) => tool.name === 'database_mutation_plan')
    const mutationSchema = mutation?.inputSchema as { properties?: Record<string, unknown> }
    assert.ok(mutationSchema.properties?.plan)
    assert.ok(mutationSchema.properties?.execute)
    assert.ok(mutationSchema.properties?.confirmFingerprint)
    assert.ok(mutationSchema.properties?.idempotencyKey)
    assert.equal(mutation?.annotations?.destructiveHint, true)
    const schema = tools.tools.find((tool) => tool.name === 'database_schema_plan')
    const schemaInput = schema?.inputSchema as { properties?: Record<string, unknown> }
    assert.ok(schemaInput.properties?.plan)
    assert.ok(schemaInput.properties?.confirmSchemaState)
    assert.ok(schemaInput.properties?.destructiveConfirmation)
    assert.ok(schemaInput.properties?.backupReference)
    assert.equal(schema?.annotations?.destructiveHint, true)
    assert.ok(tools.tools.some((tool) => tool.name === 'database_permissions'))
    for (const name of ['database_audit_list', 'database_audit_verify', 'database_audit_stats']) {
      assert.equal(tools.tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint, true)
    }
    assert.equal(tools.tools.find((tool) => tool.name === 'database_config_discover')?.annotations?.readOnlyHint, true)
    assert.equal(tools.tools.find((tool) => tool.name === 'database_profile_import')?.annotations?.destructiveHint, true)
  } finally {
    await client.close()
  }
})

test('MCP queries and verifies audit logs without opening a database connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-agent-mcp-audit-'))
  const configPath = join(directory, 'profiles.json')
  const auditPath = join(directory, 'audit.jsonl')
  await writeFile(configPath, JSON.stringify({ profiles: { audit: { dialect: 'mysql', urlEnv: 'INTENTIONALLY_MISSING_DATABASE_URL', auditLog: auditPath } } }))
  await writeAudit({ action: 'discover', profile: 'audit', success: true, correlationId: 'task-42' }, auditPath)
  const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'scripts/mcp-server.ts'], cwd: root, env: { ...process.env, DB_AGENT_CONFIG: configPath }, stderr: 'pipe' })
  const client = new Client({ name: 'database-agent-audit-test', version: '1.0.0' })
  try {
    await client.connect(transport)
    const listed = await client.callTool({ name: 'database_audit_list', arguments: { profile: 'audit', correlationId: 'task-42' } }) as { content: Array<{ text: string }> }
    assert.equal((JSON.parse(listed.content[0].text) as { count: number }).count, 1)
    const verified = await client.callTool({ name: 'database_audit_verify', arguments: { profile: 'audit' } }) as { content: Array<{ text: string }> }
    assert.equal((JSON.parse(verified.content[0].text) as { valid: boolean }).valid, true)
    const stats = await client.callTool({ name: 'database_audit_stats', arguments: { profile: 'audit' } }) as { content: Array<{ text: string }> }
    assert.equal((JSON.parse(stats.content[0].text) as { recordCount: number }).recordCount, 1)
    const failed = await client.callTool({ name: 'database_audit_verify', arguments: { profile: 'missing' } }) as { content: Array<{ text: string }> }
    const error = (JSON.parse(failed.content[0].text) as { error: Record<string, unknown> }).error
    assert.equal(error.code, 'PROFILE_NOT_FOUND')
    assert.equal(error.requiredAction, 'FIX_PROFILE')
    assert.equal(typeof error.correlationId, 'string')
  } finally {
    await client.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('MCP discovers project configuration and imports a profile without opening a database connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-agent-mcp-config-'))
  const configPath = join(directory, 'profiles.json')
  await writeFile(join(directory, '.env'), 'DATABASE_URL=mysql://mcp:mcp-secret@localhost:3306/mcp_demo\n')
  const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'scripts/mcp-server.ts'], cwd: root, env: { ...process.env, DB_AGENT_CONFIG: configPath }, stderr: 'pipe' })
  const client = new Client({ name: 'database-agent-config-test', version: '1.0.0' })
  try {
    await client.connect(transport)
    const discovered = await client.callTool({ name: 'database_config_discover', arguments: { projectPath: directory } }) as { content: Array<{ text: string }> }
    assert.doesNotMatch(discovered.content[0].text, /mcp-secret/)
    const candidates = (JSON.parse(discovered.content[0].text) as { candidates: Array<{ id: string }> }).candidates
    assert.equal(candidates.length, 1)

    const imported = await client.callTool({ name: 'database_profile_import', arguments: { projectPath: directory, candidateId: candidates[0].id, profileName: 'mcp-demo' } }) as { content: Array<{ text: string }> }
    assert.equal((JSON.parse(imported.content[0].text) as { created: boolean }).created, true)
    assert.doesNotMatch(await readFile(configPath, 'utf8'), /mcp-secret/)
  } finally {
    await client.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('MCP server exposes and runs database tools', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-agent-mcp-'))
  const configPath = join(directory, 'profiles.json')
  const table = `mcp_users_${process.pid}`
  const setup = createPool(process.env.TEST_MYSQL_URL as string)
  await setup.query(`create table \`${table}\` (id integer primary key auto_increment, email varchar(255))`)
  await setup.query(`insert into \`${table}\` (email) values ('one@example.test'), ('two@example.test')`)
  await writeFile(configPath, JSON.stringify({ profiles: { local: { dialect: 'mysql', urlEnv: 'TEST_MYSQL_URL', environment: 'development', maxRows: 1 } } }))

  const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'scripts/mcp-server.ts'], cwd: root, env: { ...process.env, DB_AGENT_CONFIG: configPath }, stderr: 'pipe' })
  const client = new Client({ name: 'database-agent-test', version: '1.0.0' })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'database_assess',
      'database_audit_list',
      'database_audit_stats',
      'database_audit_verify',
      'database_config_discover',
      'database_discover',
      'database_explain',
      'database_health',
      'database_indexes',
      'database_mutation_plan',
      'database_permissions',
      'database_profile_import',
      'database_query_plan',
      'database_relations',
      'database_schema_plan',
      'database_stats',
      'database_summary',
    ])
    const response = await client.callTool({ name: 'database_health', arguments: { profile: 'local' } }) as { content: Array<{ text: string }> }
    assert.match(response.content[0].text, /"ok": true/)
    const queryResponse = await client.callTool({ name: 'database_query_plan', arguments: {
      profile: 'local', plan: { table, columns: ['id', 'email'], orderBy: [{ column: 'id' }], limit: 100 },
    } }) as { content: Array<{ text: string }> }
    const firstPage = JSON.parse(queryResponse.content[0].text) as Record<string, unknown>
    assert.equal(typeof firstPage.correlationId, 'string')
    delete firstPage.correlationId
    assert.deepEqual(firstPage, { rows: [{ id: 1, email: '[REDACTED]' }], rowCount: 1, page: { returned: 1, hasMore: true, nextOffset: 1 } })
    const nextPageResponse = await client.callTool({ name: 'database_query_plan', arguments: {
      profile: 'local', plan: { table, columns: ['id', 'email'], orderBy: [{ column: 'id' }], limit: 1, offset: 1 },
    } }) as { content: Array<{ text: string }> }
    const secondPage = JSON.parse(nextPageResponse.content[0].text) as Record<string, unknown>
    assert.equal(typeof secondPage.correlationId, 'string')
    delete secondPage.correlationId
    assert.deepEqual(secondPage, { rows: [{ id: 2, email: '[REDACTED]' }], rowCount: 1, page: { returned: 1, hasMore: false } })
  } finally {
    await client.close()
    await setup.query(`drop table if exists \`${table}\``)
    await setup.end()
    await rm(directory, { recursive: true, force: true })
  }
})
