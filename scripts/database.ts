import Database from 'better-sqlite3'
import { Kysely, MysqlDialect, PostgresDialect, SqliteDialect, sql } from 'kysely'
import { createPool } from 'mysql2'
import { Pool } from 'pg'
import type { DialectName } from './core.js'
import type { Policy, SelectPlan } from './core.js'

export type DatabaseClient = Kysely<Record<string, never>>

function sqlitePath(url: string): string {
  return url.startsWith('sqlite://') ? decodeURIComponent(url.slice('sqlite://'.length)) : url
}

function mysqlPoolFromUrl(url: string) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'mysql:') throw new Error('MySQL DATABASE_URL must start with mysql://.')
  const requestedTimezone = parsed.searchParams.get('timezone') ?? parsed.searchParams.get('serverTimezone')
  const timezone = requestedTimezone && /^(Z|local|[+-]\d{2}:?\d{2})$/.test(requestedTimezone) ? requestedTimezone : undefined
  return createPool({
    host: parsed.hostname,
    port: Number(parsed.port || '3306'),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.slice(1)),
    timezone,
  })
}

export function withLocalTunnel(url: string, localPort?: number): string {
  if (!localPort || url.startsWith('sqlite://')) return url
  const parsed = new URL(url)
  parsed.hostname = '127.0.0.1'
  parsed.port = String(localPort)
  return parsed.toString()
}

export function connect(dialect: DialectName, url: string): DatabaseClient {
  if (dialect === 'postgres') return new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }) })
  if (dialect === 'mysql') return new Kysely({ dialect: new MysqlDialect({ pool: mysqlPoolFromUrl(url) }) })
  return new Kysely({ dialect: new SqliteDialect({ database: new Database(sqlitePath(url), { readonly: true }) }) })
}

export async function executeWithTimeout<T>(operation: Promise<T>, timeoutMs = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`Query timed out after ${timeoutMs}ms.`)), timeoutMs) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function discover(db: DatabaseClient, tableName?: string) {
  const tables = await db.introspection.getTables()
  return tables
    .filter((table) => !tableName || table.name.toLowerCase().includes(tableName.toLowerCase()))
    .map((table) => ({
      name: table.name,
      schema: table.schema,
      isView: table.isView,
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.dataType,
        nullable: column.isNullable,
        autoIncrementing: column.isAutoIncrementing,
        default: column.hasDefaultValue,
      })),
    }))
}

export async function health(db: DatabaseClient): Promise<{ ok: true }> {
  await sql`select 1 as ok`.execute(db)
  return { ok: true }
}

export async function statistics(db: DatabaseClient, dialect: DialectName) {
  if (dialect === 'mysql') return (await sql`
    select table_schema as schema_name, count(*) as table_count,
      coalesce(sum(table_rows), 0) as estimated_rows,
      coalesce(sum(data_length + index_length), 0) as bytes
    from information_schema.tables where table_schema = database() group by table_schema
  `.execute(db)).rows
  if (dialect === 'postgres') return (await sql`
    select current_schema() as schema_name, count(*) as table_count,
      coalesce(sum(n_live_tup), 0) as estimated_rows
    from pg_stat_user_tables
  `.execute(db)).rows
  return (await sql`select count(*) as table_count from sqlite_master where type = 'table' and name not like 'sqlite_%'`.execute(db)).rows
}

export async function query(db: DatabaseClient, statement: string) {
  return sql.raw(statement).execute(db)
}

function quotedIdentifier(value: string, dialect: DialectName): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsafe identifier: ${value}`)
  const quote = dialect === 'postgres' ? '"' : '`'
  return `${quote}${value}${quote}`
}

export async function queryPlan(db: DatabaseClient, dialect: DialectName, plan: SelectPlan, policy: Pick<Policy, 'maxRows'> & { fetchExtra?: boolean }) {
  if (plan.columns.length === 0) throw new Error('Select plans require at least one column.')
  const maxRows = Math.max(1, Math.min(policy.maxRows ?? 100, 10_000))
  const pageSize = Math.max(1, Math.min(plan.limit ?? maxRows, maxRows))
  const limit = pageSize + (policy.fetchExtra ? 1 : 0)
  const offset = Math.max(0, plan.offset ?? 0)
  const columns = sql.join(plan.columns.map((column) => sql.raw(quotedIdentifier(column, dialect))), sql.raw(', '))
  const predicates = (plan.where ?? []).map(({ column, op, value }) => {
    const normalized = op.toLowerCase()
    if (!['=', '!=', '<>', '>', '>=', '<', '<=', 'like', 'in'].includes(normalized)) throw new Error(`Unsupported operator: ${op}`)
    const identifier = sql.raw(quotedIdentifier(column, dialect))
    if (normalized === 'in') {
      if (!Array.isArray(value) || value.length === 0) throw new Error('IN requires a non-empty array.')
      return sql`${identifier} in (${sql.join(value.map((item) => sql.val(item)), sql.raw(', '))})`
    }
    return sql`${identifier} ${sql.raw(normalized.toUpperCase())} ${sql.val(value)}`
  })
  const orderBy = (plan.orderBy ?? []).map(({ column, direction = 'asc' }) => {
    if (!['asc', 'desc'].includes(direction)) throw new Error(`Unsupported sort direction: ${direction}`)
    return sql`${sql.raw(quotedIdentifier(column, dialect))} ${sql.raw(direction.toUpperCase())}`
  })
  const where = predicates.length ? sql` where ${sql.join(predicates, sql.raw(' and '))}` : sql``
  const ordering = orderBy.length ? sql` order by ${sql.join(orderBy, sql.raw(', '))}` : sql``
  const pagination = offset > 0 ? sql` limit ${sql.val(limit)} offset ${sql.val(offset)}` : sql` limit ${sql.val(limit)}`
  return sql`select ${columns} from ${sql.raw(quotedIdentifier(plan.table, dialect))}${where}${ordering}${pagination}`.execute(db)
}

export async function indexes(db: DatabaseClient, dialect: DialectName, table: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Unsafe identifier: ${table}`)
  if (dialect === 'mysql') return (await sql.raw(`show index from \`${table}\``).execute(db)).rows
  if (dialect === 'postgres') return (await sql`select indexname, indexdef from pg_indexes where tablename = ${table}`.execute(db)).rows
  return (await sql.raw(`pragma index_list('${table}')`).execute(db)).rows
}

export async function relationships(db: DatabaseClient, dialect: DialectName, table?: string) {
  if (dialect === 'mysql') {
    const result = await sql`
      select table_name, column_name, referenced_table_name, referenced_column_name
      from information_schema.key_column_usage
      where table_schema = database() and referenced_table_name is not null
    `.execute(db)
    return (result.rows as Array<Record<string, unknown>>).filter((row) => !table || String(row.table_name) === table)
  }
  if (dialect === 'postgres') {
    const result = await sql`
      select tc.table_name, kcu.column_name, ccu.table_name as referenced_table_name, ccu.column_name as referenced_column_name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
      join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
      where tc.constraint_type = 'FOREIGN KEY'
    `.execute(db)
    return (result.rows as Array<Record<string, unknown>>).filter((row) => !table || String(row.table_name) === table)
  }
  const tables = await discover(db, table)
  const output: Array<Record<string, unknown>> = []
  for (const entry of tables) {
    const rows = (await sql.raw(`pragma foreign_key_list('${entry.name}')`).execute(db)).rows
    output.push(...(rows as Array<Record<string, unknown>>).map((row) => ({ table_name: entry.name, ...row })))
  }
  return output
}
