#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { compileSelectPlan, makeExplainStatement, maskRows, safeStatement, type SelectPlan, validatePolicy } from './core.js'
import { defaultAuditPath, writeAudit } from './audit.js'
import { defaultConfigPath, loadConfig, resolveConnection, resolveProfile, writeExampleConfig, type Profile } from './config.js'
import { connect, discover, executeWithTimeout, health, indexes, query, queryPlan, relationships, statistics, withLocalTunnel } from './database.js'
import { openTunnel } from './tunnel.js'
import { assessExplain, paginatePlan, summarizeSchema, type SchemaTable } from './intelligence.js'

type Command = 'discover' | 'summary' | 'assess' | 'query' | 'plan' | 'explain' | 'health' | 'stats' | 'indexes' | 'relations' | 'profile' | 'config'
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
  if (command && !['discover', 'summary', 'assess', 'query', 'plan', 'explain', 'health', 'stats', 'indexes', 'relations', 'profile', 'config', '--help', '-h'].includes(command)) {
    throw new Error(`Unknown command: ${command}`)
  }
  return { command: command as Command | undefined, values, positionals, help }
}

function usage(): void {
  console.log(`Usage: db-agent <command> [options]

Read-only commands:
  health                         Check connectivity.
  stats                          Summarize tables and estimated storage.
  discover [--table name]        Discover tables and columns.
  summary [--table name]         Summarize table and sensitive-column counts.
  assess --sql <statement>       Explain and rate read-query cost.
  query --sql <statement>        Run one limited read-only statement.
  plan --file <plan.json>        Run a parameterized SelectPlan.
  explain --sql <statement>      Inspect a read-only query plan.
  indexes --table name            List table indexes.
  relations [--table name]       List foreign-key relationships.

Configuration:
  config init [--config path]    Create an example profile configuration.
  profile list|show <name>        Inspect configured profiles.

Common options: --profile name --config path --approve token --format json|table|csv
Environment: DB_DIALECT=postgres|mysql|sqlite DATABASE_URL=<connection URL>`)
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

function schemaTables(entries: Awaited<ReturnType<typeof discover>>): SchemaTable[] {
  return entries.map((table) => ({ name: table.name, columns: table.columns.map((column) => ({ name: column.name, type: column.type, nullable: column.nullable })) }))
}

function assertRawQueryIsBounded(statement: string): void {
  if (/\b(count|sum|avg|min|max)\s*\(/i.test(statement)) return
  if (!/\blimit\s+\d+/i.test(statement)) throw new Error('Raw queries must include LIMIT. Use a SelectPlan to receive an automatic cap.')
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.command) return usage()
  const configPath = stringValue(args.values, 'config') ?? defaultConfigPath()

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

  const resolvedProfile = resolveProfile(config, stringValue(args.values, 'profile'))
  const profile: Profile = resolvedProfile?.profile ?? { dialect: process.env.DB_DIALECT as Profile['dialect'] }

  const { dialect, url } = resolveConnection(resolvedProfile?.profile)
  validatePolicy(profile, { action: args.command, approvalToken: stringValue(args.values, 'approve') })

  const tunnel = profile.sshTunnel ? await openTunnel(profile.sshTunnel) : undefined
  const db = connect(dialect, withLocalTunnel(url, tunnel?.localPort))
  const format = (stringValue(args.values, 'format') ?? 'json') as OutputFormat
  const auditPath = profile.auditLog ?? stringValue(args.values, 'audit-log') ?? defaultAuditPath()
  let action: string = args.command
  let rowCount: number | undefined
  try {
    let result: unknown
    if (args.command === 'health') result = { ...(await executeWithTimeout(health(db), profile.timeoutMs)), dialect }
    else if (args.command === 'stats') result = await executeWithTimeout(statistics(db, dialect), profile.timeoutMs)
    else if (args.command === 'discover') result = await executeWithTimeout(discover(db, stringValue(args.values, 'table')), profile.timeoutMs)
    else if (args.command === 'summary') {
      const tables = schemaTables(await executeWithTimeout(discover(db, stringValue(args.values, 'table')), profile.timeoutMs))
      result = summarizeSchema(tables)
    } else if (args.command === 'assess') {
      const source = stringValue(args.values, 'sql')
      if (!source) throw new Error('assess requires --sql.')
      const plan = await executeWithTimeout(query(db, makeExplainStatement(dialect, source)), profile.timeoutMs)
      result = { assessment: assessExplain(dialect, plan.rows as Array<Record<string, unknown>>), plan: plan.rows }
    }
    else if (args.command === 'indexes') {
      const table = stringValue(args.values, 'table')
      if (!table) throw new Error('indexes requires --table.')
      result = await executeWithTimeout(indexes(db, dialect, table), profile.timeoutMs)
    } else if (args.command === 'relations') result = await executeWithTimeout(relationships(db, dialect, stringValue(args.values, 'table')), profile.timeoutMs)
    else {
      let statement: string
      let parameters: unknown[] = []
      if (args.command === 'plan') {
        const file = stringValue(args.values, 'file')
        if (!file) throw new Error('plan requires --file <plan.json>.')
        const plan = JSON.parse(await readFile(file, 'utf8')) as SelectPlan
        compileSelectPlan(plan, profile, dialect)
        action = `plan:${plan.table}`
        const pageSize = Math.max(1, Math.min(plan.limit ?? profile.maxRows ?? 100, profile.maxRows ?? 100))
        const queryResult = await executeWithTimeout(queryPlan(db, dialect, { ...plan, limit: pageSize }, { ...profile, fetchExtra: true }), profile.timeoutMs)
        const pagination = paginatePlan({ ...plan, limit: pageSize }, queryResult.rows.length)
        const pageRows = queryResult.rows.slice(0, pagination.returned)
        rowCount = pageRows.length
        const rows = args.values['include-sensitive'] === true ? pageRows : maskRows(pageRows as Array<Record<string, unknown>>, profile.sensitiveColumns)
        result = { rows, rowCount, page: pagination }
        await writeAudit({ action, profile: resolvedProfile?.name, dialect, success: true, rowCount }, auditPath)
        output(result, format)
        return
      } else {
        const source = stringValue(args.values, 'sql')
        if (!source) throw new Error(`${args.command} requires --sql.`)
        statement = safeStatement(source)
        if (args.command === 'query') assertRawQueryIsBounded(statement)
        if (args.command === 'query' && args.values.check === true) {
          const explainResult = await executeWithTimeout(query(db, makeExplainStatement(dialect, statement)), profile.timeoutMs)
          const assessment = assessExplain(dialect, explainResult.rows as Array<Record<string, unknown>>)
          if (assessment.requiresApproval && args.values['allow-scan'] !== true) {
            throw new Error(`Query blocked: ${assessment.reasons.join(', ')}. Re-run with --allow-scan after review.`)
          }
        }
        if (args.command === 'explain' && !/^explain\b/i.test(statement)) statement = dialect === 'sqlite' ? `EXPLAIN QUERY PLAN ${statement}` : `EXPLAIN ${statement}`
      }
      const queryResult = await executeWithTimeout(query(db, statement), profile.timeoutMs)
      rowCount = queryResult.rows.length
      const rows = args.values['include-sensitive'] === true ? queryResult.rows : maskRows(queryResult.rows as Array<Record<string, unknown>>, profile.sensitiveColumns)
      result = { rows, rowCount }
    }
    await writeAudit({ action, profile: resolvedProfile?.name, dialect, success: true, rowCount }, auditPath)
    output(result, format)
  } catch (error) {
    await writeAudit({ action, profile: resolvedProfile?.name, dialect, success: false, error: error instanceof Error ? error.message : String(error) }, auditPath)
    throw error
  } finally {
    await db.destroy()
    await tunnel?.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
