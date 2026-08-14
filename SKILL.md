---
name: database-agent
description: Use when Codex needs to connect to local or remote MySQL, PostgreSQL, or SQLite databases; discover schemas, inspect relations and indexes, run constrained read-only queries, diagnose query plans, create migration or backup previews, or invoke the database MCP server. Use for safe database analysis and data lookup with credentials supplied through environment variables or configured profiles.
---

# Database Agent

Use the TypeScript CLI or MCP server for database work. Convert natural-language requests into a minimal `SelectPlan`; do not pass user values through raw SQL.

## Workflow

1. Run `discover --table <name>` or `relations --table <name>` before querying an unfamiliar schema.
2. State the selected table, columns, filters, expected row count, and sensitivity before executing.
3. Use a Query Plan for lookups and filters. Use raw `query --sql` only for bounded, read-only expert analysis.
4. Run `explain` before a potentially expensive query. Check `indexes` when it scans unexpectedly.
5. Return only fields needed for the task. Keep default masking enabled.

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
npm run db-agent -- plan --file plan.json --profile development
npm run db-agent -- explain --sql 'select id from orders where customer_id = 42 limit 50'
```

## Profiles And Security

- Use profiles for remote or production databases. Credentials must be supplied by `urlEnv`, not committed to a profile.
- A production profile requires `--approve <ticket-or-token>` unless its policy explicitly disables that requirement.
- Use a least-privilege read-only account. Do not expose passwords, salts, tokens, phone numbers, email addresses, resumes, medical data, or raw audit logs unless explicitly authorized.
- SSH tunnels are configured per profile and are closed after the command.

## Operations

`migrate`, `backup`, and `restore` generate only approval-gated previews. They never execute an operational change. Do not weaken this boundary to satisfy a request.

## MCP

Run `npm run mcp` for stdio integration. Call `database_query_plan` for data access, not a free-form SQL tool. MCP and CLI use the same profile policy, masking, timeout, and audit controls.
