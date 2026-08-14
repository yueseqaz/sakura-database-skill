export type DatabaseAgentErrorCode =
  | 'PROFILE_NOT_FOUND'
  | 'CONNECTION_FAILED'
  | 'WRITE_NOT_ALLOWED'
  | 'DELETE_NOT_ALLOWED'
  | 'APPROVAL_REQUIRED'
  | 'PLAN_FINGERPRINT_MISMATCH'
  | 'FILTER_REQUIRED'
  | 'AFFECTED_ROWS_EXCEEDED'
  | 'TABLE_NOT_FOUND'
  | 'COLUMN_NOT_FOUND'
  | 'COLUMN_DENIED'
  | 'QUERY_TIMEOUT'
  | 'TRANSACTION_ROLLED_BACK'
  | 'CONCURRENT_MODIFICATION'
  | 'IDEMPOTENCY_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_REQUEST'
  | 'DATABASE_ERROR'

export class DatabaseAgentError extends Error {
  constructor(public readonly code: DatabaseAgentErrorCode, message: string, public readonly details?: Record<string, unknown>) {
    super(message)
    this.name = 'DatabaseAgentError'
  }
}

const messageMappings: Array<[RegExp, DatabaseAgentErrorCode]> = [
  [/Unknown profile|requires a configured profile/i, 'PROFILE_NOT_FOUND'],
  [/allowWrites/i, 'WRITE_NOT_ALLOWED'],
  [/allowDelete/i, 'DELETE_NOT_ALLOWED'],
  [/approval token/i, 'APPROVAL_REQUIRED'],
  [/preview fingerprint/i, 'PLAN_FINGERPRINT_MISMATCH'],
  [/requires an idempotency key/i, 'IDEMPOTENCY_REQUIRED'],
  [/Idempotency key was already used|previous idempotent mutation/i, 'IDEMPOTENCY_CONFLICT'],
  [/changed since preview/i, 'CONCURRENT_MODIFICATION'],
  [/non-empty filter|plans require .*filter/i, 'FILTER_REQUIRED'],
  [/affected-row limit|exceeds the affected-row/i, 'AFFECTED_ROWS_EXCEEDED'],
  [/Unknown table/i, 'TABLE_NOT_FOUND'],
  [/Unknown column/i, 'COLUMN_NOT_FOUND'],
  [/Column is (?:denied|not allowed)/i, 'COLUMN_DENIED'],
  [/timed out/i, 'QUERY_TIMEOUT'],
  [/transaction rolled back/i, 'TRANSACTION_ROLLED_BACK'],
]

function driverCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

export function normalizeError(error: unknown): DatabaseAgentError {
  if (error instanceof DatabaseAgentError) return error
  const code = driverCode(error)
  if (code && ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ER_ACCESS_DENIED_ERROR'].includes(code)) {
    return new DatabaseAgentError('CONNECTION_FAILED', 'Could not connect to the configured database.')
  }
  if (code?.startsWith('ER_') || (error && typeof error === 'object' && 'sqlState' in error)) {
    return new DatabaseAgentError('DATABASE_ERROR', 'The database rejected the operation.')
  }
  const message = error instanceof Error ? error.message : String(error)
  const mapping = messageMappings.find(([pattern]) => pattern.test(message))
  return new DatabaseAgentError(mapping?.[1] ?? 'INVALID_REQUEST', message)
}

export function errorPayload(error: unknown): { error: { code: DatabaseAgentErrorCode; message: string; details?: Record<string, unknown> } } {
  const normalized = normalizeError(error)
  return { error: { code: normalized.code, message: normalized.message, ...(normalized.details ? { details: normalized.details } : {}) } }
}
