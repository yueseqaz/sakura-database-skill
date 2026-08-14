# sakura-database-skill

A universal database skill and TypeScript CLI for AI agents.

Connect to local and remote MySQL, PostgreSQL, and SQLite databases. Discover schemas, execute bounded parameterized query plans, inspect `EXPLAIN` plans, analyze indexes and foreign keys, and check health through one policy-governed interface.

## Install

```bash
npm install
npm run db-agent -- --help
```

## Quick start

Use a least-privilege database account. Credentials belong in an environment variable or secret manager, never in source control.

```bash
export DB_DIALECT=mysql
export DATABASE_URL='mysql://readonly:password@localhost:3306/app'

npm run db-agent -- health
npm run db-agent -- stats
npm run db-agent -- discover --table orders
npm run db-agent -- indexes --table orders
npm run db-agent -- relations --table orders
npm run db-agent -- explain --sql 'select id from orders where customer_id = 42 limit 100'
```

Raw SQL is read-only and must include a `LIMIT` unless it is an aggregate. Prefer a Query Plan for dynamic values.

## Query Plans

Create `plan.json`:

```json
{
  "table": "orders",
  "columns": ["id", "status", "created_at"],
  "where": [{ "column": "customer_id", "op": "=", "value": 42 }],
  "orderBy": [{ "column": "created_at", "direction": "desc" }],
  "limit": 50
}
```

Then execute it:

```bash
npm run db-agent -- plan --file plan.json
```

The CLI validates identifiers and operators, binds values through Kysely, caps the result size, and masks sensitive fields such as passwords, tokens, emails, phones, resumes, and medical data. Use `--include-sensitive` only with explicit authorization.

## Profiles, Auditing, And SSH

Create a profile file:

```bash
npm run db-agent -- config init
```

It creates `~/.config/sakura-database-skill/profiles.json`. A profile can reference a credential environment variable, set result/time limits, configure a JSONL audit log, require approval for production, and define an SSH tunnel.

```json
{
  "profiles": {
    "production": {
      "dialect": "mysql",
      "urlEnv": "PRODUCTION_DATABASE_URL",
      "environment": "production",
      "maxRows": 50,
      "timeoutMs": 5000,
      "requireApproval": true,
      "sshTunnel": {
        "host": "bastion.example.com",
        "user": "readonly",
        "remoteHost": "database.internal",
        "remotePort": 3306,
        "localPort": 13306
      }
    }
  }
}
```

```bash
npm run db-agent -- profile list
npm run db-agent -- health --profile production --approve change-ticket-123
```

Audit events are written as JSON Lines, without query parameter values. Production profiles require `--approve` by default.

## Guarded Operations

Migrations, backup, and restore are intentionally preview-only. They never write to a database:

```bash
npm run db-agent -- migrate --file migrations/2026-01-add-index.sql --profile production --approve change-ticket-123
npm run db-agent -- backup --destination backups/app.sql --profile production --approve change-ticket-123
```

Route an approved preview to a separate executor with organization-specific controls. Do not convert these commands into direct production writes without approval, recovery, and audit requirements.

## MCP Server

The stdio MCP server exposes read-only tools: `database_health`, `database_discover`, `database_query_plan`, and `database_explain`.

```bash
DB_AGENT_CONFIG="/absolute/path/to/profiles.json" npm run mcp
```

Use the same profiles and policy controls as the CLI. The accompanying [`SKILL.md`](SKILL.md) directs an AI agent to turn natural-language requests into a constrained Query Plan before calling the server.

## Development

```bash
npm test
npm run typecheck
```
