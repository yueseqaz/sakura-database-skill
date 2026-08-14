import { createHash } from 'node:crypto'
import type { DatabaseClient } from './database.js'
import { assertUserTable, type Policy } from './core.js'
import { hasPrivilege, permissions, type MySqlPrivilege, type PermissionReport } from './permissions.js'

type Scalar = string | number | boolean | null
type ColumnType = 'tinyint' | 'smallint' | 'mediumint' | 'int' | 'bigint' | 'decimal' | 'float' | 'double' | 'boolean' |
  'char' | 'varchar' | 'text' | 'mediumtext' | 'longtext' | 'binary' | 'varbinary' | 'blob' | 'mediumblob' | 'longblob' |
  'date' | 'time' | 'datetime' | 'timestamp' | 'year' | 'json' | 'enum'

export interface ColumnDefinition {
  name: string
  type: ColumnType
  length?: number
  precision?: number
  scale?: number
  unsigned?: boolean
  nullable?: boolean
  autoIncrement?: boolean
  default?: Scalar | 'CURRENT_TIMESTAMP'
  onUpdateCurrentTimestamp?: boolean
  enumValues?: string[]
  comment?: string
}

export interface IndexDefinition { name: string; columns: string[]; unique?: boolean }
export interface ForeignKeyDefinition {
  name: string
  columns: string[]
  referencedTable: string
  referencedColumns: string[]
  onDelete?: 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'NO ACTION'
  onUpdate?: 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'NO ACTION'
}

export type AlterTableChange =
  | { action: 'addColumn'; column: ColumnDefinition; after?: string; first?: boolean }
  | { action: 'modifyColumn'; column: ColumnDefinition }
  | { action: 'renameColumn'; from: string; to: string }
  | { action: 'dropColumn'; column: string }
  | { action: 'addIndex'; index: IndexDefinition }
  | { action: 'dropIndex'; index: string }
  | { action: 'addForeignKey'; foreignKey: ForeignKeyDefinition }
  | { action: 'dropForeignKey'; foreignKey: string }

export type SchemaPlan =
  | { operation: 'createDatabase'; database: string; charset?: string; collation?: string }
  | { operation: 'dropDatabase'; database: string }
  | { operation: 'createTable'; table: string; columns: ColumnDefinition[]; primaryKey?: string[]; indexes?: IndexDefinition[]; foreignKeys?: ForeignKeyDefinition[]; engine?: 'InnoDB' }
  | { operation: 'alterTable'; table: string; changes: AlterTableChange[] }
  | { operation: 'renameTable'; table: string; newTable: string }
  | { operation: 'dropTable'; table: string }

export interface CompiledSchemaPlan {
  operation: SchemaPlan['operation']
  target: string
  sql: string
  requiredPrivileges: MySqlPrivilege[]
}

export interface SchemaPreview {
  operation: SchemaPlan['operation']
  target: string
  sql: string
  risk: 'low' | 'medium' | 'high' | 'critical'
  reasons: string[]
  requiredPrivileges: MySqlPrivilege[]
  missingPrivileges: MySqlPrivilege[]
  estimatedRows: number
  estimatedBytes: number
  dependencies: Array<Record<string, unknown>>
  backupRequired: boolean
  reversible: boolean
  reverseStatements: string[]
  destructiveConfirmation?: string
  planFingerprint: string
  schemaStateFingerprint: string
  observedAt: string
}

export interface SchemaExecutionOptions {
  approvalToken?: string
  confirmFingerprint?: string
  confirmSchemaState?: string
  destructiveConfirmation?: string
  backupReference?: string
  profileName?: string
}

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || value.length > 64) throw new Error(`Unsafe schema identifier: ${value}`)
  return `\`${value}\``
}

function literal(value: Scalar): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Schema default numbers must be finite.')
    return String(value)
  }
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`
}

function validatePositiveInteger(value: number | undefined, label: string, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${label} must be an integer between 1 and ${maximum}.`)
  return value
}

function compileColumn(column: ColumnDefinition): string {
  const name = identifier(column.name)
  const length = validatePositiveInteger(column.length, 'Column length', 65_535)
  const precision = validatePositiveInteger(column.precision, 'Decimal precision', 65)
  const scale = column.scale === undefined ? undefined : validatePositiveInteger(column.scale + 1, 'Decimal scale plus one', 31)! - 1
  let type: string = column.type.toUpperCase()
  if (column.type === 'enum') {
    if (!column.enumValues?.length || column.enumValues.length > 255) throw new Error('ENUM columns require 1-255 enumValues.')
    type += `(${column.enumValues.map(literal).join(', ')})`
  } else if (['char', 'varchar', 'binary', 'varbinary'].includes(column.type)) {
    if (!length) throw new Error(`${column.type} columns require length.`)
    type += `(${length})`
  } else if (column.type === 'decimal') {
    if (!precision) throw new Error('DECIMAL columns require precision.')
    if (scale !== undefined && scale >= precision) throw new Error('Decimal scale must be smaller than precision.')
    type += scale === undefined ? `(${precision})` : `(${precision}, ${scale})`
  } else if (length !== undefined) {
    if (!['tinyint', 'smallint', 'mediumint', 'int', 'bigint'].includes(column.type)) throw new Error(`Length is not supported for ${column.type}.`)
    type += `(${length})`
  }
  if (column.unsigned) {
    if (!['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'decimal', 'float', 'double'].includes(column.type)) throw new Error(`UNSIGNED is not supported for ${column.type}.`)
    type += ' UNSIGNED'
  }
  if (column.autoIncrement) {
    if (!['tinyint', 'smallint', 'mediumint', 'int', 'bigint'].includes(column.type)) throw new Error('AUTO_INCREMENT requires an integer type.')
    type += ' AUTO_INCREMENT'
  }
  type += column.nullable === false ? ' NOT NULL' : ' NULL'
  if (Object.hasOwn(column, 'default')) {
    if (column.default === 'CURRENT_TIMESTAMP') {
      if (!['timestamp', 'datetime'].includes(column.type)) throw new Error('CURRENT_TIMESTAMP defaults require timestamp or datetime.')
      type += ' DEFAULT CURRENT_TIMESTAMP'
    } else {
      type += ` DEFAULT ${literal(column.default as Scalar)}`
    }
  }
  if (column.onUpdateCurrentTimestamp) {
    if (!['timestamp', 'datetime'].includes(column.type)) throw new Error('ON UPDATE CURRENT_TIMESTAMP requires timestamp or datetime.')
    type += ' ON UPDATE CURRENT_TIMESTAMP'
  }
  if (column.comment !== undefined) {
    if (column.comment.length > 1024) throw new Error('Column comments cannot exceed 1024 characters.')
    type += ` COMMENT ${literal(column.comment)}`
  }
  return `${name} ${type}`
}

function compileIndex(index: IndexDefinition): string {
  if (!index.columns.length) throw new Error('Indexes require at least one column.')
  return `${index.unique ? 'UNIQUE ' : ''}KEY ${identifier(index.name)} (${index.columns.map(identifier).join(', ')})`
}

function compileForeignKey(foreignKey: ForeignKeyDefinition): string {
  if (!foreignKey.columns.length || foreignKey.columns.length !== foreignKey.referencedColumns.length) {
    throw new Error('Foreign keys require matching local and referenced column counts.')
  }
  assertUserTable(foreignKey.referencedTable)
  let sql = `CONSTRAINT ${identifier(foreignKey.name)} FOREIGN KEY (${foreignKey.columns.map(identifier).join(', ')}) REFERENCES ${identifier(foreignKey.referencedTable)} (${foreignKey.referencedColumns.map(identifier).join(', ')})`
  if (foreignKey.onDelete) sql += ` ON DELETE ${foreignKey.onDelete}`
  if (foreignKey.onUpdate) sql += ` ON UPDATE ${foreignKey.onUpdate}`
  return sql
}

function target(plan: SchemaPlan): string {
  return 'database' in plan ? plan.database : plan.table
}

function assertTablePolicy(table: string, policy: Policy): void {
  assertUserTable(table)
  identifier(table)
  if (policy.allowedTables && !policy.allowedTables.includes(table)) throw new Error(`Table is not allowed by policy: ${table}`)
  if (policy.deniedTables?.includes(table)) throw new Error(`Table is denied by policy: ${table}`)
}

function assertTargetPolicy(plan: SchemaPlan, policy: Policy): void {
  if (policy.allowSchemaChanges !== true) throw new Error('Schema changes require allowSchemaChanges: true in the selected profile.')
  if ('database' in plan) {
    identifier(plan.database)
    if (policy.allowedDatabases && !policy.allowedDatabases.includes(plan.database)) throw new Error(`Database is not allowed by policy: ${plan.database}`)
    if (plan.operation === 'createDatabase' && policy.allowCreateDatabase !== true) throw new Error('Database creation requires allowCreateDatabase: true in the selected profile.')
  } else {
    const tables = plan.operation === 'renameTable' ? [plan.table, plan.newTable] : [plan.table]
    for (const table of tables) assertTablePolicy(table, policy)
  }
  const destructive = plan.operation === 'dropTable' || plan.operation === 'dropDatabase' ||
    (plan.operation === 'alterTable' && plan.changes.some((change) => change.action === 'dropColumn'))
  if (destructive && policy.allowDrop !== true) throw new Error('Drop operations require allowDrop: true in the selected profile.')
}

function assertColumnPolicy(table: string, column: string, policy: Policy): void {
  const allowed = policy.allowedColumns?.[table]
  if (allowed && !allowed.includes(column)) throw new Error(`Column is not allowed by policy: ${table}.${column}`)
  if (policy.deniedColumns?.[table]?.includes(column)) throw new Error(`Column is denied by policy: ${table}.${column}`)
}

export function compileSchemaPlan(plan: SchemaPlan, policy: Policy): CompiledSchemaPlan {
  assertTargetPolicy(plan, policy)
  if (plan.operation === 'createDatabase') {
    const charset = plan.charset ?? 'utf8mb4'
    if (!/^[A-Za-z0-9_]+$/.test(charset)) throw new Error('Unsafe database charset.')
    if (plan.collation && !/^[A-Za-z0-9_]+$/.test(plan.collation)) throw new Error('Unsafe database collation.')
    return { operation: plan.operation, target: plan.database, sql: `CREATE DATABASE ${identifier(plan.database)} CHARACTER SET ${charset}${plan.collation ? ` COLLATE ${plan.collation}` : ''}`, requiredPrivileges: ['CREATE'] }
  }
  if (plan.operation === 'dropDatabase') return { operation: plan.operation, target: plan.database, sql: `DROP DATABASE ${identifier(plan.database)}`, requiredPrivileges: ['DROP'] }
  if (plan.operation === 'createTable') {
    if (!plan.columns.length) throw new Error('CreateTablePlan requires at least one column.')
    const names = new Set<string>()
    for (const column of plan.columns) {
      if (names.has(column.name)) throw new Error(`Duplicate column: ${column.name}`)
      names.add(column.name)
      assertColumnPolicy(plan.table, column.name, policy)
    }
    const autoIncrementing = plan.columns.filter((column) => column.autoIncrement)
    if (autoIncrementing.length > 1) throw new Error('CreateTablePlan supports at most one AUTO_INCREMENT column.')
    for (const name of plan.primaryKey ?? []) if (!names.has(name)) throw new Error(`Primary-key column is not defined: ${name}`)
    const indexNames = new Set<string>()
    for (const index of plan.indexes ?? []) {
      if (index.name.toUpperCase() === 'PRIMARY') throw new Error('Use primaryKey instead of an index named PRIMARY.')
      if (indexNames.has(index.name)) throw new Error(`Duplicate index: ${index.name}`)
      indexNames.add(index.name)
      for (const name of index.columns) if (!names.has(name)) throw new Error(`Index column is not defined: ${name}`)
    }
    if (autoIncrementing.length) {
      const name = autoIncrementing[0].name
      const indexedFirst = plan.primaryKey?.[0] === name || (plan.indexes ?? []).some((index) => index.columns[0] === name)
      if (!indexedFirst) throw new Error(`AUTO_INCREMENT column must be the first column in a key: ${name}`)
    }
    for (const key of plan.foreignKeys ?? []) {
      assertTablePolicy(key.referencedTable, policy)
      for (const name of key.columns) if (!names.has(name)) throw new Error(`Foreign-key column is not defined: ${name}`)
      for (const name of key.referencedColumns) assertColumnPolicy(key.referencedTable, name, policy)
    }
    const definitions = [
      ...plan.columns.map(compileColumn),
      ...(plan.primaryKey?.length ? [`PRIMARY KEY (${plan.primaryKey.map(identifier).join(', ')})`] : []),
      ...(plan.indexes ?? []).map(compileIndex),
      ...(plan.foreignKeys ?? []).map(compileForeignKey),
    ]
    const required: MySqlPrivilege[] = ['CREATE']
    if (plan.foreignKeys?.length) required.push('REFERENCES')
    return { operation: plan.operation, target: plan.table, sql: `CREATE TABLE ${identifier(plan.table)} (${definitions.join(', ')}) ENGINE=${plan.engine ?? 'InnoDB'}`, requiredPrivileges: required }
  }
  if (plan.operation === 'renameTable') {
    return { operation: plan.operation, target: plan.table, sql: `RENAME TABLE ${identifier(plan.table)} TO ${identifier(plan.newTable)}`, requiredPrivileges: ['ALTER', 'DROP', 'CREATE', 'INSERT'] }
  }
  if (plan.operation === 'dropTable') return { operation: plan.operation, target: plan.table, sql: `DROP TABLE ${identifier(plan.table)}`, requiredPrivileges: ['DROP'] }
  if (!plan.changes.length) throw new Error('AlterTablePlan requires at least one change.')
  const required = new Set<MySqlPrivilege>(['ALTER'])
  const clauses = plan.changes.map((change) => {
    if (change.action === 'addColumn') {
      assertColumnPolicy(plan.table, change.column.name, policy)
      if (change.after && change.first) throw new Error('An added column cannot use both after and first.')
      return `ADD COLUMN ${compileColumn(change.column)}${change.first ? ' FIRST' : change.after ? ` AFTER ${identifier(change.after)}` : ''}`
    }
    if (change.action === 'modifyColumn') { assertColumnPolicy(plan.table, change.column.name, policy); return `MODIFY COLUMN ${compileColumn(change.column)}` }
    if (change.action === 'renameColumn') { assertColumnPolicy(plan.table, change.from, policy); assertColumnPolicy(plan.table, change.to, policy); return `RENAME COLUMN ${identifier(change.from)} TO ${identifier(change.to)}` }
    if (change.action === 'dropColumn') { assertColumnPolicy(plan.table, change.column, policy); return `DROP COLUMN ${identifier(change.column)}` }
    if (change.action === 'addIndex') {
      for (const column of change.index.columns) assertColumnPolicy(plan.table, column, policy)
      required.add('INDEX')
      return `ADD ${compileIndex(change.index)}`
    }
    if (change.action === 'dropIndex') { required.add('INDEX'); return `DROP INDEX ${identifier(change.index)}` }
    if (change.action === 'addForeignKey') {
      assertTablePolicy(change.foreignKey.referencedTable, policy)
      for (const column of change.foreignKey.columns) assertColumnPolicy(plan.table, column, policy)
      for (const column of change.foreignKey.referencedColumns) assertColumnPolicy(change.foreignKey.referencedTable, column, policy)
      required.add('REFERENCES')
      return `ADD ${compileForeignKey(change.foreignKey)}`
    }
    required.add('REFERENCES')
    return `DROP FOREIGN KEY ${identifier(change.foreignKey)}`
  })
  return { operation: plan.operation, target: plan.table, sql: `ALTER TABLE ${identifier(plan.table)} ${clauses.join(', ')}`, requiredPrivileges: [...required] }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  return JSON.stringify(value)
}

export function schemaPlanFingerprint(profileName: string, plan: SchemaPlan, policy: Policy): string {
  const effectivePolicy = {
    allowSchemaChanges: policy.allowSchemaChanges === true,
    allowDrop: policy.allowDrop === true,
    allowCreateDatabase: policy.allowCreateDatabase === true,
    allowedTables: policy.allowedTables ? [...policy.allowedTables].sort() : undefined,
    deniedTables: policy.deniedTables ? [...policy.deniedTables].sort() : undefined,
    allowedDatabases: policy.allowedDatabases ? [...policy.allowedDatabases].sort() : undefined,
  }
  return createHash('sha256').update(canonicalJson({ profileName, plan, policy: effectivePolicy })).digest('hex')
}

async function observedState(db: DatabaseClient, plan: SchemaPlan) {
  if ('database' in plan) {
    const [schema, stats] = await Promise.all([
      db.execute(`select schema_name as schema_name, default_character_set_name as default_character_set_name, default_collation_name as default_collation_name from information_schema.schemata where schema_name = ?`, [plan.database]),
      db.execute(`select coalesce(sum(table_rows), 0) estimated_rows, coalesce(sum(data_length + index_length), 0) estimated_bytes from information_schema.tables where table_schema = ?`, [plan.database]),
    ])
    return { kind: 'database' as const, schema: schema.rows, stats: stats.rows[0] ?? {}, dependencies: [] as Array<Record<string, unknown>> }
  }
  const referencedTables = plan.operation === 'createTable'
    ? (plan.foreignKeys ?? []).map((key) => key.referencedTable)
    : plan.operation === 'alterTable'
      ? plan.changes.filter((change): change is Extract<AlterTableChange, { action: 'addForeignKey' }> => change.action === 'addForeignKey').map((change) => change.foreignKey.referencedTable)
      : []
  const names = [...new Set(plan.operation === 'renameTable' ? [plan.table, plan.newTable] : [plan.table, ...referencedTables])]
  const [tables, columns, indexes, dependencies] = await Promise.all([
    db.execute(`select table_name as table_name, engine as engine, table_rows as table_rows, data_length as data_length, index_length as index_length from information_schema.tables where table_schema = database() and table_name in (${names.map(() => '?').join(', ')}) order by table_name`, names),
    db.execute(`select table_name as table_name, column_name as column_name, column_type as column_type, is_nullable as is_nullable, column_default as column_default, extra as extra, ordinal_position as ordinal_position from information_schema.columns where table_schema = database() and table_name in (${names.map(() => '?').join(', ')}) order by table_name, ordinal_position`, names),
    db.execute(`select table_name as table_name, index_name as index_name, column_name as column_name, non_unique as non_unique, seq_in_index as seq_in_index from information_schema.statistics where table_schema = database() and table_name in (${names.map(() => '?').join(', ')}) order by table_name, index_name, seq_in_index`, names),
    db.execute(`select table_name as table_name, column_name as column_name, constraint_name as constraint_name, referenced_table_name as referenced_table_name, referenced_column_name as referenced_column_name from information_schema.key_column_usage where table_schema = database() and (table_name = ? or referenced_table_name = ?) and referenced_table_name is not null order by table_name, constraint_name, ordinal_position`, [plan.table, plan.table]),
  ])
  return { kind: 'table' as const, tables: tables.rows, columns: columns.rows, indexes: indexes.rows, dependencies: dependencies.rows }
}

function validateObservedState(plan: SchemaPlan, state: Awaited<ReturnType<typeof observedState>>): void {
  if (state.kind !== 'table') return
  const tableExists = (name: string) => state.tables.some((row) => String(row.table_name) === name)
  const columns = (name: string) => new Set(state.columns.filter((row) => String(row.table_name) === name).map((row) => String(row.column_name)))
  if (plan.operation === 'createTable') {
    for (const key of plan.foreignKeys ?? []) {
      if (!tableExists(key.referencedTable)) throw new Error(`Referenced table does not exist: ${key.referencedTable}`)
      const referenced = columns(key.referencedTable)
      for (const column of key.referencedColumns) if (!referenced.has(column)) throw new Error(`Referenced column does not exist: ${key.referencedTable}.${column}`)
    }
    return
  }
  if (plan.operation !== 'alterTable') return
  const knownColumns = columns(plan.table)
  const knownIndexes = new Set(state.indexes.filter((row) => String(row.table_name) === plan.table).map((row) => String(row.index_name)))
  const knownForeignKeys = new Set(state.dependencies.filter((row) => String(row.table_name) === plan.table).map((row) => String(row.constraint_name)))
  for (const change of plan.changes) {
    if (change.action === 'addColumn') {
      if (knownColumns.has(change.column.name)) throw new Error(`Column already exists: ${plan.table}.${change.column.name}`)
      if (change.after && !knownColumns.has(change.after)) throw new Error(`AFTER column does not exist: ${plan.table}.${change.after}`)
      knownColumns.add(change.column.name)
    } else if (change.action === 'modifyColumn') {
      if (!knownColumns.has(change.column.name)) throw new Error(`Column does not exist: ${plan.table}.${change.column.name}`)
    } else if (change.action === 'renameColumn') {
      if (!knownColumns.has(change.from)) throw new Error(`Column does not exist: ${plan.table}.${change.from}`)
      if (knownColumns.has(change.to)) throw new Error(`Rename target column already exists: ${plan.table}.${change.to}`)
      knownColumns.delete(change.from)
      knownColumns.add(change.to)
    } else if (change.action === 'dropColumn') {
      if (!knownColumns.has(change.column)) throw new Error(`Column does not exist: ${plan.table}.${change.column}`)
      knownColumns.delete(change.column)
    } else if (change.action === 'addIndex') {
      if (knownIndexes.has(change.index.name)) throw new Error(`Index already exists: ${plan.table}.${change.index.name}`)
      for (const column of change.index.columns) if (!knownColumns.has(column)) throw new Error(`Index column does not exist: ${plan.table}.${column}`)
      knownIndexes.add(change.index.name)
    } else if (change.action === 'dropIndex') {
      if (change.index.toUpperCase() === 'PRIMARY') throw new Error('Dropping a primary key is not supported by DropIndex; use a future dedicated primary-key plan.')
      if (!knownIndexes.has(change.index)) throw new Error(`Index does not exist: ${plan.table}.${change.index}`)
      knownIndexes.delete(change.index)
    } else if (change.action === 'addForeignKey') {
      if (knownForeignKeys.has(change.foreignKey.name)) throw new Error(`Foreign key already exists: ${plan.table}.${change.foreignKey.name}`)
      for (const column of change.foreignKey.columns) if (!knownColumns.has(column)) throw new Error(`Foreign-key column does not exist: ${plan.table}.${column}`)
      if (!tableExists(change.foreignKey.referencedTable)) throw new Error(`Referenced table does not exist: ${change.foreignKey.referencedTable}`)
      const referenced = columns(change.foreignKey.referencedTable)
      for (const column of change.foreignKey.referencedColumns) if (!referenced.has(column)) throw new Error(`Referenced column does not exist: ${change.foreignKey.referencedTable}.${column}`)
      knownForeignKeys.add(change.foreignKey.name)
    } else {
      if (!knownForeignKeys.has(change.foreignKey)) throw new Error(`Foreign key does not exist: ${plan.table}.${change.foreignKey}`)
      knownForeignKeys.delete(change.foreignKey)
    }
  }
}

function missingPrivileges(report: PermissionReport, compiled: CompiledSchemaPlan, plan: SchemaPlan): MySqlPrivilege[] {
  if (compiled.operation === 'createDatabase') return compiled.requiredPrivileges.filter((privilege) => !report.privileges.some((entry) => entry.scope === 'global' && entry.privilege === privilege))
  if (plan.operation === 'renameTable') {
    return [...new Set([
      ...(['ALTER', 'DROP'] as MySqlPrivilege[]).filter((privilege) => !hasPrivilege(report, privilege, plan.table)),
      ...(['CREATE', 'INSERT'] as MySqlPrivilege[]).filter((privilege) => !hasPrivilege(report, privilege, plan.newTable)),
    ])]
  }
  if (plan.operation === 'createTable' || plan.operation === 'alterTable') {
    const foreignKeys = plan.operation === 'createTable'
      ? plan.foreignKeys ?? []
      : plan.changes.filter((change): change is Extract<AlterTableChange, { action: 'addForeignKey' }> => change.action === 'addForeignKey').map((change) => change.foreignKey)
    const base = compiled.requiredPrivileges.filter((privilege) => privilege !== 'REFERENCES' && !hasPrivilege(report, privilege, compiled.target))
    if (foreignKeys.some((key) => !hasPrivilege(report, 'REFERENCES', key.referencedTable))) base.push('REFERENCES')
    return [...new Set(base)]
  }
  return compiled.requiredPrivileges.filter((privilege) => !hasPrivilege(report, privilege, compiled.target))
}

function reverseStatements(plan: SchemaPlan): string[] {
  if (plan.operation === 'createDatabase') return [`DROP DATABASE ${identifier(plan.database)}`]
  if (plan.operation === 'createTable') return [`DROP TABLE ${identifier(plan.table)}`]
  if (plan.operation === 'renameTable') return [`RENAME TABLE ${identifier(plan.newTable)} TO ${identifier(plan.table)}`]
  if (plan.operation !== 'alterTable') return []
  return [...plan.changes].reverse().flatMap((change) => {
    if (change.action === 'addColumn') return [`ALTER TABLE ${identifier(plan.table)} DROP COLUMN ${identifier(change.column.name)}`]
    if (change.action === 'renameColumn') return [`ALTER TABLE ${identifier(plan.table)} RENAME COLUMN ${identifier(change.to)} TO ${identifier(change.from)}`]
    if (change.action === 'addIndex') return [`ALTER TABLE ${identifier(plan.table)} DROP INDEX ${identifier(change.index.name)}`]
    if (change.action === 'addForeignKey') return [`ALTER TABLE ${identifier(plan.table)} DROP FOREIGN KEY ${identifier(change.foreignKey.name)}`]
    return []
  })
}

function destructiveConfirmation(plan: SchemaPlan): string | undefined {
  if (plan.operation === 'dropTable') return `DROP TABLE ${plan.table}`
  if (plan.operation === 'dropDatabase') return `DROP DATABASE ${plan.database}`
  if (plan.operation === 'alterTable') {
    const columns = plan.changes.filter((change): change is Extract<AlterTableChange, { action: 'dropColumn' }> => change.action === 'dropColumn').map((change) => change.column)
    if (columns.length) return `ALTER TABLE ${plan.table} DROP ${columns.join(',')}`
  }
  return undefined
}

export async function previewSchemaPlan(db: DatabaseClient, plan: SchemaPlan, policy: Policy, profileName = 'default'): Promise<SchemaPreview> {
  const compiled = compileSchemaPlan(plan, policy)
  const [state, report] = await Promise.all([observedState(db, plan), permissions(db)])
  validateObservedState(plan, state)
  if (!('database' in plan) && report.database && policy.allowedDatabases && !policy.allowedDatabases.includes(report.database)) throw new Error(`Database is not allowed by policy: ${report.database}`)
  if (plan.operation === 'dropDatabase' && report.database !== plan.database) throw new Error('DropDatabasePlan must target the database selected by the profile connection URL.')
  const existing = state.kind === 'database' ? state.schema.length > 0 : state.tables.some((row) => String(row.table_name) === compiled.target)
  if (['createDatabase', 'createTable'].includes(plan.operation) && existing) throw new Error(`${plan.operation === 'createDatabase' ? 'Database' : 'Table'} already exists: ${compiled.target}`)
  if (!['createDatabase', 'createTable'].includes(plan.operation) && !existing) throw new Error(`${'database' in plan ? 'Database' : 'Table'} does not exist: ${compiled.target}`)
  if (plan.operation === 'renameTable' && state.kind === 'table' && state.tables.some((row) => String(row.table_name) === plan.newTable)) throw new Error(`Rename target already exists: ${plan.newTable}`)
  const rowStats: Record<string, unknown> = state.kind === 'database' ? state.stats : state.tables.find((row) => String(row.table_name) === compiled.target) ?? {}
  const estimatedRows = Number(rowStats.estimated_rows ?? rowStats.table_rows ?? 0)
  const estimatedBytes = Number(rowStats.estimated_bytes ?? (Number(rowStats.data_length ?? 0) + Number(rowStats.index_length ?? 0)))
  const dropsData = plan.operation === 'dropTable' || plan.operation === 'dropDatabase' || (plan.operation === 'alterTable' && plan.changes.some((change) => ['dropColumn', 'modifyColumn'].includes(change.action)))
  const rebuildsLargeTable = plan.operation === 'alterTable' && estimatedRows >= 100_000
  const risk: SchemaPreview['risk'] = dropsData ? 'critical' : rebuildsLargeTable ? 'high' : ['alterTable', 'renameTable'].includes(plan.operation) ? 'medium' : 'low'
  const reasons = [
    ...(dropsData ? ['The plan can permanently remove or truncate data.'] : []),
    ...(rebuildsLargeTable ? [`The target contains approximately ${estimatedRows} rows and the change may lock or rebuild it.`] : []),
    ...(state.dependencies.length ? [`The target participates in ${state.dependencies.length} foreign-key column relationship(s).`] : []),
    ...(['alterTable', 'renameTable'].includes(plan.operation) ? ['MySQL may lock the table while applying this structural change.'] : []),
  ]
  const reverse = reverseStatements(plan)
  const expectedReverseCount = plan.operation === 'alterTable' ? plan.changes.length : ['createDatabase', 'createTable', 'renameTable'].includes(plan.operation) ? 1 : 0
  const confirmation = destructiveConfirmation(plan)
  return {
    operation: plan.operation,
    target: compiled.target,
    sql: compiled.sql,
    risk,
    reasons,
    requiredPrivileges: compiled.requiredPrivileges,
    missingPrivileges: missingPrivileges(report, compiled, plan),
    estimatedRows,
    estimatedBytes,
    dependencies: state.dependencies,
    backupRequired: dropsData,
    reversible: expectedReverseCount > 0 && reverse.length === expectedReverseCount,
    reverseStatements: reverse,
    ...(confirmation ? { destructiveConfirmation: confirmation } : {}),
    planFingerprint: schemaPlanFingerprint(profileName, plan, policy),
    schemaStateFingerprint: createHash('sha256').update(canonicalJson(state)).digest('hex'),
    observedAt: new Date().toISOString(),
  }
}

export async function executeSchemaPlan(db: DatabaseClient, plan: SchemaPlan, policy: Policy, options: SchemaExecutionOptions = {}) {
  const profileName = options.profileName ?? 'default'
  if (!options.approvalToken) throw new Error('An approval token is required to execute a schema change.')
  const expectedPlan = schemaPlanFingerprint(profileName, plan, policy)
  if (options.confirmFingerprint !== expectedPlan) throw new Error('Schema execution requires the matching preview fingerprint.')
  const preview = await previewSchemaPlan(db, plan, policy, profileName)
  if (options.confirmSchemaState !== preview.schemaStateFingerprint) throw new Error('The schema state changed or execution is missing the matching schema state fingerprint.')
  if (preview.destructiveConfirmation && options.destructiveConfirmation !== preview.destructiveConfirmation) {
    throw new Error(`Destructive confirmation is required. Confirm exactly: ${preview.destructiveConfirmation}`)
  }
  if (preview.backupRequired && !options.backupReference?.trim()) throw new Error('Destructive schema execution requires a backup reference confirming that a verified backup exists.')
  if (preview.missingPrivileges.length) throw new Error(`The account is missing MySQL privilege(s): ${preview.missingPrivileges.join(', ')}`)
  if (!db.executeAdministrative) throw new Error('The database connector does not support schema changes.')
  const result = await db.executeAdministrative(preview.sql)
  return {
    mode: 'executed' as const,
    operation: plan.operation,
    target: preview.target,
    affectedRows: result.affectedRows ?? 0,
    risk: preview.risk,
    planFingerprint: preview.planFingerprint,
    schemaStateBefore: preview.schemaStateFingerprint,
    reverseStatements: preview.reverseStatements,
    warning: preview.backupRequired ? 'MySQL DDL auto-commits; restore removed data from a verified backup.' : 'MySQL DDL auto-commits and was not executed inside a rollback-capable transaction.',
  }
}
