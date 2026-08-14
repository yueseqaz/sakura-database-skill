import assert from 'node:assert/strict'
import test from 'node:test'
import type { DatabaseClient } from './database.js'
import { compileSchemaPlan, executeSchemaPlan, previewSchemaPlan, type SchemaPlan } from './schema-changes.js'

const policy = { allowSchemaChanges: true, allowDrop: true, allowCreateDatabase: true, allowedTables: ['users', 'members', 'orders'] }

function metadataDb(options: { table?: string; rows?: number; privileges?: string[] } = {}): DatabaseClient & { administrative: string[] } {
  const administrative: string[] = []
  const table = options.table
  const privileges = options.privileges ?? ['SELECT', 'INSERT', 'CREATE', 'ALTER', 'DROP', 'INDEX', 'REFERENCES']
  const db: DatabaseClient & { administrative: string[] } = {
    administrative,
    async execute(statement) {
      if (statement.includes('current_user()')) return { rows: [{ account: 'agent@localhost', database_name: 'app' }] }
      if (statement.includes('information_schema.user_privileges')) return { rows: privileges.map((privilege) => ({ privilege, scope_name: 'database', table_name: null })) }
      if (statement.includes('information_schema.schemata')) return { rows: [] }
      if (statement.includes('coalesce(sum(table_rows)')) return { rows: [{ estimated_rows: 0, estimated_bytes: 0 }] }
      if (statement.includes('from information_schema.tables')) {
        assert.match(statement, /table_name as table_name/i)
        return { rows: table ? [{ table_name: table, engine: 'InnoDB', table_rows: options.rows ?? 12, data_length: 1024, index_length: 256 }] : [] }
      }
      if (statement.includes('from information_schema.columns')) return { rows: table ? [
        { table_name: table, column_name: 'id', column_type: 'int', is_nullable: 'NO', column_default: null, extra: 'auto_increment', ordinal_position: 1 },
        { table_name: table, column_name: 'name', column_type: 'varchar(100)', is_nullable: 'NO', column_default: null, extra: '', ordinal_position: 2 },
      ] : [] }
      if (statement.includes('from information_schema.statistics')) return { rows: table ? [{ table_name: table, index_name: 'PRIMARY', column_name: 'id', non_unique: 0, seq_in_index: 1 }] : [] }
      if (statement.includes('from information_schema.key_column_usage')) return { rows: [] }
      return { rows: [] }
    },
    async executeAdministrative(statement) { administrative.push(statement); return { rows: [], affectedRows: 0 } },
    async transaction(run) { return run({ execute: db.execute }) },
    async destroy() {},
  }
  return db
}

test('compiles structured create-table and alter-table plans without raw SQL', () => {
  assert.deepEqual(compileSchemaPlan({
    operation: 'createTable', table: 'users',
    columns: [
      { name: 'id', type: 'bigint', unsigned: true, nullable: false, autoIncrement: true },
      { name: 'name', type: 'varchar', length: 100, nullable: false },
    ],
    primaryKey: ['id'], indexes: [{ name: 'idx_users_name', columns: ['name'] }],
  }, policy), {
    operation: 'createTable', target: 'users',
    sql: 'CREATE TABLE `users` (`id` BIGINT UNSIGNED AUTO_INCREMENT NOT NULL, `name` VARCHAR(100) NOT NULL, PRIMARY KEY (`id`), KEY `idx_users_name` (`name`)) ENGINE=InnoDB',
    requiredPrivileges: ['CREATE'],
  })
  assert.equal(compileSchemaPlan({
    operation: 'alterTable', table: 'users', changes: [
      { action: 'addColumn', column: { name: 'avatar_url', type: 'varchar', length: 500, nullable: true }, after: 'name' },
      { action: 'addIndex', index: { name: 'idx_users_avatar', columns: ['avatar_url'] } },
    ],
  }, policy).sql, 'ALTER TABLE `users` ADD COLUMN `avatar_url` VARCHAR(500) NULL AFTER `name`, ADD KEY `idx_users_avatar` (`avatar_url`)')
})

test('compiles every supported database, table, index, and foreign-key operation', () => {
  const databasePolicy = { allowSchemaChanges: true, allowCreateDatabase: true, allowDrop: true, allowedDatabases: ['sandbox'] }
  assert.equal(compileSchemaPlan({ operation: 'createDatabase', database: 'sandbox', charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }, databasePolicy).sql,
    'CREATE DATABASE `sandbox` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci')
  assert.equal(compileSchemaPlan({ operation: 'dropDatabase', database: 'sandbox' }, databasePolicy).sql, 'DROP DATABASE `sandbox`')
  assert.equal(compileSchemaPlan({ operation: 'renameTable', table: 'users', newTable: 'members' }, policy).sql, 'RENAME TABLE `users` TO `members`')
  assert.equal(compileSchemaPlan({ operation: 'dropTable', table: 'users' }, policy).sql, 'DROP TABLE `users`')

  const altered = compileSchemaPlan({ operation: 'alterTable', table: 'orders', changes: [
    { action: 'modifyColumn', column: { name: 'name', type: 'varchar', length: 200, nullable: false } },
    { action: 'renameColumn', from: 'legacy_code', to: 'external_code' },
    { action: 'dropColumn', column: 'obsolete' },
    { action: 'addIndex', index: { name: 'idx_orders_name', columns: ['name'], unique: true } },
    { action: 'dropIndex', index: 'idx_orders_legacy' },
    { action: 'addForeignKey', foreignKey: { name: 'fk_orders_user', columns: ['user_id'], referencedTable: 'users', referencedColumns: ['id'], onDelete: 'CASCADE' } },
    { action: 'dropForeignKey', foreignKey: 'fk_orders_legacy' },
  ] }, { ...policy, allowedTables: ['orders', 'users'] })
  assert.match(altered.sql, /MODIFY COLUMN `name` VARCHAR\(200\) NOT NULL/)
  assert.match(altered.sql, /RENAME COLUMN `legacy_code` TO `external_code`/)
  assert.match(altered.sql, /DROP COLUMN `obsolete`/)
  assert.match(altered.sql, /ADD UNIQUE KEY `idx_orders_name` \(`name`\)/)
  assert.match(altered.sql, /DROP INDEX `idx_orders_legacy`/)
  assert.match(altered.sql, /ADD CONSTRAINT `fk_orders_user` FOREIGN KEY \(`user_id`\) REFERENCES `users` \(`id`\) ON DELETE CASCADE/)
  assert.match(altered.sql, /DROP FOREIGN KEY `fk_orders_legacy`/)
  assert.deepEqual(altered.requiredPrivileges, ['ALTER', 'INDEX', 'REFERENCES'])
})

test('blocks schema changes and destructive plans unless explicitly enabled', () => {
  assert.throws(() => compileSchemaPlan({ operation: 'createTable', table: 'users', columns: [{ name: 'id', type: 'int' }] }, {}), /allowSchemaChanges/)
  assert.throws(() => compileSchemaPlan({ operation: 'dropTable', table: 'users' }, { allowSchemaChanges: true }), /allowDrop/)
  assert.throws(() => compileSchemaPlan({ operation: 'createDatabase', database: 'app2' }, { allowSchemaChanges: true }), /allowCreateDatabase/)
  assert.throws(() => compileSchemaPlan({ operation: 'createTable', table: 'other', columns: [{ name: 'id', type: 'int' }] }, policy), /not allowed by policy/)
  assert.throws(() => compileSchemaPlan({ operation: 'alterTable', table: 'users', changes: [{ action: 'dropColumn', column: 'secret' }] }, { ...policy, deniedColumns: { users: ['secret'] } }), /denied by policy/)
})

test('previews risk, impact, permission gaps, recovery, and schema state', async () => {
  const db = metadataDb({ table: 'users', rows: 250_000, privileges: ['SELECT', 'ALTER'] })
  const plan: SchemaPlan = { operation: 'alterTable', table: 'users', changes: [{ action: 'dropColumn', column: 'name' }] }
  const preview = await previewSchemaPlan(db, plan, policy, 'production')
  assert.equal(preview.risk, 'critical')
  assert.equal(preview.estimatedRows, 250_000)
  assert.equal(preview.backupRequired, true)
  assert.equal(preview.reversible, false)
  assert.equal(preview.destructiveConfirmation, 'ALTER TABLE users DROP name')
  assert.equal(preview.missingPrivileges.length, 0)
  assert.equal(preview.planFingerprint.length, 64)
  assert.equal(preview.schemaStateFingerprint.length, 64)
})

test('reports missing MySQL privileges before attempting DDL', async () => {
  const db = metadataDb({ privileges: ['SELECT'] })
  const preview = await previewSchemaPlan(db, {
    operation: 'createTable', table: 'users', columns: [{ name: 'id', type: 'int', nullable: false }], primaryKey: ['id'],
  }, policy, 'restricted')
  assert.deepEqual(preview.missingPrivileges, ['CREATE'])
  assert.equal(db.administrative.length, 0)
})

test('rejects stale or incomplete approval and executes the exact preview once confirmed', async () => {
  const db = metadataDb({ table: 'users' })
  const plan: SchemaPlan = { operation: 'renameTable', table: 'users', newTable: 'members' }
  const preview = await previewSchemaPlan(db, plan, policy, 'writer')
  await assert.rejects(() => executeSchemaPlan(db, plan, policy, { profileName: 'writer', approvalToken: 'ticket', confirmFingerprint: preview.planFingerprint }), /schema state fingerprint/i)
  const executed = await executeSchemaPlan(db, plan, policy, {
    profileName: 'writer', approvalToken: 'ticket', confirmFingerprint: preview.planFingerprint, confirmSchemaState: preview.schemaStateFingerprint,
  })
  assert.equal(executed.mode, 'executed')
  assert.deepEqual(db.administrative, ['RENAME TABLE `users` TO `members`'])
  assert.deepEqual(executed.reverseStatements, ['RENAME TABLE `members` TO `users`'])
})

test('requires the exact destructive confirmation phrase', async () => {
  const db = metadataDb({ table: 'users' })
  const plan: SchemaPlan = { operation: 'dropTable', table: 'users' }
  const preview = await previewSchemaPlan(db, plan, policy, 'writer')
  await assert.rejects(() => executeSchemaPlan(db, plan, policy, {
    profileName: 'writer', approvalToken: 'ticket', confirmFingerprint: preview.planFingerprint, confirmSchemaState: preview.schemaStateFingerprint,
  }), /Confirm exactly: DROP TABLE users/)
})
