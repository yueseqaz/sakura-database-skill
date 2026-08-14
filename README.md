# sakura-database-skill

A universal database skill and TypeScript CLI for AI agents.

Connect to MySQL, PostgreSQL, and SQLite databases to discover schemas, run safe read-only queries, inspect `EXPLAIN` plans, and check database health through a unified interface.

## Quick start

```bash
npm install

export DB_DIALECT=mysql
export DATABASE_URL='mysql://readonly:password@localhost:3306/app'

npm run db-agent -- health
npm run db-agent -- discover
npm run db-agent -- query --sql 'select id, status from orders limit 20'
npm run db-agent -- explain --sql 'select id from orders where customer_id = 42'
```

`DATABASE_URL` accepts normal PostgreSQL, MySQL, or SQLite URLs. MySQL JDBC-style options can be included in the query string; the CLI keeps only options supported by the Node.js driver.

## Safety

The CLI accepts exactly one `SELECT`, `WITH ... SELECT`, or `EXPLAIN` statement. It rejects writes, DDL, permission changes, administrative commands, and multiple statements. Use a least-privilege read-only database account and keep credentials in environment variables or a secret manager.

This project does not yet execute migrations, backups, restores, or writes. Those operations should be added as separate approval-gated capabilities.

## Development

```bash
npm test
npm run typecheck
```

The project is also packaged as a Codex Skill in [`SKILL.md`](SKILL.md).
