#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { defaultAuditPath, writeAudit } from './audit.js'
import { loadConfig, resolveConnection, resolveProfile } from './config.js'
import { maskRows, type Policy, type SelectPlan, validatePlanPolicy, validatePlanSchema, validatePolicy, validateSensitiveAccess } from './core.js'
import { assessExplain, paginatePlan, summarizeSchema, type SchemaTable } from './intelligence.js'
import { connect, discoverPage, discoverTables, executeWithTimeout, explainPlan, health, indexes, queryPlan, relationships, statistics, withLocalTunnel } from './database.js'
import { openTunnel } from './tunnel.js'
import { executeMutation, mutationPlanFingerprint, previewMutation, validateMutationExecution, validateMutationSchema, type MutationPlan } from './mutations.js'
import { DatabaseAgentError, errorPayload } from './errors.js'
import { permissions } from './permissions.js'
import { executeSchemaPlan, previewSchemaPlan, type SchemaPlan } from './schema-changes.js'

const configPath = process.env.DB_AGENT_CONFIG

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function failure(error: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(error), null, 2) }], isError: true }
}

function auditedRowCount(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of ['rowCount', 'affectedRows', 'estimatedRows']) if (typeof record[key] === 'number') return record[key]
  return undefined
}

function auditedFingerprint(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const fingerprint = (value as Record<string, unknown>).planFingerprint
  return typeof fingerprint === 'string' ? fingerprint : undefined
}

function withCorrelationId(value: unknown, correlationId: string): unknown {
  if (Array.isArray(value)) return { correlationId, data: value }
  if (value && typeof value === 'object') return { ...(value as Record<string, unknown>), correlationId }
  return { correlationId, value }
}

async function withProfile<T>(profileName: string, action: string, approvalToken: string | undefined, requestedCorrelationId: string | undefined, run: (input: {
  dialect: 'mysql'
  db: ReturnType<typeof connect>
  maxRows?: number
  timeoutMs?: number
  sensitiveColumns?: string[]
  allowSensitive?: boolean
  policy: Policy
}) => Promise<T>): Promise<unknown> {
  const config = await loadConfig(configPath)
  const resolved = resolveProfile(config, profileName)
  if (!resolved) throw new Error('An MCP request requires a configured profile.')
  validatePolicy(resolved.profile, { action, approvalToken })
  const { dialect, url } = resolveConnection(resolved.profile)
  const tunnel = resolved.profile.sshTunnel ? await openTunnel(resolved.profile.sshTunnel) : undefined
  const db = connect(dialect, withLocalTunnel(url, tunnel?.localPort), resolved.profile.timeoutMs)
  const correlationId = requestedCorrelationId ?? randomUUID()
  const auditPath = resolved.profile.auditLog ?? defaultAuditPath()
  const auditOptions = { maxBytes: resolved.profile.auditMaxBytes, retentionFiles: resolved.profile.auditRetentionFiles }
  let operationSucceeded = false
  try {
    if (action.startsWith('execute:')) {
      try {
        await writeAudit({ action, profile: profileName, dialect, correlationId, phase: 'intent' }, auditPath, auditOptions)
      } catch {
        throw new DatabaseAgentError('AUDIT_WRITE_FAILED', 'Could not write the audit intent; the database operation was not attempted.', { correlationId })
      }
    }
    const value = await run({ dialect, db, maxRows: resolved.profile.maxRows, timeoutMs: resolved.profile.timeoutMs, sensitiveColumns: resolved.profile.sensitiveColumns, allowSensitive: resolved.profile.allowSensitive, policy: resolved.profile })
    operationSucceeded = true
    try {
      await writeAudit({ action, profile: profileName, dialect, success: true, correlationId, phase: 'outcome', rowCount: auditedRowCount(value), fingerprint: auditedFingerprint(value) }, auditPath, auditOptions)
    } catch {
      throw new DatabaseAgentError('AUDIT_OUTCOME_FAILED', 'The database operation succeeded, but its audit outcome could not be written. Check the database state before retrying.', { correlationId, operationStatus: 'succeeded' })
    }
    return withCorrelationId(value, correlationId)
  } catch (error) {
    if (!operationSucceeded) {
      try {
        await writeAudit({ action, profile: profileName, dialect, success: false, correlationId, phase: 'outcome', error: JSON.stringify(errorPayload(error).error) }, auditPath, auditOptions)
      } catch { /* Preserve the database or policy error. */ }
    }
    if (error instanceof DatabaseAgentError && error.details?.correlationId) throw error
    const normalized = errorPayload(error).error
    throw new DatabaseAgentError(normalized.code, normalized.message, { ...normalized.details, correlationId })
  } finally {
    await db.destroy()
    await tunnel?.close()
  }
}

const server = new McpServer({ name: 'sakura-database-skill', version: '0.9.0' })
const requestContextSchema = { profile: z.string(), approvalToken: z.string().optional(), correlationId: z.string().min(1).optional() }

server.registerTool('database_health', {
  title: 'Database health check',
  description: 'Check connectivity for a configured database profile.',
  inputSchema: requestContextSchema,
  annotations: { readOnlyHint: true },
}, async ({ profile, approvalToken, correlationId }) => {
  try {
    return result(await withProfile(profile, 'health', approvalToken, correlationId, async ({ db, dialect, timeoutMs }) => ({
      ...(await executeWithTimeout(health(db), timeoutMs)), dialect,
    })))
  } catch (error) { return failure(error) }
})

server.registerTool('database_discover', {
  title: 'Discover database schema',
  description: 'List database tables and columns. Optionally filter by table name.',
  inputSchema: { ...requestContextSchema, table: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() },
  annotations: { readOnlyHint: true },
}, async ({ profile, table, limit, cursor, approvalToken, correlationId }) => {
  try {
    return result(await withProfile(profile, 'discover', approvalToken, correlationId, ({ db, timeoutMs }) => executeWithTimeout(discoverPage(db, { search: table, limit, cursor }), timeoutMs)))
  } catch (error) { return failure(error) }
})

server.registerTool('database_stats', {
  title: 'Database statistics',
  description: 'Return dialect-appropriate table, row, and storage estimates.',
  inputSchema: requestContextSchema,
  annotations: { readOnlyHint: true },
}, async ({ profile, approvalToken, correlationId }) => {
  try {
    return result(await withProfile(profile, 'stats', approvalToken, correlationId, ({ db, dialect, timeoutMs }) => executeWithTimeout(statistics(db, dialect), timeoutMs)))
  } catch (error) { return failure(error) }
})

server.registerTool('database_indexes', {
  title: 'Inspect table indexes',
  description: 'Return indexes reported by the database for one table.',
  inputSchema: { ...requestContextSchema, table: z.string() },
  annotations: { readOnlyHint: true },
}, async ({ profile, table, approvalToken, correlationId }) => {
  try {
    return result(await withProfile(profile, 'indexes', approvalToken, correlationId, ({ db, dialect, timeoutMs }) => executeWithTimeout(indexes(db, dialect, table), timeoutMs)))
  } catch (error) { return failure(error) }
})

server.registerTool('database_relations', {
  title: 'Inspect foreign-key relationships',
  description: 'Return foreign-key relationships reported by database metadata.',
  inputSchema: { ...requestContextSchema, table: z.string().optional() },
  annotations: { readOnlyHint: true },
}, async ({ profile, table, approvalToken, correlationId }) => {
  try {
    return result(await withProfile(profile, 'relations', approvalToken, correlationId, ({ db, dialect, timeoutMs }) => executeWithTimeout(relationships(db, dialect, table), timeoutMs)))
  } catch (error) { return failure(error) }
})

server.registerTool('database_summary', {
  title: 'Summarize database schema',
  description: 'Return compact table, column, and sensitive-field counts from observed schema metadata.',
  inputSchema: { ...requestContextSchema, table: z.string().optional() },
  annotations: { readOnlyHint: true },
}, async ({ profile, table, approvalToken, correlationId }) => {
  try {
    return result(await withProfile(profile, 'summary', approvalToken, correlationId, async ({ db, timeoutMs }) => {
      const discovered = (await executeWithTimeout(discoverPage(db, { search: table }), timeoutMs)).tables
      const schema = discovered.map((entry) => ({ name: entry.name, columns: entry.columns.map((column) => ({ name: column.name, type: column.type, nullable: column.nullable })) })) as SchemaTable[]
      return summarizeSchema(schema)
    }))
  } catch (error) { return failure(error) }
})

const aggregateSchema = z.enum(['count', 'sum', 'avg', 'min', 'max'])
const fieldSchema = z.union([z.string(), z.object({ aggregate: aggregateSchema, column: z.string().optional() })])
const predicateSchema = z.object({
  column: fieldSchema,
  op: z.enum(['=', '!=', '<>', '>', '>=', '<', '<=', 'like', 'in', 'not in', 'between', 'is null', 'is not null']),
  value: z.unknown().optional(),
})
const filterSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  predicateSchema,
  z.object({ and: z.array(filterSchema).min(1) }),
  z.object({ or: z.array(filterSchema).min(1) }),
]))

const planSchema = z.object({
  table: z.string(),
  as: z.string().optional(),
  columns: z.array(z.union([z.string(), z.object({ column: z.string().optional(), aggregate: aggregateSchema.optional(), as: z.string().optional() })])).min(1),
  joins: z.array(z.object({
    table: z.string(), as: z.string().optional(), type: z.enum(['inner', 'left']).optional(),
    on: z.array(z.object({ left: z.string(), op: z.enum(['=', '!=', '<>', '>', '>=', '<', '<=']), right: z.string() })).min(1),
  })).optional(),
  where: z.union([z.array(predicateSchema), filterSchema]).optional(),
  groupBy: z.array(z.string()).optional(),
  having: filterSchema.optional(),
  orderBy: z.array(z.object({ column: z.string(), direction: z.enum(['asc', 'desc']).optional() })).optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
})

const mutationValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()])
const mutationRowSchema = z.record(z.string(), mutationValueSchema)
const mutationPredicateSchema = z.object({
  column: z.string(),
  op: z.enum(['=', '!=', '<>', '>', '>=', '<', '<=', 'like', 'in', 'not in', 'between', 'is null', 'is not null']),
  value: z.unknown().optional(),
})
const mutationFilterSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  mutationPredicateSchema,
  z.object({ and: z.array(mutationFilterSchema).min(1) }),
  z.object({ or: z.array(mutationFilterSchema).min(1) }),
]))
const mutationWhereSchema = z.union([z.array(mutationPredicateSchema).min(1), mutationFilterSchema])
const optimisticLockSchema = z.object({ column: z.string(), value: mutationValueSchema })
const mutationPlanSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('insert'), table: z.string(), rows: z.array(mutationRowSchema).min(1) }),
  z.object({ operation: z.literal('update'), table: z.string(), set: mutationRowSchema, where: mutationWhereSchema, optimisticLock: optimisticLockSchema.optional() }),
  z.object({ operation: z.literal('delete'), table: z.string(), where: mutationWhereSchema, optimisticLock: optimisticLockSchema.optional() }),
])

const columnTypeSchema = z.enum(['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'decimal', 'float', 'double', 'boolean', 'char', 'varchar', 'text', 'mediumtext', 'longtext', 'binary', 'varbinary', 'blob', 'mediumblob', 'longblob', 'date', 'time', 'datetime', 'timestamp', 'year', 'json', 'enum'])
const columnDefinitionSchema = z.object({
  name: z.string(), type: columnTypeSchema, length: z.number().int().positive().optional(), precision: z.number().int().positive().optional(),
  scale: z.number().int().nonnegative().optional(), unsigned: z.boolean().optional(), nullable: z.boolean().optional(), autoIncrement: z.boolean().optional(),
  default: mutationValueSchema.or(z.literal('CURRENT_TIMESTAMP')).optional(), onUpdateCurrentTimestamp: z.boolean().optional(),
  enumValues: z.array(z.string()).min(1).optional(), comment: z.string().optional(),
})
const indexDefinitionSchema = z.object({ name: z.string(), columns: z.array(z.string()).min(1), unique: z.boolean().optional() })
const foreignKeyDefinitionSchema = z.object({
  name: z.string(), columns: z.array(z.string()).min(1), referencedTable: z.string(), referencedColumns: z.array(z.string()).min(1),
  onDelete: z.enum(['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION']).optional(), onUpdate: z.enum(['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION']).optional(),
})
const alterChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('addColumn'), column: columnDefinitionSchema, after: z.string().optional(), first: z.boolean().optional() }),
  z.object({ action: z.literal('modifyColumn'), column: columnDefinitionSchema }),
  z.object({ action: z.literal('renameColumn'), from: z.string(), to: z.string() }),
  z.object({ action: z.literal('dropColumn'), column: z.string() }),
  z.object({ action: z.literal('addIndex'), index: indexDefinitionSchema }),
  z.object({ action: z.literal('dropIndex'), index: z.string() }),
  z.object({ action: z.literal('addForeignKey'), foreignKey: foreignKeyDefinitionSchema }),
  z.object({ action: z.literal('dropForeignKey'), foreignKey: z.string() }),
])
const schemaPlanSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('createDatabase'), database: z.string(), charset: z.string().optional(), collation: z.string().optional() }),
  z.object({ operation: z.literal('dropDatabase'), database: z.string() }),
  z.object({ operation: z.literal('createTable'), table: z.string(), columns: z.array(columnDefinitionSchema).min(1), primaryKey: z.array(z.string()).optional(), indexes: z.array(indexDefinitionSchema).optional(), foreignKeys: z.array(foreignKeyDefinitionSchema).optional(), engine: z.literal('InnoDB').optional() }),
  z.object({ operation: z.literal('alterTable'), table: z.string(), changes: z.array(alterChangeSchema).min(1) }),
  z.object({ operation: z.literal('renameTable'), table: z.string(), newTable: z.string() }),
  z.object({ operation: z.literal('dropTable'), table: z.string() }),
])

server.registerTool('database_permissions', {
  title: 'Inspect database permissions',
  description: 'Report the connected MySQL account privileges and derived query, data-write, and schema-change capabilities.',
  inputSchema: requestContextSchema,
  annotations: { readOnlyHint: true },
}, async ({ profile, approvalToken, correlationId }) => {
  try {
    return result(await withProfile(profile, 'permissions', approvalToken, correlationId, ({ db, timeoutMs }) => executeWithTimeout(permissions(db), timeoutMs)))
  } catch (error) { return failure(error) }
})

server.registerTool('database_schema_plan', {
  title: 'Preview or execute a controlled schema change',
  description: 'Preview a structured database/table DDL plan with permissions, dependencies, risk, recovery metadata, and state fingerprint. Execution requires exact approval confirmations.',
  inputSchema: {
    ...requestContextSchema, plan: schemaPlanSchema, execute: z.boolean().optional(),
    confirmFingerprint: z.string().optional(), confirmSchemaState: z.string().optional(), destructiveConfirmation: z.string().optional(), backupReference: z.string().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
}, async ({ profile, plan, execute, approvalToken, correlationId, confirmFingerprint, confirmSchemaState, destructiveConfirmation, backupReference }) => {
  try {
    return result(await withProfile(profile, `${execute ? 'execute' : 'preview'}:schema:${plan.operation}`, approvalToken, correlationId, async ({ db, timeoutMs, policy }) => {
      if (execute === true) return executeSchemaPlan(db, plan as SchemaPlan, policy, {
        approvalToken, confirmFingerprint, confirmSchemaState, destructiveConfirmation, backupReference, profileName: profile,
      })
      return { mode: 'preview', ...(await executeWithTimeout(previewSchemaPlan(db, plan as SchemaPlan, policy, profile), timeoutMs)) }
    }))
  } catch (error) { return failure(error) }
})

server.registerTool('database_query_plan', {
  title: 'Run a safe database query plan',
  description: 'Execute a parameterized read-only SelectPlan. Results are masked by default.',
  inputSchema: { ...requestContextSchema, plan: planSchema, includeSensitive: z.boolean().optional() },
  annotations: { readOnlyHint: true },
}, async ({ profile, plan, includeSensitive, approvalToken, correlationId }) => {
  try {
    return result(await withProfile(profile, 'plan', approvalToken, correlationId, async ({ db, dialect, maxRows, timeoutMs, sensitiveColumns, allowSensitive, policy }) => {
      validateSensitiveAccess({ allowSensitive }, includeSensitive === true)
      validatePlanSchema(plan as SelectPlan, await executeWithTimeout(discoverTables(db, [plan.table, ...(plan.joins ?? []).map((join) => join.table)]), timeoutMs))
      validatePlanPolicy(plan as SelectPlan, policy)
      const pageSize = Math.max(1, Math.min(plan.limit ?? maxRows ?? 100, maxRows ?? 100))
      const queryResult = await executeWithTimeout(queryPlan(db, dialect, { ...plan, limit: pageSize } as SelectPlan, { maxRows, fetchExtra: true }), timeoutMs)
      const page = paginatePlan({ ...plan, limit: pageSize } as SelectPlan, queryResult.rows.length)
      const rows = queryResult.rows.slice(0, page.returned)
      return { rows: includeSensitive ? rows : maskRows(rows as Array<Record<string, unknown>>, sensitiveColumns), rowCount: rows.length, page }
    }))
  } catch (error) { return failure(error) }
})

server.registerTool('database_mutation_plan', {
  title: 'Preview or execute a safe mutation plan',
  description: 'Preview a structured InsertPlan, UpdatePlan, or DeletePlan by default. Execution requires profile write permission and an approval token.',
  inputSchema: { ...requestContextSchema, plan: mutationPlanSchema, execute: z.boolean().optional(), confirmFingerprint: z.string().optional(), idempotencyKey: z.string().optional() },
  annotations: { readOnlyHint: false, destructiveHint: true },
}, async ({ profile, plan, execute, approvalToken, correlationId, confirmFingerprint, idempotencyKey }) => {
  try {
    return result(await withProfile(profile, `${execute ? 'execute' : 'preview'}:${plan.operation}:${plan.table}`, approvalToken, correlationId, async ({ db, timeoutMs, policy }) => {
      validateMutationExecution(policy, execute === true, approvalToken, confirmFingerprint, mutationPlanFingerprint(profile, plan as MutationPlan, policy))
      validateMutationSchema(plan as MutationPlan, await executeWithTimeout(discoverTables(db, [plan.table]), timeoutMs))
      if (execute === true) {
        const mutation = await executeWithTimeout(executeMutation(db, plan as MutationPlan, policy, {
          approvalToken, confirmFingerprint, profileName: profile, idempotencyKey,
        }), timeoutMs)
        return { mode: 'executed', ...mutation }
      }
      return { mode: 'preview', ...(await executeWithTimeout(previewMutation(db, plan as MutationPlan, policy, profile), timeoutMs)) }
    }))
  } catch (error) { return failure(error) }
})

server.registerTool('database_explain', {
  title: 'Explain a query plan',
  description: 'Return the MySQL execution plan for one validated SelectPlan.',
  inputSchema: { ...requestContextSchema, plan: planSchema },
  annotations: { readOnlyHint: true },
}, async ({ profile, plan, approvalToken, correlationId }) => {
  try {
    return result(await withProfile(profile, 'explain', approvalToken, correlationId, async ({ db, timeoutMs, policy }) => {
      validatePlanSchema(plan as SelectPlan, await executeWithTimeout(discoverTables(db, [plan.table, ...(plan.joins ?? []).map((join) => join.table)]), timeoutMs))
      validatePlanPolicy(plan as SelectPlan, policy)
      const queryResult = await executeWithTimeout(explainPlan(db, plan as SelectPlan, policy), timeoutMs)
      return { rows: queryResult.rows, rowCount: queryResult.rows.length }
    }))
  } catch (error) { return failure(error) }
})

server.registerTool('database_assess', {
  title: 'Assess query plan cost',
  description: 'Explain a validated SelectPlan and return a low, medium, or high risk assessment.',
  inputSchema: { ...requestContextSchema, plan: planSchema },
  annotations: { readOnlyHint: true },
}, async ({ profile, plan, approvalToken, correlationId }) => {
  try {
    return result(await withProfile(profile, 'assess', approvalToken, correlationId, async ({ db, dialect, timeoutMs, policy }) => {
      validatePlanSchema(plan as SelectPlan, await executeWithTimeout(discoverTables(db, [plan.table, ...(plan.joins ?? []).map((join) => join.table)]), timeoutMs))
      validatePlanPolicy(plan as SelectPlan, policy)
      const queryResult = await executeWithTimeout(explainPlan(db, plan as SelectPlan, policy), timeoutMs)
      return { assessment: assessExplain(dialect, queryResult.rows, policy.maxEstimatedRows), plan: queryResult.rows }
    }))
  } catch (error) { return failure(error) }
})

await server.connect(new StdioServerTransport())
