---
name: database-agent
description: Use when Codex needs to inspect a PostgreSQL, MySQL, or SQLite schema; run a safe read-only SQL query; inspect an EXPLAIN plan; or check database connectivity and health. Use for database analysis, table discovery, SQL troubleshooting, and data lookup when credentials are supplied through environment variables.
---

# Database Agent

Use the bundled TypeScript CLI for SQL database discovery and read-only analysis. Kysely provides the dialect-specific connection layer. MongoDB and Redis are out of scope.

## Setup

Run commands from this skill directory. Install dependencies once:

```bash
npm install
```

Set `DATABASE_URL` and `DB_DIALECT` (`postgres`, `mysql`, or `sqlite`). Use a least-privilege, read-only database account. Do not place credentials in prompts, code, logs, or command history.

## Workflow

1. Start with `discover` when table or column names are unknown.
2. Use `query` only for one read-only statement. State the query and expected result before running it.
3. Run `explain` before expensive or unfamiliar queries. Do not use `EXPLAIN ANALYZE` against production unless the user explicitly requests it.
4. Use `health` to verify a connection without accessing application tables.
5. Return only the needed fields and avoid exposing sensitive values. Summarize query results instead of dumping data where possible.

```bash
npm run db-agent -- discover
npm run db-agent -- query --sql 'select id, status from orders limit 20'
npm run db-agent -- explain --sql 'select id from orders where customer_id = 42'
npm run db-agent -- health
```

## Safety Rules

- The CLI accepts only one `SELECT`, `WITH ... SELECT`, or `EXPLAIN` statement; data-modifying keywords are rejected.
- Never weaken this restriction merely to complete a task. Writes, DDL, migrations, credential rotation, backup, restore, and permission changes require a separately designed, approval-gated tool.
- Keep queries bounded with `LIMIT`; inspect a plan first when a query may scan a large table.
- Treat production as sensitive: use a read-only account, minimize columns, and do not return secrets or personal data unless the user has explicitly authorized access.
- Do not use string interpolation to construct SQL from user values. This MVP takes SQL as a complete read-only statement; add parameter binding through a structured query-plan interface before supporting dynamic values.

## Connection Examples

```bash
export DB_DIALECT=postgres
export DATABASE_URL='postgres://readonly:password@localhost:5432/app'

export DB_DIALECT=mysql
export DATABASE_URL='mysql://readonly:password@localhost:3306/app'

export DB_DIALECT=sqlite
export DATABASE_URL='sqlite:///absolute/path/to/app.db'
```

Run `npm run db-agent -- --help` for the command reference.
