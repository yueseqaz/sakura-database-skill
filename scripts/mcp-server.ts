#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { defaultAuditPath, writeAudit } from './audit.js'
import { loadConfig, resolveConnection, resolveProfile } from './config.js'
import { maskRows, makeExplainStatement, safeStatement, type SelectPlan, validatePolicy } from './core.js'
import { connect, discover, executeWithTimeout, health, query, queryPlan, withLocalTunnel } from './database.js'
import { openTunnel } from './tunnel.js'

const configPath = process.env.DB_AGENT_CONFIG

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function failure(error: unknown) {
  return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true }
}

async function withProfile<T>(profileName: string, action: string, approvalToken: string | undefined, run: (input: {
  dialect: 'postgres' | 'mysql' | 'sqlite'
  db: ReturnType<typeof connect>
  maxRows?: number
  timeoutMs?: number
  sensitiveColumns?: string[]
}) => Promise<T>): Promise<T> {
  const config = await loadConfig(configPath)
  const resolved = resolveProfile(config, profileName)
  if (!resolved) throw new Error('An MCP request requires a configured profile.')
  validatePolicy(resolved.profile, { action, approvalToken })
  const { dialect, url } = resolveConnection(resolved.profile)
  const tunnel = resolved.profile.sshTunnel ? await openTunnel(resolved.profile.sshTunnel) : undefined
  const db = connect(dialect, withLocalTunnel(url, tunnel?.localPort))
  try {
    const value = await run({ dialect, db, maxRows: resolved.profile.maxRows, timeoutMs: resolved.profile.timeoutMs, sensitiveColumns: resolved.profile.sensitiveColumns })
    await writeAudit({ action, profile: profileName, dialect, success: true }, resolved.profile.auditLog ?? defaultAuditPath())
    return value
  } catch (error) {
    await writeAudit({ action, profile: profileName, dialect, success: false, error: error instanceof Error ? error.message : String(error) }, resolved.profile.auditLog ?? defaultAuditPath())
    throw error
  } finally {
    await db.destroy()
    await tunnel?.close()
  }
}

const server = new McpServer({ name: 'sakura-database-skill', version: '0.2.0' })

server.registerTool('database_health', {
  title: 'Database health check',
  description: 'Check connectivity for a configured database profile.',
  inputSchema: { profile: z.string(), approvalToken: z.string().optional() },
  annotations: { readOnlyHint: true },
}, async ({ profile, approvalToken }) => {
  try {
    return result(await withProfile(profile, 'health', approvalToken, async ({ db, dialect, timeoutMs }) => ({
      ...(await executeWithTimeout(health(db), timeoutMs)), dialect,
    })))
  } catch (error) { return failure(error) }
})

server.registerTool('database_discover', {
  title: 'Discover database schema',
  description: 'List database tables and columns. Optionally filter by table name.',
  inputSchema: { profile: z.string(), table: z.string().optional(), approvalToken: z.string().optional() },
  annotations: { readOnlyHint: true },
}, async ({ profile, table, approvalToken }) => {
  try {
    return result(await withProfile(profile, 'discover', approvalToken, ({ db, timeoutMs }) => executeWithTimeout(discover(db, table), timeoutMs)))
  } catch (error) { return failure(error) }
})

const planSchema = z.object({
  table: z.string(),
  columns: z.array(z.string()).min(1),
  where: z.array(z.object({ column: z.string(), op: z.enum(['=', '!=', '<>', '>', '>=', '<', '<=', 'like', 'in']), value: z.unknown() })).optional(),
  orderBy: z.array(z.object({ column: z.string(), direction: z.enum(['asc', 'desc']).optional() })).optional(),
  limit: z.number().int().positive().optional(),
})

server.registerTool('database_query_plan', {
  title: 'Run a safe database query plan',
  description: 'Execute a parameterized read-only SelectPlan. Results are masked by default.',
  inputSchema: { profile: z.string(), plan: planSchema, includeSensitive: z.boolean().optional(), approvalToken: z.string().optional() },
  annotations: { readOnlyHint: true },
}, async ({ profile, plan, includeSensitive, approvalToken }) => {
  try {
    return result(await withProfile(profile, 'plan', approvalToken, async ({ db, dialect, maxRows, timeoutMs, sensitiveColumns }) => {
      const queryResult = await executeWithTimeout(queryPlan(db, dialect, plan as SelectPlan, { maxRows }), timeoutMs)
      return { rows: includeSensitive ? queryResult.rows : maskRows(queryResult.rows as Array<Record<string, unknown>>, sensitiveColumns), rowCount: queryResult.rows.length }
    }))
  } catch (error) { return failure(error) }
})

server.registerTool('database_explain', {
  title: 'Explain a read-only query',
  description: 'Return the database execution plan for one read-only query.',
  inputSchema: { profile: z.string(), sql: z.string(), approvalToken: z.string().optional() },
  annotations: { readOnlyHint: true },
}, async ({ profile, sql: statement, approvalToken }) => {
  try {
    return result(await withProfile(profile, 'explain', approvalToken, async ({ db, dialect, timeoutMs }) => {
      const queryResult = await executeWithTimeout(query(db, makeExplainStatement(dialect, safeStatement(statement))), timeoutMs)
      return { rows: queryResult.rows, rowCount: queryResult.rows.length }
    }))
  } catch (error) { return failure(error) }
})

await server.connect(new StdioServerTransport())
