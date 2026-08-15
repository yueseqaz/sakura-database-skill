#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compileSelectPlan, maskRows, type SelectPlan, validatePlanPolicy, validatePlanSchema, validatePolicy, validateSensitiveAccess } from './core.js'
import { auditStats, defaultAuditPath, fingerprintStatement, listAudit, rotateAudit, verifyAudit, writeAudit } from './audit.js'
import { defaultConfigPath, loadConfig, resolveConnection, resolveProfile, writeExampleConfig, type Profile } from './config.js'
import { connect, discoverPage, discoverTables, executeWithTimeout, explainPlan, health, indexes, queryPlan, relationships, statistics, withLocalTunnel } from './database.js'
import { openTunnel } from './tunnel.js'
import { assessExplain, paginatePlan, summarizeSchema, type SchemaTable } from './intelligence.js'
import { doctor } from './doctor.js'
import { compileMutationPlan, executeMutation, mutationPlanFingerprint, previewMutation, validateMutationExecution, validateMutationSchema, type MutationPlan } from './mutations.js'
import { DatabaseAgentError, errorPayload } from './errors.js'
import { permissions } from './permissions.js'
import { compileSchemaPlan, executeSchemaPlan, previewSchemaPlan, type SchemaPlan } from './schema-changes.js'

type Command = 'discover' | 'summary' | 'assess' | 'plan' | 'mutate' | 'schema' | 'permissions' | 'explain' | 'health' | 'stats' | 'indexes' | 'relations' | 'profile' | 'config' | 'doctor' | 'audit'
type OutputFormat = 'json' | 'table' | 'csv'

interface Args {
  command?: Command
  values: Record<string, string | boolean>
  positionals: string[]
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const [command, ...tokens] = argv
  const values: Record<string, string | boolean> = {}
  const positionals: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const key = token.slice(2)
    const next = tokens[index + 1]
    if (next && !next.startsWith('--')) {
      values[key] = next
      index += 1
    } else {
      values[key] = true
    }
  }
  const help = command === '--help' || command === '-h' || values.help === true
  if (command && !['discover', 'summary', 'assess', 'plan', 'mutate', 'schema', 'permissions', 'explain', 'health', 'stats', 'indexes', 'relations', 'profile', 'config', 'doctor', 'audit', '--help', '-h'].includes(command)) {
    throw new Error(`Unknown command: ${command}`)
  }
  return { command: command as Command | undefined, values, positionals, help }
}

function usage(): void {
  console.log(`Usage: db-agent <command> [options]

Database commands:
  health                         Check connectivity.
  stats                          Summarize tables and estimated storage.
  discover [--table name]        Discover paginated tables and columns (--limit/--cursor).
  summary [--table name]         Summarize table and sensitive-column counts.
  plan --file <plan.json>        Run a parameterized SelectPlan.
  explain --file <plan.json>     Inspect a SelectPlan execution plan.
  assess --file <plan.json>      Explain and rate a SelectPlan's cost.
  mutate --file <plan.json>      Preview an Insert/Update/Delete MutationPlan.
  schema --file <plan.json>      Preview a structured database or table schema change.
  indexes --table name            List table indexes.
  relations [--table name]       List foreign-key relationships.
  permissions                    Report effective MySQL capabilities.

Configuration:
  doctor [--profile name]        Check runtime and configuration readiness.
  config init [--config path]    Create an example profile configuration.
  profile list|show <name>        Inspect configured profiles.

Auditing:
  audit list                     Query retained audit events.
  audit stats                    Show retained files, records, and disk usage.
  audit verify                   Verify hash-chain and rotation continuity.
  audit rotate                   Rotate the current log immediately.

Mutation execution: mutate --file <plan.json> --profile name --execute --approve token --confirm fingerprint [--idempotency-key key]
Schema execution: schema --file <plan.json> --profile name --execute --approve token --confirm fingerprint --confirm-state fingerprint [--confirm-destructive phrase --backup-reference id]
Common options: --profile name --config path --approve token --correlation-id id --format json|table|csv
Environment: DATABASE_URL=mysql://user:password@host:3306/database`)
}

function stringValue(values: Args['values'], name: string): string | undefined {
  const value = values[name]
  return typeof value === 'string' ? value : undefined
}

function output(value: unknown, format: OutputFormat = 'json'): void {
  const rows = Array.isArray(value)
    ? value as Array<Record<string, unknown>>
    : value && typeof value === 'object' && Array.isArray((value as { rows?: unknown }).rows)
      ? (value as { rows: Array<Record<string, unknown>> }).rows
      : undefined
  if (format === 'table' && rows) {
    console.table(rows)
    return
  }
  if (format === 'csv' && rows) {
    const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))]
    const escape = (item: unknown) => `"${String(item ?? '').replaceAll('"', '""')}"`
    console.log([headers, ...rows.map((row) => headers.map((header) => row[header]))].map((row) => row.map(escape).join(',')).join('\n'))
    return
  }
  console.log(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2))
}

function withCorrelationId(value: unknown, correlationId: string): unknown {
  if (Array.isArray(value)) return { correlationId, data: value }
  if (value && typeof value === 'object') return { ...(value as Record<string, unknown>), correlationId }
  return { correlationId, value }
}

function schemaTables(entries: Awaited<ReturnType<typeof discoverTables>>): SchemaTable[] {
  return entries.map((table) => ({ name: table.name, columns: table.columns.map((column) => ({ name: column.name, type: column.type, nullable: column.nullable })) }))
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.command) return usage()
  const configPath = stringValue(args.values, 'config') ?? defaultConfigPath()

  if (args.command === 'doctor') return output(await doctor(configPath, stringValue(args.values, 'profile')))

  if (args.command === 'config') {
    if (args.positionals[0] === 'init') {
      await writeExampleConfig(configPath)
      return output({ created: configPath })
    }
    throw new Error('Use: db-agent config init [--config path]')
  }

  const config = await loadConfig(configPath)
  if (args.command === 'profile') {
    if (args.positionals[0] === 'list') return output(Object.keys(config.profiles))
    if (args.positionals[0] === 'show') {
      const name = args.positionals[1] ?? stringValue(args.values, 'name')
      if (!name) throw new Error('Use: db-agent profile show --name <name>')
      const profile = resolveProfile(config, name)
      return output({ name: profile?.name, profile: { ...profile?.profile, url: undefined } })
    }
    throw new Error('Use: db-agent profile list | profile show --name <name>')
  }

  if (args.command === 'audit') {
    const resolved = resolveProfile(config, stringValue(args.values, 'profile'))
    const path = stringValue(args.values, 'audit-log') ?? resolved?.profile.auditLog ?? defaultAuditPath()
    const subcommand = args.positionals[0]
    if (subcommand === 'list') {
      const successValue = args.values.success
      if (typeof successValue === 'string' && !['true', 'false'].includes(successValue)) throw new Error('--success must be true or false.')
      const records = await listAudit(path, {
        profile: resolved?.name,
        correlationId: stringValue(args.values, 'correlation-id'),
        action: stringValue(args.values, 'action'),
        success: successValue === true ? true : typeof successValue === 'string' ? successValue === 'true' : undefined,
        since: stringValue(args.values, 'since'),
        until: stringValue(args.values, 'until'),
        limit: Number(stringValue(args.values, 'limit') ?? 100),
      })
      return output({ records, count: records.length })
    }
    if (subcommand === 'stats') return output(await auditStats(path))
    if (subcommand === 'verify') {
      const verification = await verifyAudit(path)
      output(verification)
      if (!verification.valid) process.exitCode = 1
      return
    }
    if (subcommand === 'rotate') return output({ rotated: await rotateAudit(path, { retentionFiles: resolved?.profile.auditRetentionFiles }), path })
    throw new Error('Use: db-agent audit list|stats|verify|rotate [--profile name | --audit-log path]')
  }

  const resolvedProfile = resolveProfile(config, stringValue(args.values, 'profile'))
  const profile: Profile = resolvedProfile?.profile ?? { dialect: 'mysql' }

  const { dialect, url } = resolveConnection(resolvedProfile?.profile)
  validatePolicy(profile, { action: args.command, approvalToken: stringValue(args.values, 'approve') })

  const tunnel = profile.sshTunnel ? await openTunnel(profile.sshTunnel) : undefined
  const db = connect(dialect, withLocalTunnel(url, tunnel?.localPort), profile.timeoutMs)
  const format = (stringValue(args.values, 'format') ?? 'json') as OutputFormat
  const auditPath = profile.auditLog ?? stringValue(args.values, 'audit-log') ?? defaultAuditPath()
  const auditOptions = { maxBytes: profile.auditMaxBytes, retentionFiles: profile.auditRetentionFiles }
  const correlationId = stringValue(args.values, 'correlation-id') ?? randomUUID()
  let action: string = args.command
  let rowCount: number | undefined
  let fingerprint: string | undefined
  const startedAt = Date.now()
  let operationSucceeded = false
  try {
    let result: unknown
    if (args.command === 'health') result = { ...(await executeWithTimeout(health(db), profile.timeoutMs)), dialect }
    else if (args.command === 'stats') result = await executeWithTimeout(statistics(db, dialect), profile.timeoutMs)
    else if (args.command === 'discover') result = await executeWithTimeout(discoverPage(db, {
      search: stringValue(args.values, 'table'), cursor: stringValue(args.values, 'cursor'),
      limit: Number(stringValue(args.values, 'limit') ?? 50),
    }), profile.timeoutMs)
    else if (args.command === 'summary') {
      const page = await executeWithTimeout(discoverPage(db, { search: stringValue(args.values, 'table'), limit: Number(stringValue(args.values, 'limit') ?? 50) }), profile.timeoutMs)
      const tables = schemaTables(page.tables)
      result = summarizeSchema(tables)
    } else if (args.command === 'indexes') {
      const table = stringValue(args.values, 'table')
      if (!table) throw new Error('indexes requires --table.')
      result = await executeWithTimeout(indexes(db, dialect, table), profile.timeoutMs)
    } else if (args.command === 'relations') result = await executeWithTimeout(relationships(db, dialect, stringValue(args.values, 'table')), profile.timeoutMs)
    else if (args.command === 'permissions') result = await executeWithTimeout(permissions(db), profile.timeoutMs)
    else if (args.command === 'schema') {
      const file = stringValue(args.values, 'file')
      if (!file) throw new Error('schema requires --file <plan.json>.')
      const plan = JSON.parse(await readFile(file, 'utf8')) as SchemaPlan
      const execute = args.values.execute === true
      const approvalToken = stringValue(args.values, 'approve')
      const profileName = resolvedProfile?.name ?? 'environment'
      const compiled = compileSchemaPlan(plan, profile)
      fingerprint = fingerprintStatement(compiled.sql)
      action = `${execute ? 'execute' : 'preview'}:schema:${plan.operation}:${compiled.target}`
      if (execute) {
        try {
          await writeAudit({ action, profile: resolvedProfile?.name, dialect, correlationId, phase: 'intent', fingerprint }, auditPath, auditOptions)
        } catch {
          throw new DatabaseAgentError('AUDIT_WRITE_FAILED', 'Could not write the audit intent; the database operation was not attempted.', { correlationId })
        }
        result = await executeSchemaPlan(db, plan, profile, {
          approvalToken,
          profileName,
          confirmFingerprint: stringValue(args.values, 'confirm'),
          confirmSchemaState: stringValue(args.values, 'confirm-state'),
          destructiveConfirmation: stringValue(args.values, 'confirm-destructive'),
          backupReference: stringValue(args.values, 'backup-reference'),
        })
      } else {
        result = { mode: 'preview', ...(await executeWithTimeout(previewSchemaPlan(db, plan, profile, profileName), profile.timeoutMs)) }
      }
    }
    else if (args.command === 'mutate') {
      const file = stringValue(args.values, 'file')
      if (!file) throw new Error('mutate requires --file <plan.json>.')
      const plan = JSON.parse(await readFile(file, 'utf8')) as MutationPlan
      const execute = args.values.execute === true
      const approvalToken = stringValue(args.values, 'approve')
      const profileName = resolvedProfile?.name ?? 'environment'
      const confirmFingerprint = stringValue(args.values, 'confirm')
      const idempotencyKey = stringValue(args.values, 'idempotency-key')
      validateMutationExecution(profile, execute, approvalToken, confirmFingerprint, mutationPlanFingerprint(profileName, plan, profile))
      validateMutationSchema(plan, await executeWithTimeout(discoverTables(db, [plan.table]), profile.timeoutMs))
      const compiled = compileMutationPlan(plan, profile)
      fingerprint = fingerprintStatement(compiled.sql)
      action = `${execute ? 'execute' : 'preview'}:${plan.operation}:${plan.table}`
      if (execute) {
        try {
          await writeAudit({ action, profile: resolvedProfile?.name, dialect, correlationId, phase: 'intent', fingerprint }, auditPath, auditOptions)
        } catch {
          throw new DatabaseAgentError('AUDIT_WRITE_FAILED', 'Could not write the audit intent; the database operation was not attempted.', { correlationId })
        }
        const mutation = await executeWithTimeout(executeMutation(db, plan, profile, {
          approvalToken, confirmFingerprint, profileName, idempotencyKey,
        }), profile.timeoutMs)
        rowCount = mutation.affectedRows
        result = { mode: 'executed', ...mutation }
      } else {
        const preview = await executeWithTimeout(previewMutation(db, plan, profile, profileName), profile.timeoutMs)
        rowCount = preview.estimatedRows
        result = { mode: 'preview', ...preview }
      }
    }
    else {
      const file = stringValue(args.values, 'file')
      if (!file) throw new Error(`${args.command} requires --file <plan.json>.`)
      const plan = JSON.parse(await readFile(file, 'utf8')) as SelectPlan
      const compiledPlan = compileSelectPlan(plan, profile, dialect)
      validatePlanSchema(plan, await executeWithTimeout(discoverTables(db, [plan.table, ...(plan.joins ?? []).map((join) => join.table)]), profile.timeoutMs))
      validatePlanPolicy(plan, profile)
      fingerprint = fingerprintStatement(compiledPlan.sql)
      action = `${args.command}:${plan.table}`
      if (args.command === 'plan') {
        validateSensitiveAccess(profile, args.values['include-sensitive'] === true)
        const pageSize = Math.max(1, Math.min(plan.limit ?? profile.maxRows ?? 100, profile.maxRows ?? 100))
        const queryResult = await executeWithTimeout(queryPlan(db, dialect, { ...plan, limit: pageSize }, { ...profile, fetchExtra: true }), profile.timeoutMs)
        const pagination = paginatePlan({ ...plan, limit: pageSize }, queryResult.rows.length)
        const pageRows = queryResult.rows.slice(0, pagination.returned)
        rowCount = pageRows.length
        const rows = args.values['include-sensitive'] === true ? pageRows : maskRows(pageRows as Array<Record<string, unknown>>, profile.sensitiveColumns)
        result = { rows, rowCount, page: pagination }
      } else {
        const explained = await executeWithTimeout(explainPlan(db, plan, profile), profile.timeoutMs)
        rowCount = explained.rows.length
        result = args.command === 'assess'
          ? { assessment: assessExplain(dialect, explained.rows, profile.maxEstimatedRows), plan: explained.rows }
          : { rows: explained.rows, rowCount }
      }
    }
    operationSucceeded = true
    try {
      await writeAudit({ action, profile: resolvedProfile?.name, dialect, success: true, correlationId, phase: 'outcome', rowCount, fingerprint, durationMs: Date.now() - startedAt }, auditPath, auditOptions)
    } catch {
      throw new DatabaseAgentError('AUDIT_OUTCOME_FAILED', 'The database operation succeeded, but its audit outcome could not be written. Check the database state before retrying.', { correlationId, operationStatus: 'succeeded' })
    }
    output(withCorrelationId(result, correlationId), format)
  } catch (error) {
    if (!operationSucceeded) {
      try {
        await writeAudit({ action, profile: resolvedProfile?.name, dialect, success: false, correlationId, phase: 'outcome', error: JSON.stringify(errorPayload(error).error), fingerprint, durationMs: Date.now() - startedAt }, auditPath, auditOptions)
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

function isMainModule(): boolean {
  if (!process.argv[1]) return false
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (isMainModule()) {
  run().catch((error: unknown) => {
    console.error(JSON.stringify(errorPayload(error)))
    process.exitCode = 1
  })
}
