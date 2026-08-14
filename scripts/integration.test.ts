import assert from 'node:assert/strict'
import test from 'node:test'
import { connect, health, query } from './database.js'
import type { DialectName } from './core.js'

const targets: Array<{ dialect: DialectName; env: string }> = [
  { dialect: 'postgres', env: 'TEST_POSTGRES_URL' },
  { dialect: 'mysql', env: 'TEST_MYSQL_URL' },
  { dialect: 'mariadb', env: 'TEST_MARIADB_URL' },
]

for (const target of targets) {
  const url = process.env[target.env]
  test(`enforces a read-only ${target.dialect} session`, { skip: !url }, async () => {
    const db = connect(target.dialect, url as string, 2_000)
    try {
      assert.deepEqual(await health(db), { ok: true })
      await assert.rejects(() => query(db, 'create table database_agent_write_probe (id integer)'), /read.?only|read only transaction/i)
    } finally {
      await db.destroy()
    }
  })
}
