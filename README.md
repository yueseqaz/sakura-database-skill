# sakura-database-skill

A universal database skill and TypeScript CLI for AI agents.

Connect AI agents to local and remote MySQL databases through a focused mysql2 runtime. Discover schemas and account permissions, execute bounded Query Plans, preview or transactionally execute Mutation Plans, and apply approved Schema Plans through one audited interface.

## How It Works

The AI agent interprets the user's request and builds a structured Query Plan from observed schema metadata. The CLI and MCP server remain deterministic: they validate, execute, mask, paginate, and audit the request without implementing a second natural-language parser.

```mermaid
flowchart TD
    U["User request"] --> A["AI Agent + Database Skill"]
    A --> D["Discover real schema"]
    D --> P["Build Query, Mutation, or Schema Plan"]
    P --> I{"Interface"}
    I --> CLI["TypeScript CLI"]
    I --> MCP["MCP server"]
    CLI --> S["Shared safety layer"]
    MCP --> S

    S --> Q["Parameterized queries<br/>pagination + EXPLAIN"]
    S --> W["Previewed mutations<br/>approval + transaction + rollback"]
    S --> G["Policy enforcement<br/>limits + timeout + masking + audit"]
    S --> M["Schema + indexes<br/>foreign keys + statistics"]
    S --> DDL["DDL preflight<br/>permissions + risk + recovery"]

    Q --> C["mysql2 connector"]
    W --> C
    G --> C
    M --> C
    DDL --> C
    C --> MY["MySQL read or transactional write session"]
    C --> SSH["Local, remote, or SSH tunnel"]
```

## Install

```bash
npm install -g sakura-database-skill
sakura-db --help
sakura-db doctor
sakura-db-mcp
```

For repository development, use `npm install` and the `npm run db-agent -- <command>` / `npm run mcp` scripts instead.

## Quick start

Use a least-privilege database account. Credentials belong in an environment variable or secret manager, never in source control.

```bash
export DATABASE_URL='mysql://readonly:password@localhost:3306/app'

npm run db-agent -- health
npm run db-agent -- stats
npm run db-agent -- discover --table orders --limit 50
npm run db-agent -- summary --table orders
npm run db-agent -- indexes --table orders
npm run db-agent -- relations --table orders
npm run db-agent -- permissions
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

The CLI validates identifiers and operators, verifies only the plan's referenced tables and columns against the observed schema, binds values through mysql2, caps the result size, and masks sensitive fields such as passwords, tokens, emails, phones, resumes, and medical data. `--include-sensitive` also requires `allowSensitive: true` in the selected profile.

Schema discovery is paginated. `discover` returns `tables` and an opaque `nextCursor`; pass that cursor back with `--cursor` to continue. A page contains at most 100 tables, while plan validation fetches only the exact base, joined, or mutation target tables.

Query Plans also support nested `and`/`or` filters, `is null`, `is not null`, `between`, `not in`, controlled inner and left joins, `count`/`sum`/`avg`/`min`/`max`, grouping, and `having`. There is no arbitrary SQL execution path.

## Mutation Plans

Use one structured Mutation Plan for insert, update, or delete. Preview is the default and does not modify data:

```json
{
  "operation": "update",
  "table": "orders",
  "set": { "status": "closed", "version": 8 },
  "where": { "column": "tenant_id", "op": "=", "value": 42 },
  "optimisticLock": { "column": "version", "value": 7 }
}
```

```bash
npm run db-agent -- mutate --file mutation.json --profile writer
npm run db-agent -- mutate --file mutation.json --profile writer --execute --approve TICKET-1024 --confirm <planFingerprint> --idempotency-key task-9321
```

The preview returns a SHA-256 `planFingerprint` bound to the profile, complete plan values and filters, and effective write policy. Execute the unchanged plan with that fingerprint. The profile must set `allowWrites: true`; every execution requires both an approval token and the matching fingerprint. Update and delete require non-empty filters, are limited by `maxAffectedRows`, and roll back if the actual affected row count exceeds that limit. Delete additionally requires `allowDelete: true`. Existing table, column, and required-filter policies apply to mutations. The fingerprint prevents plan drift; it does not authenticate the approval token.

Insert execution also requires `--idempotency-key`. Retrying the same profile, key, and plan returns the first result with `idempotentReplay: true` without inserting again. Reusing a key for a different plan is rejected. Updates and deletes may also supply a key when the caller needs retry deduplication. Keys are execution identifiers, not secrets, and retries must reuse the original key.

The idempotency record and business mutation commit in one transaction. On first use, the tool lazily creates the reserved `__sakura_database_idempotency` table; the writer needs `CREATE` permission for that one-time setup, or an administrator can provision the table first. The table is excluded from discovery, statistics, queries, indexes, relations, and mutation plans.

`optimisticLock` is optional for update and delete. It adds an equality condition for a version or `updated_at` column. When the value changed after preview, execution rolls back with `CONCURRENT_MODIFICATION`. Read the current row and preview again instead of removing the lock. This adds no extra query; the guard is part of the mutation's existing `WHERE` clause.

## Permissions And Schema Plans

`permissions` reports the connected account, selected database, effective global/database/table privileges, and derived query, data-write, and DDL capabilities. It does not create accounts or change grants. An existing project account works as-is; MySQL remains the final permission boundary.

Schema Plans provide controlled DDL without accepting raw SQL:

- `createDatabase` and `dropDatabase`
- `createTable` with typed columns, primary key, indexes, and foreign keys
- `alterTable` with add/modify/rename/drop column, add/drop index, and add/drop foreign key changes
- `renameTable` and `dropTable`

Example `schema.json`:

```json
{
  "operation": "alterTable",
  "table": "users",
  "changes": [
    {
      "action": "addColumn",
      "column": { "name": "avatar_url", "type": "varchar", "length": 500, "nullable": true },
      "after": "username"
    },
    {
      "action": "addIndex",
      "index": { "name": "idx_users_avatar_url", "columns": ["avatar_url"] }
    }
  ]
}
```

Preview first:

```bash
npm run db-agent -- schema --file schema.json --profile admin
```

The preview checks the target and referenced objects, column/index/foreign-key conflicts, effective MySQL privileges, approximate rows and bytes from `information_schema`, and dependency metadata. It returns generated SQL, risk reasons, reverse statements when they are valid, `planFingerprint`, and `schemaStateFingerprint`. Metadata checks do not scan business rows and run only for permission or Schema Plan commands.

Execute the unchanged plan against the unchanged observed schema:

```bash
npm run db-agent -- schema --file schema.json --profile admin --execute \
  --approve TICKET-2048 --confirm <planFingerprint> --confirm-state <schemaStateFingerprint>
```

Data-losing plans additionally require the exact returned `--confirm-destructive` phrase and a real `--backup-reference`. MySQL DDL auto-commits, so the tool does not claim transactional rollback. Reverse SQL is recovery guidance, not a substitute for a verified backup; drop and potentially truncating modifications may be irreversible.

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
  "correlationId": "task-42",
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

It creates `~/.config/sakura-database-skill/profiles.json`. A profile can reference a credential environment variable, set result/time limits, configure a rotating JSONL audit log, control approval requirements, and define an SSH tunnel.

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
      "auditMaxBytes": 5242880,
      "auditRetentionFiles": 10,
      "allowWrites": true,
      "allowDelete": false,
      "allowSchemaChanges": true,
      "allowCreateDatabase": false,
      "allowDrop": false,
      "allowedDatabases": ["app"],
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

`requireApproval: true` requires `--approve` in every environment. `requireApproval: false` disables the general profile approval check. When omitted, production requires approval by default while development and staging do not. Mutation and schema execution still enforce their own explicit approval requirements.

Audit events are JSON Lines containing a correlation ID, duration, affected or returned row count, and a one-way statement fingerprint. Parameters, result rows, credentials, and approval tokens are never recorded. Pass one `--correlation-id` across discovery, preview, and execution; the CLI and MCP server generate and return one when omitted.

The active log rotates at 5 MiB by default and retains 10 history files, keeping normal disk use near 55 MiB. Override this per profile with `auditMaxBytes` and `auditRetentionFiles`:

```bash
sakura-db audit list --profile production --correlation-id task-42
sakura-db audit list --profile production --action execute --success false --since 2026-08-01T00:00:00Z
sakura-db audit stats --profile production
sakura-db audit verify --profile production
sakura-db audit rotate --profile production
```

Every new record contains a SHA-256 hash of itself and the previous record's hash. `audit verify` detects modified, inserted, reordered, or interior-deleted records within the retained chain. This is tamper-evident, not tamper-proof: a process with unrestricted shell access can rewrite both local logs and hashes, and deleting the oldest boundary or newest tail cannot be proven without an external trusted checkpoint. Stronger guarantees require an append-only remote sink or separate operating-system permissions.

Protected writes record an intent before database execution. If that cannot be recorded, the database operation is not attempted. If the database succeeds but the outcome event cannot be written, the tool returns `AUDIT_OUTCOME_FAILED` with the correlation ID so an Agent checks database and audit state instead of blindly retrying. Reads use database-side read-only sessions; approved mutations run in a transaction and roll back on failure or limit violations.

CLI and MCP failures share one machine-actionable contract. Agents branch on `requiredAction` instead of parsing `message`; `retryable` permits a retry only after that action is complete:

```json
{
  "error": {
    "code": "CONCURRENT_MODIFICATION",
    "message": "The row changed since preview.",
    "correlationId": "task-42",
    "retryable": true,
    "requiredAction": "REDISCOVER_AND_PREVIEW"
  }
}
```

Stable actions are `STOP`, `REQUEST_APPROVAL`, `NARROW_FILTER`, `REDISCOVER_SCHEMA`, `REDISCOVER_AND_PREVIEW`, `CHECK_AUDIT_BEFORE_RETRY`, `FIX_PROFILE`, `CHECK_PERMISSIONS`, `FIX_PLAN`, and `RETRY_SAME_OPERATION`. Low-level database errors are sanitized before response or audit output.

## MCP Server

The stdio MCP server exposes health, statistics, discovery, permissions, schema summaries, indexes, foreign-key relations, Query Plans, Mutation Plans, Schema Plans, `EXPLAIN`, cost assessment, and read-only audit inspection. Query, explain, and assess tools accept SelectPlan; `database_mutation_plan` accepts data plans; `database_schema_plan` accepts controlled DDL plans. `database_audit_list`, `database_audit_verify`, and `database_audit_stats` work without opening a database connection. No tool accepts raw SQL.

```bash
DB_AGENT_CONFIG="/absolute/path/to/profiles.json" npm run mcp
```

Use the same profiles and policy controls as the CLI. Database-operation tools accept an optional `correlationId` and return the effective value; `database_audit_list` uses it to filter one task's retained events. `database_discover` accepts `limit` and `cursor`; mutation and schema tools preview by default. Schema execution requires both the exact plan and observed-state fingerprints, plus destructive and backup confirmation when requested. The accompanying [`SKILL.md`](SKILL.md) directs an AI agent to inspect live metadata and build the smallest constrained plan. Natural-language interpretation stays in the agent rather than being duplicated by CLI heuristics.

## Development

```bash
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

GitHub Actions runs the suite against a real MySQL service. Local integration tests are skipped unless `TEST_MYSQL_URL` is configured.
