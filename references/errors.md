# Stable Error Handling

Read this reference before retrying a failed CLI or MCP operation. Keep the same `correlationId` for the complete task and query its audit events when the result is unclear.

| Error code | Required response |
| --- | --- |
| `APPROVAL_REQUIRED` | Ask the user for approval. Never invent a token. |
| `PLAN_FINGERPRINT_MISMATCH` | Preview the current plan again and request approval for the new fingerprint. |
| `SCHEMA_STATE_CHANGED` | Rediscover the schema, rebuild the plan, and preview again. |
| `CONCURRENT_MODIFICATION` | Read the row again, preserve the optimistic lock, and preview again. Never remove the lock to force the write. |
| `IDEMPOTENCY_CONFLICT` | Stop and reconcile the earlier operation. Do not change the key merely to bypass the conflict. |
| `AFFECTED_ROWS_EXCEEDED` | Narrow the filters or reduce the requested scope. |
| `DROP_NOT_ALLOWED` | Stop. Do not bypass the profile policy. |
| `PERMISSION_DENIED` | Report the missing MySQL privilege; do not retry unchanged. |
| `QUERY_TIMEOUT` | Narrow the plan or inspect indexes and `EXPLAIN` before retrying. |
| `AUDIT_WRITE_FAILED` | The protected write was not attempted. Repair the audit destination before retrying. |
| `AUDIT_OUTCOME_FAILED` | The database operation succeeded but its outcome log failed. Query the database and audit by `correlationId` before deciding whether to retry. |

For `TRANSACTION_ROLLED_BACK`, confirm rollback state before retrying. For unlisted permission or validation errors, stop and correct the plan or profile instead of weakening policy controls.
