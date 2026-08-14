import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPool } from 'mysql2/promise'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

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
      assert.equal(schema.properties?.sql, undefined)
    }
    const mutation = tools.tools.find((tool) => tool.name === 'database_mutation_plan')
    const mutationSchema = mutation?.inputSchema as { properties?: Record<string, unknown> }
    assert.ok(mutationSchema.properties?.plan)
    assert.ok(mutationSchema.properties?.execute)
    assert.ok(mutationSchema.properties?.confirmFingerprint)
    assert.ok(mutationSchema.properties?.idempotencyKey)
    assert.equal(mutation?.annotations?.destructiveHint, true)
  } finally {
    await client.close()
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
      'database_discover',
      'database_explain',
      'database_health',
      'database_indexes',
      'database_mutation_plan',
      'database_query_plan',
      'database_relations',
      'database_stats',
      'database_summary',
    ])
    const response = await client.callTool({ name: 'database_health', arguments: { profile: 'local' } }) as { content: Array<{ text: string }> }
    assert.match(response.content[0].text, /"ok": true/)
    const queryResponse = await client.callTool({ name: 'database_query_plan', arguments: {
      profile: 'local', plan: { table, columns: ['id', 'email'], orderBy: [{ column: 'id' }], limit: 100 },
    } }) as { content: Array<{ text: string }> }
    assert.deepEqual(JSON.parse(queryResponse.content[0].text), { rows: [{ id: 1, email: '[REDACTED]' }], rowCount: 1, page: { returned: 1, hasMore: true, nextOffset: 1 } })
    const nextPageResponse = await client.callTool({ name: 'database_query_plan', arguments: {
      profile: 'local', plan: { table, columns: ['id', 'email'], orderBy: [{ column: 'id' }], limit: 1, offset: 1 },
    } }) as { content: Array<{ text: string }> }
    assert.deepEqual(JSON.parse(nextPageResponse.content[0].text), { rows: [{ id: 2, email: '[REDACTED]' }], rowCount: 1, page: { returned: 1, hasMore: false } })
  } finally {
    await client.close()
    await setup.query(`drop table if exists \`${table}\``)
    await setup.end()
    await rm(directory, { recursive: true, force: true })
  }
})
