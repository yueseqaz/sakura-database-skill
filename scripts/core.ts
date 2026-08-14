export type DialectName = 'postgres' | 'mysql' | 'sqlite'
export type QueryOperator = '=' | '!=' | '<>' | '>' | '>=' | '<' | '<=' | 'like' | 'in'

export interface SelectPlan {
  table: string
  columns: string[]
  where?: Array<{ column: string; op: QueryOperator; value: unknown }>
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
}

const DEFAULT_SENSITIVE_COLUMNS = [
  'password', 'salt', 'secret', 'token', 'api_key', 'apikey', 'email', 'phone', 'mobile',
  'id_card', 'identity', 'resume', 'medical', 'birth',
]

function identifier(value: string, dialect: DialectName = 'mysql'): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsafe identifier: ${value}`)
  const quote = dialect === 'postgres' ? '"' : '`'
  return `${quote}${value}${quote}`
}

export function compileSelectPlan(plan: SelectPlan, policy: Pick<Policy, 'maxRows'> = {}, dialect: DialectName = 'mysql') {
  if (!Array.isArray(plan.columns) || plan.columns.length === 0) throw new Error('Select plans require at least one column.')
  const maxRows = Math.max(1, Math.min(policy.maxRows ?? 100, 10_000))
  const limit = Math.max(1, Math.min(plan.limit ?? maxRows, maxRows))
  const offset = Math.max(0, plan.offset ?? 0)
  const parameters: unknown[] = []
  let placeholder = 0
  const bind = (value: unknown) => {
    parameters.push(value)
    if (dialect === 'postgres') return `$${++placeholder}`
    return '?'
  }

  const predicates = (plan.where ?? []).map(({ column, op, value }) => {
    const normalized = op.toLowerCase() as QueryOperator
    if (!['=', '!=', '<>', '>', '>=', '<', '<=', 'like', 'in'].includes(normalized)) {
      throw new Error(`Unsupported operator: ${op}`)
    }
    if (normalized === 'in') {
      if (!Array.isArray(value) || value.length === 0) throw new Error('IN requires a non-empty array.')
      return `${identifier(column, dialect)} in (${value.map(bind).join(', ')})`
    }
    return `${identifier(column, dialect)} ${normalized.toUpperCase()} ${bind(value)}`
  })

  const orderBy = (plan.orderBy ?? []).map(({ column, direction = 'asc' }) => {
    if (!['asc', 'desc'].includes(direction)) throw new Error(`Unsupported sort direction: ${direction}`)
    return `${identifier(column, dialect)} ${direction.toUpperCase()}`
  })

  const limitPlaceholder = bind(limit)
  const offsetClause = offset > 0 ? ` offset ${bind(offset)}` : ''
  return {
    sql: `select ${plan.columns.map((column) => identifier(column, dialect)).join(', ')} from ${identifier(plan.table, dialect)}${predicates.length ? ` where ${predicates.join(' and ')}` : ''}${orderBy.length ? ` order by ${orderBy.join(', ')}` : ''} limit ${limitPlaceholder}${offsetClause}`,
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
}

export function safeStatement(statement: string): string {
  const normalized = statement.trim().replace(/;\s*$/, '')
  if (!normalized || /;/.test(normalized)) throw new Error('Provide exactly one SQL statement without an internal semicolon.')
  if (!/^(select\b|with\b|explain\b)/i.test(normalized)) throw new Error('Only SELECT, WITH ... SELECT, and EXPLAIN statements are allowed.')
  if (/\b(insert|update|delete|merge|replace|upsert|create|alter|drop|truncate|grant|revoke|call|execute|vacuum|attach|detach|load\s+data)\b/i.test(normalized)) {
    throw new Error('Data-modifying or administrative SQL is not allowed.')
  }
  return normalized
}

export function makeExplainStatement(dialect: DialectName, statement: string): string {
  const readOnly = safeStatement(statement)
  if (/^explain\b/i.test(readOnly)) return readOnly
  return dialect === 'sqlite' ? `EXPLAIN QUERY PLAN ${readOnly}` : `EXPLAIN ${readOnly}`
}
