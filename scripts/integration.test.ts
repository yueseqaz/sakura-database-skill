import assert from 'node:assert/strict'
import test from 'node:test'
import { connect, health } from './database.js'
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
