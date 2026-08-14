import type { DatabaseClient } from './database.js'

export type MySqlPrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'CREATE' | 'ALTER' | 'DROP' | 'INDEX' | 'REFERENCES'

export interface PermissionReport {
  account: string
  database: string | null
  privileges: Array<{ privilege: string; scope: 'global' | 'database' | 'table'; table?: string }>
  capabilities: {
    query: boolean
    insert: boolean
    update: boolean
    delete: boolean
    createTable: boolean
    alterTable: boolean
    dropTable: boolean
    createDatabase: boolean
    index: boolean
    foreignKey: boolean
  }
}

const permissionCache = new WeakMap<DatabaseClient, Promise<PermissionReport>>()
const relevantPrivileges: MySqlPrivilege[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'INDEX', 'REFERENCES']

function grantee(account: string): string {
  const separator = account.lastIndexOf('@')
  const user = separator < 0 ? account : account.slice(0, separator)
  const host = separator < 0 ? '%' : account.slice(separator + 1)
  const quote = (value: string) => value.replaceAll("'", "''")
  return `'${quote(user)}'@'${quote(host)}'`
}

export function hasPrivilege(report: PermissionReport, privilege: MySqlPrivilege, table?: string): boolean {
  return report.privileges.some((entry) => entry.privilege === privilege && (
    entry.scope === 'global' || entry.scope === 'database' || (table !== undefined && entry.table === table)
  ))
}

function unquoteIdentifier(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('`') && trimmed.endsWith('`') ? trimmed.slice(1, -1).replaceAll('``', '`') : trimmed
}

function privilegesFromGrants(rows: Array<Record<string, unknown>>, database: string | null): PermissionReport['privileges'] {
  const privileges: PermissionReport['privileges'] = []
  for (const row of rows) {
    const grant = String(Object.values(row)[0] ?? '')
    const match = /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i.exec(grant)
    if (!match) continue
    const granted = match[1].toUpperCase() === 'ALL PRIVILEGES'
      ? relevantPrivileges
      : match[1].split(',').map((entry) => entry.trim().toUpperCase()).filter((entry): entry is MySqlPrivilege => relevantPrivileges.includes(entry as MySqlPrivilege))
    const grantTarget = match[2]
    let scope: 'global' | 'database' | 'table'
    let table: string | undefined
    if (grantTarget === '*.*') {
      scope = 'global'
    } else {
      const separator = grantTarget.indexOf('.')
      if (separator < 0) continue
      const schema = unquoteIdentifier(grantTarget.slice(0, separator))
      if (database !== schema) continue
      const object = unquoteIdentifier(grantTarget.slice(separator + 1))
      scope = object === '*' ? 'database' : 'table'
      if (scope === 'table') table = object
    }
    for (const privilege of granted) privileges.push({ privilege, scope, ...(table ? { table } : {}) })
  }
  return privileges
}

function hasAnyPrivilege(report: PermissionReport, privilege: MySqlPrivilege): boolean {
  return report.privileges.some((entry) => entry.privilege === privilege)
}

async function loadPermissions(db: DatabaseClient): Promise<PermissionReport> {
  const identity = await db.execute('select current_user() as account, database() as database_name')
  const account = String(identity.rows[0]?.account ?? '')
  const database = identity.rows[0]?.database_name == null ? null : String(identity.rows[0].database_name)
  const owner = grantee(account)
  const { rows } = await db.execute(`
    select privilege_type as privilege, 'global' as scope_name, null as table_name
    from information_schema.user_privileges where grantee = ?
    union all
    select privilege_type as privilege, 'database' as scope_name, null as table_name
    from information_schema.schema_privileges where grantee = ? and table_schema = database()
    union all
    select privilege_type as privilege, 'table' as scope_name, table_name as table_name
    from information_schema.table_privileges where grantee = ? and table_schema = database()
  `, [owner, owner, owner])
  let privileges = rows.map((row) => ({
    privilege: String(row.privilege).toUpperCase(),
    scope: String(row.scope_name) as 'global' | 'database' | 'table',
    ...(row.table_name == null ? {} : { table: String(row.table_name) }),
  }))
  if (!privileges.some((entry) => relevantPrivileges.includes(entry.privilege as MySqlPrivilege))) {
    privileges = privilegesFromGrants((await db.execute('show grants for current_user()')).rows, database)
  }
  const report: PermissionReport = { account, database, privileges, capabilities: {} as PermissionReport['capabilities'] }
  report.capabilities = {
    query: hasAnyPrivilege(report, 'SELECT'),
    insert: hasAnyPrivilege(report, 'INSERT'),
    update: hasAnyPrivilege(report, 'UPDATE'),
    delete: hasAnyPrivilege(report, 'DELETE'),
    createTable: hasAnyPrivilege(report, 'CREATE'),
    alterTable: hasAnyPrivilege(report, 'ALTER'),
    dropTable: hasAnyPrivilege(report, 'DROP'),
    createDatabase: privileges.some((entry) => entry.scope === 'global' && entry.privilege === 'CREATE'),
    index: hasAnyPrivilege(report, 'INDEX'),
    foreignKey: hasAnyPrivilege(report, 'REFERENCES'),
  }
  return report
}

export function permissions(db: DatabaseClient, refresh = false): Promise<PermissionReport> {
  if (refresh) permissionCache.delete(db)
  const existing = permissionCache.get(db)
  if (existing) return existing
  const pending = loadPermissions(db)
  permissionCache.set(db, pending)
  return pending
}
