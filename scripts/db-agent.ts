#!/usr/bin/env node
import Database from 'better-sqlite3'
import { Kysely, MysqlDialect, PostgresDialect, SqliteDialect, sql } from 'kysely'
import { createPool } from 'mysql2'
import { Pool } from 'pg'

type DialectName = 'postgres' | 'mysql' | 'sqlite'
type Command = 'discover' | 'query' | 'explain' | 'health'

export function ensureReadOnlyStatement(statement: string): string {
  const normalized = statement.trim().replace(/;\s*$/, '')

  if (!normalized || /;/.test(normalized)) {
    throw new Error('Provide exactly one SQL statement without an internal semicolon.')
  }

  if (!/^(select\b|with\b|explain\b)/i.test(normalized)) {
    throw new Error('Only SELECT, WITH ... SELECT, and EXPLAIN statements are allowed.')
  }

  if (/\b(insert|update|delete|merge|replace|upsert|create|alter|drop|truncate|grant|revoke|call|execute|vacuum|attach|detach)\b/i.test(normalized)) {
    throw new Error('Data-modifying or administrative SQL is not allowed.')
  }

  return normalized
}

export function makeExplainStatement(dialect: DialectName, statement: string): string {
  const readOnly = ensureReadOnlyStatement(statement)
  if (/^explain\b/i.test(readOnly)) return readOnly
  return dialect === 'sqlite' ? `EXPLAIN QUERY PLAN ${readOnly}` : `EXPLAIN ${readOnly}`
}

function parseArgs(args: string[]): { command?: Command; sql?: string; help: boolean } {
  const [command, ...rest] = args
  const sqlIndex = rest.indexOf('--sql')
  const help = command === '--help' || command === '-h' || rest.includes('--help') || rest.includes('-h')
  const suppliedSql = sqlIndex >= 0 ? rest[sqlIndex + 1] : undefined

  if (sqlIndex >= 0 && !suppliedSql) throw new Error('--sql requires a statement.')
  if (rest.some((arg, index) => arg.startsWith('--') && arg !== '--sql' && index !== sqlIndex + 1)) {
    throw new Error('Unknown option. Use --help for supported options.')
  }
  if (command && !['discover', 'query', 'explain', 'health', '--help', '-h'].includes(command)) {
    throw new Error(`Unknown command: ${command}`)
  }
  return { command: command as Command | undefined, sql: suppliedSql, help }
}

function help(): void {
  console.log(`Usage: db-agent <command> [--sql <statement>]

Commands:
  discover                 List tables, columns, and primary keys.
  query --sql <statement>  Execute one read-only SQL statement.
  explain --sql <statement> Show the query plan for a read-only statement.
  health                   Verify connectivity with SELECT 1.

Environment:
  DB_DIALECT=postgres|mysql|sqlite
  DATABASE_URL=<connection URL>`)
}

function readConfig(): { dialect: DialectName; url: string } {
  const dialect = process.env.DB_DIALECT as DialectName | undefined
  const url = process.env.DATABASE_URL
  if (!dialect || !['postgres', 'mysql', 'sqlite'].includes(dialect)) {
    throw new Error('Set DB_DIALECT to postgres, mysql, or sqlite.')
  }
  if (!url) throw new Error('Set DATABASE_URL before connecting.')
  return { dialect, url }
}

function sqlitePath(url: string): string {
  if (!url.startsWith('sqlite://')) return url
  return decodeURIComponent(url.slice('sqlite://'.length))
}

function mysqlPoolFromUrl(url: string) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'mysql:') throw new Error('MySQL DATABASE_URL must start with mysql://.')
  const requestedTimezone = parsed.searchParams.get('timezone') ?? parsed.searchParams.get('serverTimezone')
  const timezone = requestedTimezone && /^(Z|local|[+-]\d{2}:?\d{2})$/.test(requestedTimezone)
    ? requestedTimezone
    : undefined

  // JDBC-only options are intentionally not forwarded to MySQL2.
  return createPool({
    host: parsed.hostname,
    port: Number(parsed.port || '3306'),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    timezone,
  })
}

function connect(dialect: DialectName, url: string): Kysely<Record<string, never>> {
  if (dialect === 'postgres') {
    return new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }) })
  }
  if (dialect === 'mysql') {
    return new Kysely({ dialect: new MysqlDialect({ pool: mysqlPoolFromUrl(url) }) })
  }
  return new Kysely({ dialect: new SqliteDialect({ database: new Database(sqlitePath(url), { readonly: true }) }) })
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2)
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.command) return help()

  const { dialect, url } = readConfig()
  const db = connect(dialect, url)
  try {
    if (args.command === 'health') {
      await sql`select 1 as ok`.execute(db)
      console.log(stringify({ ok: true, dialect }))
      return
    }

    if (args.command === 'discover') {
      const tables = await db.introspection.getTables()
      console.log(stringify(tables.map((table) => ({
        name: table.name,
        schema: table.schema,
        columns: table.columns.map((column) => ({
          name: column.name,
          type: column.dataType,
          nullable: column.isNullable,
          default: column.hasDefaultValue,
        })),
      }))))
      return
    }

    if (!args.sql) throw new Error(`${args.command} requires --sql.`)
    const statement = args.command === 'explain'
      ? makeExplainStatement(dialect, args.sql)
      : ensureReadOnlyStatement(args.sql)
    const result = await sql.raw(statement).execute(db)
    console.log(stringify({ rows: result.rows, rowCount: result.rows.length }))
  } finally {
    await db.destroy()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
