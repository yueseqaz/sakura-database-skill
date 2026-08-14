---
name: database-agent
description: Use when Codex needs safe access to a local or remote MySQL database for schema discovery, constrained queries, controlled data writes, permission inspection, or approved database and table structure changes.
---

# Database Agent

Use the TypeScript CLI or MCP server for MySQL work. Convert natural-language requests into a minimal `SelectPlan`, `MutationPlan`, or `SchemaPlan`. The tool does not accept raw SQL.

## Workflow

1. Run `summary` to orient within a large database, then use paginated `discover --table <name> --limit <n>` and, when needed, `relations --table <name>` before querying an unfamiliar table. Continue with `--cursor <nextCursor>` when returned.
2. State the selected table, columns, filters, expected row count, and sensitivity before executing.
3. Convert the user's request into a minimal Query Plan using the observed schema. The CLI does not interpret natural language and has no raw SQL command.
4. Run `assess --file <plan.json>` before a potentially expensive plan. Check `indexes` when it scans unexpectedly. Honor table, column, and required-filter profile policies.
5. Return only fields needed for the task. Keep default masking enabled.

For a mutation, discover the live schema first. State the target table, changed columns, filters, estimated affected rows, and whether the action inserts, updates, or deletes. Call `database_mutation_plan` without execution first. Preserve its `planFingerprint`. Execute only after the user approves that exact preview, using `execute: true`, the supplied approval token, and `confirmFingerprint`. If the plan or policy changes, preview again. Never invent an approval token or fingerprint.

For insert execution, supply a stable `idempotencyKey` derived from the user task and reuse it for every retry. Never change the key merely because a call timed out. For an update or delete that may race with another writer, include `optimisticLock` with an observed version or `updated_at` value and update the version in `set`. On `CONCURRENT_MODIFICATION`, read and preview again; never remove the lock to force the write.

For a structure change, call `database_permissions`, then preview the structured plan with `database_schema_plan`. Report the generated SQL, risk, row/storage estimate, foreign-key dependencies, missing privileges, backup requirement, and recovery statements. Execute only after the user approves the exact `planFingerprint` and `confirmSchemaState`. Supply the returned `destructiveConfirmation` exactly for data-losing plans. When `backupRequired` is true, require a real `backupReference`; never invent a backup, approval, fingerprint, state fingerprint, or confirmation phrase. MySQL DDL auto-commits and cannot be promised transaction rollback.

```json
{
  "table": "orders",
  "columns": ["id", "status"],
  "where": [{ "column": "customer_id", "op": "=", "value": 42 }],
  "limit": 50
}
```

```bash
npm run db-agent -- discover --table orders
npm run db-agent -- summary --table orders
npm run db-agent -- plan --file plan.json --profile development
npm run db-agent -- assess --file plan.json
npm run db-agent -- explain --file plan.json
npm run db-agent -- mutate --file mutation.json --profile writer
npm run db-agent -- mutate --file mutation.json --profile writer --execute --approve TICKET-1024 --confirm <planFingerprint> --idempotency-key <task-key>
npm run db-agent -- permissions --profile admin
npm run db-agent -- schema --file schema.json --profile admin
```

## Profiles And Security

- Use profiles for remote or production databases. Credentials must be supplied by `urlEnv`, not committed to a profile.
- Every mutation execution requires `--approve <ticket-or-token>` and the exact preview fingerprint through `--confirm`. Never reuse or invent approval.
- Reuse one idempotency key for all retries of an insert. Use optional idempotency for retry-sensitive updates or deletes.
- Preserve `optimisticLock` after a concurrent-modification failure; refresh the row and preview again.
- Treat `allowedTables`, `allowedColumns`, `deniedColumns`, and `requiredFilters` as hard boundaries.
- Use `--include-sensitive` only when the profile sets `allowSensitive: true` and the user explicitly authorizes disclosure.
- Prefer separate least-privilege read-only and writer profiles. Keep `allowWrites` false unless writes are required; enable `allowDelete` separately and set a small `maxAffectedRows`.
- Treat `allowSchemaChanges`, `allowCreateDatabase`, `allowDrop`, `allowedDatabases`, and `allowedTables` as independent hard boundaries. Existing project accounts are valid; never create another database account unless the user requests it.
- Never execute DDL without first previewing the same plan. Preview again after any schema drift or policy change.
- Do not expose passwords, salts, tokens, phone numbers, email addresses, resumes, medical data, or raw audit logs unless explicitly authorized.
- SSH tunnels are configured per profile and are closed after the command.
- Use only `mysql://` connection URLs. This version intentionally does not support other database engines.

## MCP

Run `npm run mcp` for stdio integration. Use `database_query_plan` for reads, `database_mutation_plan` for data writes, `database_permissions` for account capabilities, and `database_schema_plan` for DDL. MCP explain and assess tools require a SelectPlan. MCP and CLI share validation, policies, structured errors, approvals, masking, and audit controls.
