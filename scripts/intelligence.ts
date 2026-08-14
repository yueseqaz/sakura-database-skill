import type { DialectName, SelectPlan } from './core.js'

export interface SchemaColumn {
  name: string
  type: string
  nullable: boolean
}

export interface SchemaTable {
  name: string
  columns: SchemaColumn[]
}

const sensitiveNeedles = ['password', 'salt', 'secret', 'token', 'email', 'phone', 'mobile', 'resume', 'medical', 'identity']

function sensitive(name: string): boolean {
  return sensitiveNeedles.some((needle) => name.toLowerCase().includes(needle))
}

export function summarizeSchema(tables: SchemaTable[]) {
  return {
    tableCount: tables.length,
    tables: tables.map((table) => ({
      name: table.name,
      columnCount: table.columns.length,
      sensitiveColumns: table.columns.filter((column) => sensitive(column.name)).map((column) => column.name),
    })),
  }
}

export function paginatePlan(plan: SelectPlan, fetchedCount: number) {
  const limit = Math.max(1, plan.limit ?? 100)
  const offset = Math.max(0, plan.offset ?? 0)
  return { returned: Math.min(fetchedCount, limit), hasMore: fetchedCount > limit, nextOffset: fetchedCount > limit ? offset + limit : undefined }
}

export function assessExplain(dialect: DialectName, rows: Array<Record<string, unknown>>) {
  const text = rows.map((row) => Object.values(row).join(' ')).join(' ').toLowerCase()
  const fullScan = dialect === 'mysql' ? rows.some((row) => String(row.type).toUpperCase() === 'ALL') : dialect === 'postgres' ? text.includes('seq scan') : text.includes('scan') && !text.includes('using index')
  const structuredEstimates = rows.map((row) => Number(row.rows ?? 0)).filter(Number.isFinite)
  const textEstimates = dialect === 'postgres' ? [...text.matchAll(/rows=(\d+)/g)].map((match) => Number(match[1])) : []
  const estimate = Math.max(0, ...structuredEstimates, ...textEstimates)
  const reasons = [
    ...(fullScan ? ['full table scan'] : []),
    ...(estimate >= 10_000 ? [`estimated ${estimate} rows`] : []),
  ]
  const risk = fullScan && estimate >= 10_000 ? 'high' : fullScan || estimate >= 1_000 ? 'medium' : 'low'
  return { risk, reasons, requiresApproval: risk === 'high' }
}
