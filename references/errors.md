# Stable Error Handling

Branch on `requiredAction`, not `message`. `retryable: true` means retry only after completing the required action. Reuse the same `correlationId`, plan fingerprint when still valid, and idempotency key.

| Error code | `requiredAction` | Agent response |
| --- | --- | --- |
| `APPROVAL_REQUIRED` | `REQUEST_APPROVAL` | Ask the user. Never invent a token. |
| `DESTRUCTIVE_CONFIRMATION_REQUIRED` | `REQUEST_APPROVAL` | Request the exact destructive confirmation. |
| `BACKUP_CONFIRMATION_REQUIRED` | `REQUEST_APPROVAL` | Require a real backup reference. |
| `PLAN_FINGERPRINT_MISMATCH` | `REDISCOVER_AND_PREVIEW` | Preview again and request approval for the new fingerprint. |
| `CONCURRENT_MODIFICATION` | `REDISCOVER_AND_PREVIEW` | Re-read the row, preserve the optimistic lock, and preview again. |
| `SCHEMA_STATE_CHANGED` | `REDISCOVER_SCHEMA` | Rediscover the schema and rebuild the plan. |
| `TABLE_NOT_FOUND` / `COLUMN_NOT_FOUND` | `REDISCOVER_SCHEMA` | Refresh observed metadata before rebuilding the plan. |
| `IDEMPOTENCY_CONFLICT` | `CHECK_AUDIT_BEFORE_RETRY` | Reconcile the earlier operation. Never change the key to bypass the conflict. |
| `AUDIT_OUTCOME_FAILED` | `CHECK_AUDIT_BEFORE_RETRY` | Query database state and `database_audit_list` before deciding whether to retry. |
| `DATABASE_ERROR` | `CHECK_AUDIT_BEFORE_RETRY` | Treat the outcome as unclear until database and audit state are reconciled. |
| `AFFECTED_ROWS_EXCEEDED` | `NARROW_FILTER` | Reduce the requested scope. |
| `QUERY_TIMEOUT` | `NARROW_FILTER` | Narrow the plan or inspect indexes and `EXPLAIN`. |
| `PERMISSION_DENIED` | `CHECK_PERMISSIONS` | Report missing privileges; do not retry unchanged. |
| `PROFILE_NOT_FOUND` / `CONNECTION_FAILED` | `FIX_PROFILE` | Correct the profile, credential environment, network, or SSH configuration. |
| `AUDIT_WRITE_FAILED` | `FIX_PROFILE` | Repair the audit destination; the protected write was not attempted. |
| `FILTER_REQUIRED` / `IDEMPOTENCY_REQUIRED` / `INVALID_REQUEST` | `FIX_PLAN` | Correct the structured request without weakening policy. |
| `TRANSACTION_ROLLED_BACK` | `RETRY_SAME_OPERATION` | Retry only when appropriate, preserving the same idempotency key. |
| `DROP_NOT_ALLOWED` | `STOP` | Stop. Do not bypass policy. |
| `WRITE_NOT_ALLOWED` / `DELETE_NOT_ALLOWED` | `STOP` | Stop. Do not enable permissions without the user's request. |
| `SCHEMA_CHANGE_NOT_ALLOWED` / `DATABASE_CREATE_NOT_ALLOWED` | `STOP` | Stop. Do not bypass profile boundaries. |
| `COLUMN_DENIED` | `STOP` | Stop and omit the denied field. |
