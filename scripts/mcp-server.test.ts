import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = new URL('..', import.meta.url).pathname

test('MCP server exposes and runs read-only database tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'database-agent-mcp-'))
  const databasePath = join(directory, 'app.db')
  const configPath = join(directory, 'profiles.json')
  const setup = new Database(databasePath)
  setup.exec("create table users (id integer primary key, email text); insert into users (email) values ('one@example.test'), ('two@example.test')")
  setup.close()
  await writeFile(configPath, JSON.stringify({ profiles: { local: { dialect: 'sqlite', url: `sqlite://${databasePath}`, environment: 'development', maxRows: 1 } } }))

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
      'database_query_plan',
      'database_relations',
      'database_stats',
      'database_summary',
    ])
    const response = await client.callTool({ name: 'database_health', arguments: { profile: 'local' } }) as { content: Array<{ text: string }> }
    assert.match(response.content[0].text, /"ok": true/)
    const queryResponse = await client.callTool({ name: 'database_query_plan', arguments: {
      profile: 'local', plan: { table: 'users', columns: ['id', 'email'], limit: 100 },
    } }) as { content: Array<{ text: string }> }
    assert.deepEqual(JSON.parse(queryResponse.content[0].text), { rows: [{ id: 1, email: '[REDACTED]' }], rowCount: 1, page: { returned: 1, hasMore: true, nextOffset: 1 } })
    const nextPageResponse = await client.callTool({ name: 'database_query_plan', arguments: {
      profile: 'local', plan: { table: 'users', columns: ['id', 'email'], limit: 1, offset: 1 },
    } }) as { content: Array<{ text: string }> }
    assert.deepEqual(JSON.parse(nextPageResponse.content[0].text), { rows: [{ id: 2, email: '[REDACTED]' }], rowCount: 1, page: { returned: 1, hasMore: false } })
  } finally {
    await client.close()
    await rm(directory, { recursive: true, force: true })
  }
})
