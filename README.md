# sakura-database-skill

A universal database skill and TypeScript CLI for AI agents.

Connect to local and remote MySQL, MariaDB, PostgreSQL, and SQLite databases. Discover schemas, execute bounded parameterized query plans, inspect `EXPLAIN` plans, analyze indexes and foreign keys, and check health through one policy-governed interface.

## How It Works

The AI agent interprets the user's request and builds a structured Query Plan from observed schema metadata. The CLI and MCP server remain deterministic: they validate, execute, mask, paginate, and audit the request without implementing a second natural-language parser.

```mermaid
flowchart TD
    U["User request"] --> A["AI Agent + Database Skill"]
    A --> D["Discover real schema"]
    D --> P["Build minimal Query Plan"]
    P --> I{"Interface"}
    I --> CLI["TypeScript CLI"]
    I --> MCP["MCP server"]
    CLI --> S["Shared safety layer"]
    MCP --> S

    S --> Q["Parameterized queries<br/>pagination + EXPLAIN"]
    S --> G["Read-only policy<br/>limits + timeout + masking + audit"]
    S --> M["Schema + indexes<br/>foreign keys + statistics"]

    Q --> C["Database connectors"]
    G --> C
    M --> C
    C --> MY["MySQL"]
    C --> MA["MariaDB"]
    C --> PG["PostgreSQL"]
    C --> SQ["SQLite read-only"]
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
export DB_DIALECT=mysql
export DATABASE_URL='mysql://readonly:password@localhost:3306/app'

npm run db-agent -- health
npm run db-agent -- stats
npm run db-agent -- discover --table orders
npm run db-agent -- summary --table orders
npm run db-agent -- indexes --table orders
npm run db-agent -- relations --table orders
npm run db-agent -- explain --sql 'select id from orders where customer_id = 42 limit 100'
```

Raw SQL is read-only and must include a `LIMIT` unless it is an aggregate. Prefer a Query Plan for dynamic values.

Assess a query before execution when it may scan a large table:

```bash
npm run db-agent -- assess --sql 'select id from orders where customer_id = 42 limit 100'
npm run db-agent -- query --check --sql 'select id from orders where customer_id = 42 limit 100'
```

`assess` runs `EXPLAIN` and labels cost risk. `query --check` blocks high-risk scans unless `--allow-scan` is supplied after review. Query Plan results include `page.hasMore` and `page.nextOffset` when another page is available.

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

The CLI validates identifiers and operators, verifies tables and columns against the observed schema, binds values through Kysely, caps the result size, and masks sensitive fields such as passwords, tokens, emails, phones, resumes, and medical data. `--include-sensitive` also requires `allowSensitive: true` in the selected profile.

Query Plans also support nested `and`/`or` filters, `is null`, `is not null`, `between`, `not in`, controlled inner and left joins, `count`/`sum`/`avg`/`min`/`max`, grouping, and `having`. Raw SQL is parsed into an AST and must remain a single read-only query.

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
      "allowRawSql": false,
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

Audit events are written as JSON Lines with duration and a one-way query fingerprint, without SQL parameter values. Production profiles require `--approve` by default. MySQL, MariaDB, and PostgreSQL sessions enable database-side read-only protection and query timeouts; SQLite files are opened read-only.

## MCP Server

The stdio MCP server exposes read-only tools for health, statistics, discovery, schema summaries, indexes, foreign-key relations, Query Plans, `EXPLAIN`, and cost assessment.

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

GitHub Actions runs the suite against real PostgreSQL, MySQL, and MariaDB services. Local integration tests are skipped unless `TEST_POSTGRES_URL`, `TEST_MYSQL_URL`, or `TEST_MARIADB_URL` is configured.
