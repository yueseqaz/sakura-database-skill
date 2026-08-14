# sakura-database-skill

A universal database skill and TypeScript CLI for AI agents.

Connect AI agents to local and remote MySQL databases through a focused mysql2 runtime. Discover schemas, execute bounded Query Plans, and preview or transactionally execute policy-controlled Mutation Plans through one audited interface.

## How It Works

The AI agent interprets the user's request and builds a structured Query Plan from observed schema metadata. The CLI and MCP server remain deterministic: they validate, execute, mask, paginate, and audit the request without implementing a second natural-language parser.

```mermaid
flowchart TD
    U["User request"] --> A["AI Agent + Database Skill"]
    A --> D["Discover real schema"]
    D --> P["Build Query or Mutation Plan"]
    P --> I{"Interface"}
    I --> CLI["TypeScript CLI"]
    I --> MCP["MCP server"]
    CLI --> S["Shared safety layer"]
    MCP --> S

    S --> Q["Parameterized queries<br/>pagination + EXPLAIN"]
    S --> W["Previewed mutations<br/>approval + transaction + rollback"]
    S --> G["Policy enforcement<br/>limits + timeout + masking + audit"]
    S --> M["Schema + indexes<br/>foreign keys + statistics"]

    Q --> C["mysql2 connector"]
    W --> C
    G --> C
    M --> C
    C --> MY["MySQL read or transactional write session"]
    C --> SSH["Local, remote, or SSH tunnel"]
```

## Install

```bash
npm install
npm run db-agent -- --help
npm run db-agent -- doctor
```

## Quick start

Use a least-privilege database account. Credentials belong in an environment variable or secret manager, never in source control.

```bash
export DATABASE_URL='mysql://readonly:password@localhost:3306/app'

npm run db-agent -- health
npm run db-agent -- stats
npm run db-agent -- discover --table orders
npm run db-agent -- summary --table orders
npm run db-agent -- indexes --table orders
npm run db-agent -- relations --table orders
```

Create a Query Plan before data access. The CLI intentionally does not accept raw SQL. Assess or explain the same plan before execution when it may scan a large table:

```bash
npm run db-agent -- assess --file plan.json
npm run db-agent -- explain --file plan.json
npm run db-agent -- plan --file plan.json
```

`assess` compiles the validated plan, runs `EXPLAIN`, and labels cost risk. Query Plan results include `page.hasMore` and `page.nextOffset` when another page is available.

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

The CLI validates identifiers and operators, verifies tables and columns against the observed schema, binds values through mysql2, caps the result size, and masks sensitive fields such as passwords, tokens, emails, phones, resumes, and medical data. `--include-sensitive` also requires `allowSensitive: true` in the selected profile.

Query Plans also support nested `and`/`or` filters, `is null`, `is not null`, `between`, `not in`, controlled inner and left joins, `count`/`sum`/`avg`/`min`/`max`, grouping, and `having`. There is no arbitrary SQL execution path.

## Mutation Plans

Use one structured Mutation Plan for insert, update, or delete. Preview is the default and does not modify data:

```json
{
  "operation": "update",
  "table": "orders",
  "set": { "status": "closed" },
  "where": { "column": "tenant_id", "op": "=", "value": 42 }
}
```

```bash
npm run db-agent -- mutate --file mutation.json --profile writer
npm run db-agent -- mutate --file mutation.json --profile writer --execute --approve TICKET-1024
```

The profile must set `allowWrites: true`. Every execution requires an approval token. Update and delete require non-empty filters, are limited by `maxAffectedRows`, and roll back if the actual affected row count exceeds that limit. Delete additionally requires `allowDelete: true`. Existing table, column, and required-filter policies apply to mutations.

## Example Agent Workflow

Suppose a user asks:

> Find the most recent orders for customer 42. Return only the order ID, status, and creation time, do not expose email addresses, and return at most 20 rows.

The agent first discovers the `orders` schema. It then creates the following plan from columns that actually exist in the database:

```json
{
  "table": "orders",
  "columns": ["id", "status", "created_at"],
  "where": [{ "column": "customer_id", "op": "=", "value": 42 }],
  "orderBy": [{ "column": "created_at", "direction": "desc" }],
  "limit": 20
}
```

The CLI or MCP server validates the identifiers and operator, binds `42` as a parameter, applies the configured row limit, executes the read-only query, masks any sensitive result fields, records an audit event, and returns pagination metadata:

```json
{
  "rows": [
    {
      "id": 1082,
      "status": "shipped",
      "created_at": "2026-08-13T09:20:00Z"
    }
  ],
  "rowCount": 1,
  "page": {
    "returned": 1,
    "hasMore": false
  }
}
```

The order-specific interpretation belongs to the AI agent and the live schema. No order, customer, recruiting, or other business-domain rules are hard-coded in the CLI.

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
      "allowWrites": true,
      "allowDelete": false,
      "maxAffectedRows": 20,
      "allowSensitive": false,
      "allowedTables": ["orders", "customers"],
      "deniedColumns": {
        "customers": ["password_hash", "access_token"]
      },
      "requiredFilters": {
        "orders": ["tenant_id"]
      },
      "maxEstimatedRows": 10000,
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

Audit events are written as JSON Lines with duration, affected or returned row count, and a one-way statement fingerprint, without parameter values. Production profiles require `--approve` by default. Reads use database-side read-only sessions. Approved mutations run in a transaction and roll back on failure or limit violations.

## MCP Server

The stdio MCP server exposes health, statistics, discovery, schema summaries, indexes, foreign-key relations, Query Plans, Mutation Plans, `EXPLAIN`, and cost assessment. Query, explain, and assess tools accept SelectPlan; `database_mutation_plan` accepts InsertPlan, UpdatePlan, or DeletePlan. No tool accepts raw SQL.

```bash
DB_AGENT_CONFIG="/absolute/path/to/profiles.json" npm run mcp
```

Use the same profiles and policy controls as the CLI. The accompanying [`SKILL.md`](SKILL.md) directs an AI agent to inspect the real schema and turn a natural-language request into a constrained Query Plan before calling the server. Natural-language interpretation stays in the agent rather than being duplicated by CLI heuristics.

## Development

```bash
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

GitHub Actions runs the suite against a real MySQL service. Local integration tests are skipped unless `TEST_MYSQL_URL` is configured.
