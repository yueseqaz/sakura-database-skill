import { createPool, type Pool, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise'
import type { DialectName } from './core.js'
import { compileSelectPlan, type Policy, type SelectPlan } from './core.js'

export interface DatabaseResult {
  rows: Array<Record<string, unknown>>
  affectedRows?: number
  insertId?: number
}

export interface TransactionClient {
  execute(statement: string, parameters?: unknown[]): Promise<DatabaseResult>
}

export interface DatabaseClient extends TransactionClient {
  transaction<T>(run: (transaction: TransactionClient) => Promise<T>): Promise<T>
  destroy(): Promise<void>
}

function databaseResult(result: unknown): DatabaseResult {
  if (Array.isArray(result)) return { rows: result as RowDataPacket[] }
  const header = result as ResultSetHeader
  return { rows: [], affectedRows: header.affectedRows, insertId: header.insertId }
}

function mysqlPoolFromUrl(url: string, timeoutMs: number): Pool {
  const parsed = new URL(url)
  if (parsed.protocol !== 'mysql:') throw new Error('DATABASE_URL must start with mysql://.')
  const requestedTimezone = parsed.searchParams.get('timezone') ?? parsed.searchParams.get('serverTimezone')
  const timezone = requestedTimezone && /^(Z|local|[+-]\d{2}:?\d{2})$/.test(requestedTimezone) ? requestedTimezone : undefined
  return createPool({
    host: parsed.hostname,
    port: Number(parsed.port || '3306'),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.slice(1)),
    timezone,
    multipleStatements: false,
    connectTimeout: timeoutMs,
    enableKeepAlive: true,
  })
}

export function withLocalTunnel(url: string, localPort?: number): string {
  if (!localPort) return url
  const parsed = new URL(url)
  parsed.hostname = '127.0.0.1'
  parsed.port = String(localPort)
  return parsed.toString()
}

export function connect(dialect: DialectName, url: string, timeoutMs = 10_000): DatabaseClient {
  if (dialect !== 'mysql') throw new Error('This version only supports MySQL.')
  const boundedTimeout = Math.max(100, Math.min(timeoutMs, 120_000))
  const pool = mysqlPoolFromUrl(url, boundedTimeout)
  return {
    async execute(statement, parameters = []) {
      const connection = await pool.getConnection()
      try {
        await connection.query(`SET SESSION transaction_read_only = ON, SESSION max_execution_time = ${boundedTimeout}`)
        // mysql2 escapes every value client-side. This avoids MySQL 8.4 prepared-statement
        // type inference failures for metadata queries and parameterized LIMIT clauses.
        const [result] = await connection.query(statement, parameters as never[])
        return databaseResult(result)
      } finally {
        connection.release()
      }
    },
    async transaction(run) {
      const connection = await pool.getConnection()
      let transactionTimer: NodeJS.Timeout | undefined
      try {
        await connection.query(`SET SESSION transaction_read_only = OFF, SESSION max_execution_time = ${boundedTimeout}`)
        await connection.beginTransaction()
        transactionTimer = setTimeout(() => connection.destroy(), boundedTimeout)
        const transaction: TransactionClient = {
          async execute(statement, parameters = []) {
            const [result] = await connection.query(statement, parameters as never[])
            return databaseResult(result)
          },
        }
        const value = await run(transaction)
        await connection.commit()
        return value
      } catch (error) {
        try { await connection.rollback() } catch { /* A destroyed connection has already rolled back. */ }
        throw error
      } finally {
        if (transactionTimer) clearTimeout(transactionTimer)
        connection.release()
      }
    },
    async destroy() { await pool.end() },
  }
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

export interface DiscoveryOptions { search?: string; limit?: number; cursor?: string }

type DiscoveredTable = {
  name: string
  schema: string
  isView: boolean
  columns: Array<{ name: string; type: string; nullable: boolean; autoIncrementing: boolean; default: boolean }>
}

function mapDiscoveredTables(rows: Array<Record<string, unknown>>): DiscoveredTable[] {
  const tables = new Map<string, DiscoveredTable>()
  for (const row of rows) {
    const name = String(row.table_name)
    const table = tables.get(name) ?? { name, schema: String(row.table_schema), isView: String(row.table_type) === 'VIEW', columns: [] }
    table.columns.push({
      name: String(row.column_name),
      type: String(row.data_type),
      nullable: String(row.is_nullable) === 'YES',
      autoIncrementing: String(row.extra).includes('auto_increment'),
      default: row.column_default !== null,
    })
    tables.set(name, table)
  }
  return [...tables.values()]
}

export async function discoverTables(db: DatabaseClient, tableNames: string[]): Promise<DiscoveredTable[]> {
  const names = [...new Set(tableNames)]
  if (names.length === 0) return []
  if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error('Schema discovery requires safe table names.')
  const { rows } = await db.execute(`
    select t.table_schema as table_schema, t.table_name as table_name, t.table_type as table_type,
      c.column_name as column_name, c.data_type as data_type, c.is_nullable as is_nullable,
      c.extra as extra, c.column_default as column_default
    from information_schema.tables t
    join information_schema.columns c
      on c.table_schema = t.table_schema and c.table_name = t.table_name
    where t.table_schema = database() and t.table_name in (${names.map(() => '?').join(', ')})
    order by t.table_name, c.ordinal_position
  `, names)
  return mapDiscoveredTables(rows)
}

function encodeCursor(tableName: string): string {
  return Buffer.from(tableName, 'utf8').toString('base64url')
}

function decodeCursor(cursor?: string): string {
  if (!cursor) return ''
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(decoded)) throw new Error('Invalid schema cursor.')
  return decoded
}

export async function discoverPage(db: DatabaseClient, options: DiscoveryOptions = {}): Promise<{ tables: DiscoveredTable[]; nextCursor?: string }> {
  const limit = options.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Schema discovery limit must be an integer between 1 and 100.')
  const pattern = options.search ? `%${options.search.toLowerCase()}%` : '%'
  const cursor = decodeCursor(options.cursor)
  const { rows } = await db.execute(`
    select table_name as table_name
    from information_schema.tables
    where table_schema = database() and lower(table_name) like ? and table_name > ?
    order by table_name
    limit ${limit + 1}
  `, [pattern, cursor])
  const names = rows.slice(0, limit).map((row) => String(row.table_name))
  const tables = await discoverTables(db, names)
  return { tables, nextCursor: rows.length > limit && names.length ? encodeCursor(names.at(-1) as string) : undefined }
}

export async function discover(db: DatabaseClient, tableName?: string): Promise<DiscoveredTable[]> {
  if (tableName) return discoverTables(db, [tableName])
  return (await discoverPage(db, { limit: 100 })).tables
}

export async function health(db: DatabaseClient): Promise<{ ok: true }> {
  await db.execute('select 1 as ok')
  return { ok: true }
}

export async function statistics(db: DatabaseClient, _dialect: DialectName) {
  return (await db.execute(`
    select table_schema as schema_name, count(*) as table_count,
      coalesce(sum(table_rows), 0) as estimated_rows,
      coalesce(sum(data_length + index_length), 0) as bytes
    from information_schema.tables where table_schema = database() group by table_schema
  `)).rows
}

export async function queryPlan(db: DatabaseClient, dialect: DialectName, plan: SelectPlan, policy: Pick<Policy, 'maxRows'> & { fetchExtra?: boolean }) {
  const maxRows = Math.max(1, Math.min(policy.maxRows ?? 100, 10_000))
  const pageSize = Math.max(1, Math.min(plan.limit ?? maxRows, maxRows))
  const limit = pageSize + (policy.fetchExtra ? 1 : 0)
  const compiled = compileSelectPlan({ ...plan, limit }, { maxRows: limit }, dialect)
  return db.execute(compiled.sql, compiled.parameters)
}

export async function explainPlan(db: DatabaseClient, plan: SelectPlan, policy: Pick<Policy, 'maxRows'> = {}) {
  const compiled = compileSelectPlan(plan, policy, 'mysql')
  return db.execute(`EXPLAIN ${compiled.sql}`, compiled.parameters)
}

export async function indexes(db: DatabaseClient, _dialect: DialectName, table: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Unsafe identifier: ${table}`)
  return (await db.execute(`show index from \`${table}\``)).rows
}

export async function relationships(db: DatabaseClient, _dialect: DialectName, table?: string) {
  const { rows } = await db.execute(`
    select table_name as table_name, column_name as column_name,
      referenced_table_name as referenced_table_name, referenced_column_name as referenced_column_name
    from information_schema.key_column_usage
    where table_schema = database() and referenced_table_name is not null
      and (? is null or table_name = ?)
    order by table_name, column_name
  `, [table ?? null, table ?? null])
  return rows
}
