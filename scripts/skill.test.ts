import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('skill teaches the controlled schema-change workflow', async () => {
  const skill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8')
  for (const instruction of ['database_permissions', 'database_schema_plan', 'confirmSchemaState', 'destructiveConfirmation', 'backupReference']) {
    assert.match(skill, new RegExp(instruction), `SKILL.md must explain ${instruction}`)
  }
  assert.match(skill, /MySQL DDL auto-commits/i)
  assert.match(skill, /never invent.*backup/i)
})
