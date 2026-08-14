export type DialectName = 'mysql'
export type QueryOperator = '=' | '!=' | '<>' | '>' | '>=' | '<' | '<=' | 'like' | 'in' | 'not in' | 'between' | 'is null' | 'is not null'
export type AggregateFunction = 'count' | 'sum' | 'avg' | 'min' | 'max'
export type FieldExpression = string | { aggregate: AggregateFunction; column?: string }
export type SelectedColumn = string | { column?: string; aggregate?: AggregateFunction; as?: string }
export interface QueryPredicate { column: FieldExpression; op: QueryOperator; value?: unknown }
export type QueryFilter = QueryPredicate | { and: QueryFilter[] } | { or: QueryFilter[] }

export interface SelectJoin {
  table: string
  as?: string
  type?: 'inner' | 'left'
  on: Array<{ left: string; op: '=' | '!=' | '<>' | '>' | '>=' | '<' | '<='; right: string }>
}

export interface SelectPlan {
  table: string
  as?: string
  columns: SelectedColumn[]
  joins?: SelectJoin[]
  where?: QueryPredicate[] | QueryFilter
  groupBy?: string[]
  having?: QueryFilter
  orderBy?: Array<{ column: string; direction?: 'asc' | 'desc' }>
  limit?: number
  offset?: number
}

export interface Policy {
  environment?: 'development' | 'staging' | 'production'
  maxRows?: number
  timeoutMs?: number
  sensitiveColumns?: string[]
  requireApproval?: boolean
  allowSensitive?: boolean
  allowedTables?: string[]
  deniedTables?: string[]
  allowedColumns?: Record<string, string[]>
  deniedColumns?: Record<string, string[]>
  requiredFilters?: Record<string, string[]>
  maxEstimatedRows?: number
  allowWrites?: boolean
  allowDelete?: boolean
  maxAffectedRows?: number
  allowSchemaChanges?: boolean
  allowDrop?: boolean
  allowCreateDatabase?: boolean
  allowedDatabases?: string[]
}

export const INTERNAL_IDEMPOTENCY_TABLE = '__sakura_database_idempotency'

export function assertUserTable(table: string): void {
  if (table === INTERNAL_IDEMPOTENCY_TABLE) throw new Error(`Reserved internal table cannot be accessed: ${table}`)
}

const DEFAULT_SENSITIVE_COLUMNS = [
  'password', 'salt', 'secret', 'token', 'api_key', 'apikey', 'email', 'phone', 'mobile',
  'id_card', 'identity', 'resume', 'medical', 'birth',
]

function identifier(value: string, dialect: DialectName = 'mysql', allowStar = false): string {
  if (allowStar && value === '*') return '*'
  const parts = value.split('.')
  if (parts.length > 2 || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) throw new Error(`Unsafe identifier: ${value}`)
  return parts.map((part) => `\`${part}\``).join('.')
}

export function compileSelectPlan(plan: SelectPlan, policy: Pick<Policy, 'maxRows'> = {}, dialect: DialectName = 'mysql') {
  if (!Array.isArray(plan.columns) || plan.columns.length === 0) throw new Error('Select plans require at least one column.')
  assertUserTable(plan.table)
  for (const join of plan.joins ?? []) assertUserTable(join.table)
  const maxRows = Math.max(1, Math.min(policy.maxRows ?? 100, 10_000))
  const limit = Math.max(1, Math.min(plan.limit ?? maxRows, maxRows))
  const offset = Math.max(0, plan.offset ?? 0)
  const parameters: unknown[] = []
  const bind = (value: unknown) => {
    parameters.push(value)
    return '?'
  }

  const compileField = (field: FieldExpression): string => {
    if (typeof field === 'string') return identifier(field, dialect)
    const column = field.column ?? '*'
    if (column === '*' && field.aggregate !== 'count') throw new Error('Only COUNT may use * as its column.')
    return `${field.aggregate.toUpperCase()}(${identifier(column, dialect, true)})`
  }
  const compilePredicate = ({ column, op, value }: QueryPredicate): string => {
    const normalized = op.toLowerCase() as QueryOperator
    if (!['=', '!=', '<>', '>', '>=', '<', '<=', 'like', 'in', 'not in', 'between', 'is null', 'is not null'].includes(normalized)) {
      throw new Error(`Unsupported operator: ${op}`)
    }
    const field = compileField(column)
    if (normalized === 'is null' || normalized === 'is not null') return `${field} ${normalized.toUpperCase()}`
    if (normalized === 'in' || normalized === 'not in') {
      if (!Array.isArray(value) || value.length === 0) throw new Error('IN requires a non-empty array.')
      return `${field} ${normalized.toUpperCase()} (${value.map(bind).join(', ')})`
    }
    if (normalized === 'between') {
      if (!Array.isArray(value) || value.length !== 2) throw new Error('BETWEEN requires an array with exactly two values.')
      return `${field} BETWEEN ${bind(value[0])} AND ${bind(value[1])}`
    }
    return `${field} ${normalized.toUpperCase()} ${bind(value)}`
  }
  const compileFilter = (filter: QueryPredicate[] | QueryFilter): string => {
    if (Array.isArray(filter)) return filter.map(compilePredicate).join(' and ')
    if ('and' in filter || 'or' in filter) {
      const operator = 'and' in filter ? 'and' : 'or'
      const children = 'and' in filter ? filter.and : filter.or
      if (children.length === 0) throw new Error(`${operator.toUpperCase()} requires at least one condition.`)
      return `(${children.map((child) => compileFilter(child)).join(` ${operator} `)})`
    }
    return compilePredicate(filter)
  }

  const selectedColumns = plan.columns.map((column) => {
    if (typeof column === 'string') return identifier(column, dialect)
    if (!column.column && !column.aggregate) throw new Error('A selected expression requires column or aggregate.')
    const expression = column.aggregate
      ? compileField({ aggregate: column.aggregate, column: column.column })
      : identifier(column.column as string, dialect)
    return `${expression}${column.as ? ` as ${identifier(column.as, dialect)}` : ''}`
  })

  const table = `${identifier(plan.table, dialect)}${plan.as ? ` as ${identifier(plan.as, dialect)}` : ''}`
  const joins = (plan.joins ?? []).map((join) => {
    if (join.on.length === 0) throw new Error('JOIN requires at least one ON condition.')
    const conditions = join.on.map((condition) => `${identifier(condition.left, dialect)} ${condition.op} ${identifier(condition.right, dialect)}`)
    return `${join.type ?? 'inner'} join ${identifier(join.table, dialect)}${join.as ? ` as ${identifier(join.as, dialect)}` : ''} on ${conditions.join(' and ')}`
  })

  const orderBy = (plan.orderBy ?? []).map(({ column, direction = 'asc' }) => {
    if (!['asc', 'desc'].includes(direction)) throw new Error(`Unsupported sort direction: ${direction}`)
    return `${identifier(column, dialect)} ${direction.toUpperCase()}`
  })

  const whereClause = plan.where ? ` where ${compileFilter(plan.where)}` : ''
  const groupByClause = plan.groupBy?.length ? ` group by ${plan.groupBy.map((column) => identifier(column, dialect)).join(', ')}` : ''
  const havingClause = plan.having ? ` having ${compileFilter(plan.having)}` : ''
  const limitPlaceholder = bind(limit)
  const offsetClause = offset > 0 ? ` offset ${bind(offset)}` : ''
  return {
    sql: `select ${selectedColumns.join(', ')} from ${table}${joins.length ? ` ${joins.join(' ')}` : ''}${whereClause}${groupByClause}${havingClause}${orderBy.length ? ` order by ${orderBy.join(', ')}` : ''} limit ${limitPlaceholder}${offsetClause}`,
    parameters,
  }
}

export function maskRows(rows: ReadonlyArray<Record<string, unknown>>, sensitiveColumns = DEFAULT_SENSITIVE_COLUMNS): Array<Record<string, unknown>> {
  const needles = sensitiveColumns.map((column) => column.toLowerCase())
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    needles.some((needle) => key.toLowerCase().includes(needle)) ? '[REDACTED]' : value,
  ])))
}

export function validatePolicy(policy: Policy, input: { action: string; approvalToken?: string }): void {
  if (policy.environment === 'production' && policy.requireApproval !== false && !input.approvalToken) {
    throw new Error(`An approval token is required for ${input.action} against a production profile.`)
  }
  if (policy.maxRows !== undefined && (!Number.isInteger(policy.maxRows) || policy.maxRows < 1 || policy.maxRows > 10_000)) {
    throw new Error('maxRows must be an integer between 1 and 10000.')
  }
  if (policy.timeoutMs !== undefined && (!Number.isInteger(policy.timeoutMs) || policy.timeoutMs < 100 || policy.timeoutMs > 120_000)) {
    throw new Error('timeoutMs must be an integer between 100 and 120000.')
  }
  if (policy.maxEstimatedRows !== undefined && (!Number.isInteger(policy.maxEstimatedRows) || policy.maxEstimatedRows < 1)) {
    throw new Error('maxEstimatedRows must be a positive integer.')
  }
  if (policy.maxAffectedRows !== undefined && (!Number.isInteger(policy.maxAffectedRows) || policy.maxAffectedRows < 1 || policy.maxAffectedRows > 10_000)) {
    throw new Error('maxAffectedRows must be an integer between 1 and 10000.')
  }
}

export function validateSensitiveAccess(policy: Pick<Policy, 'allowSensitive'>, requested: boolean): void {
  if (requested && policy.allowSensitive !== true) {
    throw new Error('Sensitive results require allowSensitive: true in the selected profile.')
  }
}

export function validatePlanPolicy(plan: SelectPlan, policy: Policy): void {
  const aliases = new Map<string, string>([[plan.as ?? plan.table, plan.table]])
  for (const join of plan.joins ?? []) aliases.set(join.as ?? join.table, join.table)
  const tables = [plan.table, ...(plan.joins ?? []).map((join) => join.table)]
  for (const table of tables) {
    assertUserTable(table)
    if (policy.allowedTables && !policy.allowedTables.includes(table)) throw new Error(`Table is not allowed by policy: ${table}`)
    if (policy.deniedTables?.includes(table)) throw new Error(`Table is denied by policy: ${table}`)
  }

  const resolveReference = (reference: string): { table: string; column: string } => {
    const parts = reference.split('.')
    if (parts.length === 1) return { table: plan.table, column: parts[0] }
    return { table: aliases.get(parts[0]) ?? parts[0], column: parts[1] }
  }
  const assertColumn = (reference: string) => {
    if (reference === '*') return
    const { table, column } = resolveReference(reference)
    const allowed = policy.allowedColumns?.[table]
    if (allowed && !allowed.includes(column)) throw new Error(`Column is not allowed by policy: ${table}.${column}`)
    if (policy.deniedColumns?.[table]?.includes(column)) throw new Error(`Column is denied by policy: ${table}.${column}`)
  }
  const fieldReference = (field: FieldExpression) => typeof field === 'string' ? field : field.column ?? '*'
  const visitFilter = (filter: QueryPredicate[] | QueryFilter, visitor: (predicate: QueryPredicate) => void) => {
    if (Array.isArray(filter)) return filter.forEach(visitor)
    if ('and' in filter) return filter.and.forEach((child) => visitFilter(child, visitor))
    if ('or' in filter) return filter.or.forEach((child) => visitFilter(child, visitor))
    visitor(filter)
  }

  for (const selected of plan.columns) assertColumn(typeof selected === 'string' ? selected : selected.column ?? '*')
  for (const join of plan.joins ?? []) for (const condition of join.on) {
    assertColumn(condition.left)
    assertColumn(condition.right)
  }
  if (plan.where) visitFilter(plan.where, (predicate) => assertColumn(fieldReference(predicate.column)))
  if (plan.having) visitFilter(plan.having, (predicate) => assertColumn(fieldReference(predicate.column)))
  for (const column of plan.groupBy ?? []) assertColumn(column)
  for (const order of plan.orderBy ?? []) assertColumn(order.column)

  const guaranteedFilters = (filter: QueryPredicate[] | QueryFilter): Set<string> => {
    if (Array.isArray(filter)) {
      return new Set(filter.map((predicate) => {
        const { table, column } = resolveReference(fieldReference(predicate.column))
        return `${table}.${column}`
      }))
    }
    if ('and' in filter) {
      return new Set(filter.and.flatMap((child) => [...guaranteedFilters(child)]))
    }
    if ('or' in filter) {
      const branches = filter.or.map(guaranteedFilters)
      if (branches.length === 0) return new Set()
      return new Set([...branches[0]].filter((entry) => branches.slice(1).every((branch) => branch.has(entry))))
    }
    const { table, column } = resolveReference(fieldReference(filter.column))
    return new Set([`${table}.${column}`])
  }
  const filtered = plan.where ? guaranteedFilters(plan.where) : new Set<string>()
  for (const [table, columns] of Object.entries(policy.requiredFilters ?? {})) {
    for (const column of columns) {
      if (tables.includes(table) && !filtered.has(`${table}.${column}`)) throw new Error(`Missing required filter: ${table}.${column}`)
    }
  }
}

export interface ObservedTable {
  name: string
  columns: Array<{ name: string }>
}

export function validatePlanSchema(plan: SelectPlan, tables: ObservedTable[]): void {
  const aliases = new Map<string, ObservedTable>()
  const addTable = (tableName: string, alias?: string) => {
    const table = tables.find((entry) => entry.name === tableName)
    if (!table) throw new Error(`Unknown table in observed schema: ${tableName}`)
    const key = alias ?? tableName
    if (aliases.has(key)) throw new Error(`Duplicate table alias: ${key}`)
    aliases.set(key, table)
  }
  addTable(plan.table, plan.as)
  for (const join of plan.joins ?? []) addTable(join.table, join.as)

  const base = aliases.get(plan.as ?? plan.table) as ObservedTable
  const validateColumn = (reference: string) => {
    if (reference === '*') return
    const parts = reference.split('.')
    const table = parts.length === 2 ? aliases.get(parts[0]) : base
    const column = parts.length === 2 ? parts[1] : parts[0]
    if (!table) throw new Error(`Unknown table alias: ${parts[0]}`)
    if (!table.columns.some((entry) => entry.name === column)) throw new Error(`Unknown column in ${table.name}: ${column}`)
  }
  const validateField = (field: FieldExpression) => validateColumn(typeof field === 'string' ? field : field.column ?? '*')
  const validateFilter = (filter: QueryPredicate[] | QueryFilter) => {
    if (Array.isArray(filter)) return filter.forEach((predicate) => validateField(predicate.column))
    if ('and' in filter) return filter.and.forEach(validateFilter)
    if ('or' in filter) return filter.or.forEach(validateFilter)
    validateField(filter.column)
  }

  for (const column of plan.columns) validateField(typeof column === 'string' ? column : { aggregate: column.aggregate ?? 'count', column: column.column })
  for (const join of plan.joins ?? []) for (const condition of join.on) {
    validateColumn(condition.left)
    validateColumn(condition.right)
  }
  if (plan.where) validateFilter(plan.where)
  if (plan.having) validateFilter(plan.having)
  for (const column of plan.groupBy ?? []) validateColumn(column)
  for (const order of plan.orderBy ?? []) validateColumn(order.column)
}
