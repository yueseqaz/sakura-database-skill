import assert from 'node:assert/strict'
import test from 'node:test'
import { createPool } from 'mysql2/promise'
import { connect, health } from './database.js'
import { executeSchemaPlan, previewSchemaPlan, type SchemaPlan } from './schema-changes.js'
const url = process.env.TEST_MYSQL_URL

test('enforces a read-only MySQL session', { skip: !url }, async () => {
    const db = connect('mysql', url as string, 2_000)
    try {
      assert.deepEqual(await health(db), { ok: true })
      await assert.rejects(() => db.execute('create table database_agent_write_probe (id integer)'), /read.?only|read only transaction/i)
    } finally {
      await db.destroy()
    }
})

test('previews and executes controlled DDL against real MySQL', { skip: !url }, async () => {
  const table = `schema_plan_${process.pid}`
  const db = connect('mysql', url as string, 5_000)
  const cleanup = createPool(url as string)
  const policy = { allowSchemaChanges: true, allowDrop: true, allowedTables: [table] }
  try {
    const create: SchemaPlan = { operation: 'createTable', table, columns: [
      { name: 'id', type: 'int', nullable: false, autoIncrement: true },
      { name: 'name', type: 'varchar', length: 100, nullable: false },
    ], primaryKey: ['id'] }
    const createPreview = await previewSchemaPlan(db, create, policy, 'ci')
    assert.deepEqual(createPreview.missingPrivileges, [])
    await executeSchemaPlan(db, create, policy, {
      profileName: 'ci', approvalToken: 'ci', confirmFingerprint: createPreview.planFingerprint, confirmSchemaState: createPreview.schemaStateFingerprint,
    })

    const alter: SchemaPlan = { operation: 'alterTable', table, changes: [{ action: 'addColumn', column: { name: 'active', type: 'boolean', nullable: false, default: true } }] }
    const alterPreview = await previewSchemaPlan(db, alter, policy, 'ci')
    await executeSchemaPlan(db, alter, policy, {
      profileName: 'ci', approvalToken: 'ci', confirmFingerprint: alterPreview.planFingerprint, confirmSchemaState: alterPreview.schemaStateFingerprint,
    })

    const drop: SchemaPlan = { operation: 'dropTable', table }
    const dropPreview = await previewSchemaPlan(db, drop, policy, 'ci')
    await executeSchemaPlan(db, drop, policy, {
      profileName: 'ci', approvalToken: 'ci', confirmFingerprint: dropPreview.planFingerprint, confirmSchemaState: dropPreview.schemaStateFingerprint,
      destructiveConfirmation: `DROP TABLE ${table}`,
      backupReference: 'ci-temporary-table',
    })
  } finally {
    await cleanup.query(`drop table if exists \`${table}\``)
    await cleanup.end()
    await db.destroy()
  }
})
