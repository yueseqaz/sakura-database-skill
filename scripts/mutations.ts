import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseClient } from './database.js'
import { assertUserTable, type ObservedTable, type Policy, type QueryFilter, type QueryPredicate, type QueryOperator } from './core.js'

type MutationWhere = QueryPredicate[] | QueryFilter
type MutationRow = Record<string, unknown>

export interface InsertPlan { operation: 'insert'; table: string; rows: MutationRow[] }
export interface OptimisticLock { column: string; value: unknown }
export interface UpdatePlan { operation: 'update'; table: string; set: MutationRow; where: MutationWhere; optimisticLock?: OptimisticLock }
export interface DeletePlan { operation: 'delete'; table: string; where: MutationWhere; optimisticLock?: OptimisticLock }
export type MutationPlan = InsertPlan | UpdatePlan | DeletePlan

export interface CompiledMutation {
  operation: MutationPlan['operation']
  table: string
  sql: string
  parameters: unknown[]
  maximumAffectedRows: number
}

export interface MutationPolicy extends Pick<Policy,
  'allowWrites' | 'allowDelete' | 'maxAffectedRows' | 'allowedTables' | 'deniedTables' |
  'allowedColumns' | 'deniedColumns' | 'requiredFilters'> {}

export interface MutationExecutionOptions {
  approvalToken?: string
  confirmFingerprint?: string
  profileName?: string
  idempotencyKey?: string
}

export interface MutationExecutionResult {
  operation: MutationPlan['operation']
  table: string
  affectedRows: number
  insertId?: number
  idempotentReplay?: boolean
}

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsafe mutation identifier: ${value}`)
  return `\`${value}\``
}

function assertMutationOperation(plan: MutationPlan): void {
  if (!['insert', 'update', 'delete'].includes(plan.operation)) throw new Error(`Unsupported mutation operation: ${String(plan.operation)}`)
}

function mutationRecord(value: unknown, label: string): MutationRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as MutationRow
}

function mutationValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new Error('Mutation values must be JSON scalar values. Serialize JSON and date values explicitly.')
}

function maximumAffectedRows(policy: MutationPolicy): number {
  return Math.max(1, Math.min(policy.maxAffectedRows ?? 100, 10_000))
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function mutationPlanFingerprint(profileName: string, plan: MutationPlan, policy: MutationPolicy): string {
  const effectivePolicy = {
    allowWrites: policy.allowWrites === true,
    allowDelete: policy.allowDelete === true,
    maxAffectedRows: maximumAffectedRows(policy),
    allowedTables: policy.allowedTables ? [...policy.allowedTables].sort() : undefined,
    deniedTables: policy.deniedTables ? [...policy.deniedTables].sort() : undefined,
    allowedColumns: policy.allowedColumns,
    deniedColumns: policy.deniedColumns,
    requiredFilters: policy.requiredFilters,
  }
  return createHash('sha256').update(canonicalJson({ profileName, plan, policy: effectivePolicy })).digest('hex')
}

function assertTable(table: string, policy: MutationPolicy): void {
  identifier(table)
  assertUserTable(table)
  if (policy.allowWrites !== true) throw new Error('Mutation plans require allowWrites: true in the selected profile.')
  if (policy.allowedTables && !policy.allowedTables.includes(table)) throw new Error(`Table is not allowed by policy: ${table}`)
  if (policy.deniedTables?.includes(table)) throw new Error(`Table is denied by policy: ${table}`)
}

function assertColumn(table: string, column: string, policy: MutationPolicy): void {
  identifier(column)
  const allowed = policy.allowedColumns?.[table]
  if (allowed && !allowed.includes(column)) throw new Error(`Column is not allowed by policy: ${table}.${column}`)
  if (policy.deniedColumns?.[table]?.includes(column)) throw new Error(`Column is denied by policy: ${table}.${column}`)
}

function compileWhere(where: MutationWhere, table: string, policy: MutationPolicy) {
  const parameters: unknown[] = []
  const bind = (value: unknown) => { parameters.push(mutationValue(value)); return '?' }
  const predicate = ({ column, op, value }: QueryPredicate): string => {
    if (typeof column !== 'string' || column.includes('.')) throw new Error('Mutation filters require an unqualified column name.')
    assertColumn(table, column, policy)
    const normalized = op.toLowerCase() as QueryOperator
    if (!['=', '!=', '<>', '>', '>=', '<', '<=', 'like', 'in', 'not in', 'between', 'is null', 'is not null'].includes(normalized)) throw new Error(`Unsupported mutation operator: ${op}`)
    const field = identifier(column)
    if (normalized === 'is null' || normalized === 'is not null') return `${field} ${normalized.toUpperCase()}`
    if (normalized === 'in' || normalized === 'not in') {
      if (!Array.isArray(value) || value.length === 0) throw new Error('Mutation IN requires a non-empty array.')
      return `${field} ${normalized.toUpperCase()} (${value.map(bind).join(', ')})`
    }
    if (normalized === 'between') {
      if (!Array.isArray(value) || value.length !== 2) throw new Error('Mutation BETWEEN requires exactly two values.')
      return `${field} BETWEEN ${bind(value[0])} AND ${bind(value[1])}`
    }
    return `${field} ${normalized.toUpperCase()} ${bind(value)}`
  }
  const visit = (filter: MutationWhere): string => {
    if (Array.isArray(filter)) {
      if (filter.length === 0) throw new Error('Mutation plans require a non-empty filter.')
      return filter.map(predicate).join(' and ')
    }
    if ('and' in filter || 'or' in filter) {
      const operator = 'and' in filter ? 'and' : 'or'
      const children = 'and' in filter ? filter.and : filter.or
      if (children.length === 0) throw new Error('Mutation plans require a non-empty filter.')
      return `(${children.map(visit).join(` ${operator} `)})`
    }
    return predicate(filter)
  }
  return { sql: visit(where), parameters }
}

function guaranteedFilterColumns(where: MutationWhere): Set<string> {
  if (Array.isArray(where)) return new Set(where.map((entry) => typeof entry.column === 'string' ? entry.column : ''))
  if ('and' in where) return new Set(where.and.flatMap((entry) => [...guaranteedFilterColumns(entry)]))
  if ('or' in where) {
    const branches = where.or.map(guaranteedFilterColumns)
    if (branches.length === 0) return new Set()
    return new Set([...branches[0]].filter((column) => branches.slice(1).every((branch) => branch.has(column))))
  }
  return new Set([typeof where.column === 'string' ? where.column : ''])
}

function assertRequiredFilters(plan: MutationPlan, policy: MutationPolicy): void {
  const required = policy.requiredFilters?.[plan.table] ?? []
  if (required.length === 0) return
  if (plan.operation === 'insert') {
    for (const row of plan.rows) for (const column of required) {
      if (!Object.hasOwn(row, column)) throw new Error(`Missing required mutation value: ${plan.table}.${column}`)
    }
    return
  }
  const filtered = guaranteedFilterColumns(plan.where)
  for (const column of required) if (!filtered.has(column)) throw new Error(`Missing required filter: ${plan.table}.${column}`)
}

function guardedWhere(plan: UpdatePlan | DeletePlan): MutationWhere {
  if (!plan.optimisticLock) return plan.where
  const base: QueryFilter = Array.isArray(plan.where) ? { and: plan.where } : plan.where
  return { and: [base, { column: plan.optimisticLock.column, op: '=', value: plan.optimisticLock.value }] }
}

export function validateMutationExecution(policy: MutationPolicy, execute: boolean, approvalToken: string | undefined, confirmFingerprint?: string, expectedFingerprint?: string): void {
  if (policy.allowWrites !== true) throw new Error('Mutation plans require allowWrites: true in the selected profile.')
  if (execute && !approvalToken) throw new Error('An approval token is required to execute a mutation.')
  if (execute && (!confirmFingerprint || confirmFingerprint !== expectedFingerprint)) throw new Error('Mutation execution requires the matching preview fingerprint.')
}

export function compileMutationPlan(plan: MutationPlan, policy: MutationPolicy): CompiledMutation {
  assertMutationOperation(plan)
  assertTable(plan.table, policy)
  if (plan.operation === 'delete' && policy.allowDelete !== true) throw new Error('Delete plans require allowDelete: true in the selected profile.')
  const maximum = maximumAffectedRows(policy)
  if (plan.operation === 'insert') {
    if (!Array.isArray(plan.rows) || plan.rows.length === 0) throw new Error('Insert plans require at least one row.')
    if (plan.rows.length > maximum) throw new Error(`Insert plan exceeds the affected-row limit of ${maximum}.`)
    for (const row of plan.rows) mutationRecord(row, 'Insert row')
    assertRequiredFilters(plan, policy)
    const columns = Object.keys(plan.rows[0])
    if (columns.length === 0) throw new Error('Insert rows require at least one column.')
    for (const column of columns) assertColumn(plan.table, column, policy)
    const expected = [...columns].sort().join('\0')
    for (const row of plan.rows) {
      if (Object.keys(row).sort().join('\0') !== expected) throw new Error('All insert rows must contain the same columns.')
    }
    const parameters = plan.rows.flatMap((row) => columns.map((column) => mutationValue(row[column])))
    const tuple = `(${columns.map(() => '?').join(', ')})`
    return { operation: plan.operation, table: plan.table, sql: `insert into ${identifier(plan.table)} (${columns.map(identifier).join(', ')}) values ${plan.rows.map(() => tuple).join(', ')}`, parameters, maximumAffectedRows: maximum }
  }
  if (!plan.where) throw new Error(`${plan.operation} plans require a non-empty filter.`)
  assertRequiredFilters(plan, policy)
  const where = compileWhere(guardedWhere(plan), plan.table, policy)
  if (plan.operation === 'update') {
    const entries = Object.entries(mutationRecord(plan.set, 'Update set'))
    if (entries.length === 0) throw new Error('Update plans require at least one changed column.')
    for (const [column] of entries) assertColumn(plan.table, column, policy)
    const assignments = entries.map(([column]) => `${identifier(column)} = ?`).join(', ')
    const parameters = [...entries.map(([, value]) => mutationValue(value)), ...where.parameters, maximum + 1]
    return { operation: plan.operation, table: plan.table, sql: `update ${identifier(plan.table)} set ${assignments} where ${where.sql} limit ?`, parameters, maximumAffectedRows: maximum }
  }
  return { operation: plan.operation, table: plan.table, sql: `delete from ${identifier(plan.table)} where ${where.sql} limit ?`, parameters: [...where.parameters, maximum + 1], maximumAffectedRows: maximum }
}

export function validateMutationSchema(plan: MutationPlan, tables: ObservedTable[]): void {
  assertMutationOperation(plan)
  const table = tables.find((entry) => entry.name === plan.table)
  if (!table) throw new Error(`Unknown table in observed schema: ${plan.table}`)
  const known = new Set(table.columns.map((column) => column.name))
  const assertKnown = (column: string) => { if (!known.has(column)) throw new Error(`Unknown column in ${plan.table}: ${column}`) }
  const visitWhere = (where: MutationWhere): void => {
    if (Array.isArray(where)) return where.forEach((entry) => visitWhere(entry))
    if ('and' in where) return where.and.forEach(visitWhere)
    if ('or' in where) return where.or.forEach(visitWhere)
    if (typeof where.column !== 'string') throw new Error('Mutation filters require a column name.')
    assertKnown(where.column)
  }
  if (plan.operation === 'insert') for (const row of plan.rows) Object.keys(row).forEach(assertKnown)
  else {
    if (plan.operation === 'update') Object.keys(plan.set).forEach(assertKnown)
    visitWhere(plan.where)
    if (plan.optimisticLock) assertKnown(plan.optimisticLock.column)
  }
}

export async function previewMutation(db: DatabaseClient, plan: MutationPlan, policy: MutationPolicy, profileName = 'default') {
  const compiled = compileMutationPlan(plan, policy)
  const planFingerprint = mutationPlanFingerprint(profileName, plan, policy)
  if (plan.operation === 'insert') return { operation: plan.operation, table: plan.table, estimatedRows: plan.rows.length, maximumAffectedRows: compiled.maximumAffectedRows, exceedsLimit: false, planFingerprint }
  const where = compileWhere(guardedWhere(plan), plan.table, policy)
  const result = await db.execute(`select count(*) as affected_rows from ${identifier(plan.table)} where ${where.sql}`, where.parameters)
  const estimatedRows = Number(result.rows[0]?.affected_rows ?? 0)
  return { operation: plan.operation, table: plan.table, estimatedRows, maximumAffectedRows: compiled.maximumAffectedRows, exceedsLimit: estimatedRows > compiled.maximumAffectedRows, planFingerprint }
}

function isMissingIdempotencyStore(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ER_NO_SUCH_TABLE')
}

function validateIdempotencyKey(plan: MutationPlan, key: string | undefined): void {
  if (plan.operation === 'insert' && !key) throw new Error('Insert execution requires an idempotency key.')
  if (key && (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(key) || key.length > 255)) {
    throw new Error('Idempotency key must be 1-255 characters using letters, numbers, dot, underscore, colon, or hyphen.')
  }
}

function parseStoredMutationResult(value: unknown): MutationExecutionResult {
  if (!value || typeof value !== 'object') throw new Error('The previous idempotent mutation stored an invalid result.')
  const result = value as Record<string, unknown>
  if (!['insert', 'update', 'delete'].includes(String(result.operation)) || typeof result.table !== 'string' || typeof result.affectedRows !== 'number') {
    throw new Error('The previous idempotent mutation stored an invalid result.')
  }
  return {
    operation: result.operation as MutationPlan['operation'], table: result.table, affectedRows: result.affectedRows,
    ...(typeof result.insertId === 'number' ? { insertId: result.insertId } : {}),
  }
}

export async function executeMutation(db: DatabaseClient, plan: MutationPlan, policy: MutationPolicy, options: MutationExecutionOptions = {}): Promise<MutationExecutionResult> {
  const profileName = options.profileName ?? 'default'
  if (profileName.length < 1 || profileName.length > 255) throw new Error('Profile name must be 1-255 characters for idempotent execution.')
  const planFingerprint = mutationPlanFingerprint(profileName, plan, policy)
  validateMutationExecution(policy, true, options.approvalToken, options.confirmFingerprint, planFingerprint)
  validateIdempotencyKey(plan, options.idempotencyKey)
  const compiled = compileMutationPlan(plan, policy)
  const executeTransaction = () => db.transaction(async (transaction) => {
    let ownerToken: string | undefined
    if (options.idempotencyKey) {
      ownerToken = randomUUID()
      const claim = await transaction.execute(`insert ignore into \`__sakura_database_idempotency\`
        (profile_name, idempotency_key, plan_fingerprint, owner_token)
        values (?, ?, ?, ?)`, [profileName, options.idempotencyKey, planFingerprint, ownerToken])
      if (claim.affectedRows !== 1) {
        const record = (await transaction.execute(`select plan_fingerprint, result_json
          from \`__sakura_database_idempotency\` where profile_name = ? and idempotency_key = ?`, [profileName, options.idempotencyKey])).rows[0]
        if (!record || record.plan_fingerprint !== planFingerprint) throw new Error('Idempotency key was already used for a different mutation plan.')
        if (record.result_json === null || record.result_json === undefined) throw new Error('The previous idempotent mutation did not store a result.')
        const stored = typeof record.result_json === 'string' ? JSON.parse(record.result_json) : record.result_json
        return { ...parseStoredMutationResult(stored), idempotentReplay: true }
      }
    }
    const result = await transaction.execute(compiled.sql, compiled.parameters)
    const affectedRows = result.affectedRows ?? 0
    if (affectedRows > compiled.maximumAffectedRows) throw new Error(`Mutation exceeded the affected-row limit of ${compiled.maximumAffectedRows}; transaction rolled back.`)
    if (plan.operation !== 'insert' && plan.optimisticLock && affectedRows === 0) throw new Error('The target row changed since preview; transaction rolled back.')
    const mutationResult = { operation: plan.operation, table: plan.table, affectedRows, insertId: result.insertId }
    if (options.idempotencyKey && ownerToken) {
      await transaction.execute(`update \`__sakura_database_idempotency\` set result_json = ?
        where profile_name = ? and idempotency_key = ? and owner_token = ?`, [JSON.stringify(mutationResult), profileName, options.idempotencyKey, ownerToken])
      return { ...mutationResult, idempotentReplay: false }
    }
    return mutationResult
  })
  try {
    return await executeTransaction()
  } catch (error) {
    if (!options.idempotencyKey || !isMissingIdempotencyStore(error) || !db.ensureIdempotencyStore) throw error
    await db.ensureIdempotencyStore()
    return executeTransaction()
  }
}
