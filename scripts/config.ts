import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { DialectName, Policy } from './core.js'

export interface SshTunnelConfig {
  host: string
  user: string
  remoteHost: string
  remotePort: number
  localPort?: number
  sshPort?: number
  identityFile?: string
}

export interface Profile extends Policy {
  dialect: DialectName
  url?: string
  urlEnv?: string
  sshTunnel?: SshTunnelConfig
  auditLog?: string
}

export interface AgentConfig {
  profiles: Record<string, Profile>
}

const policyFields = {
  environment: z.enum(['development', 'staging', 'production']).optional(),
  maxRows: z.number().int().min(1).max(10_000).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  sensitiveColumns: z.array(z.string().min(1)).optional(),
  requireApproval: z.boolean().optional(),
  allowSensitive: z.boolean().optional(),
  allowRawSql: z.boolean().optional(),
  allowedTables: z.array(z.string().min(1)).optional(),
  deniedTables: z.array(z.string().min(1)).optional(),
  allowedColumns: z.record(z.string(), z.array(z.string().min(1))).optional(),
  deniedColumns: z.record(z.string(), z.array(z.string().min(1))).optional(),
  requiredFilters: z.record(z.string(), z.array(z.string().min(1))).optional(),
  maxEstimatedRows: z.number().int().positive().optional(),
}

const sshTunnelSchema = z.object({
  host: z.string().min(1),
  user: z.string().min(1),
  remoteHost: z.string().min(1),
  remotePort: z.number().int().min(1).max(65_535),
  localPort: z.number().int().min(1).max(65_535).optional(),
  sshPort: z.number().int().min(1).max(65_535).optional(),
  identityFile: z.string().min(1).optional(),
}).strict()

const profileSchema = z.object({
  dialect: z.enum(['postgres', 'mysql', 'mariadb', 'sqlite']),
  url: z.string().min(1).optional(),
  urlEnv: z.string().min(1).optional(),
  sshTunnel: sshTunnelSchema.optional(),
  auditLog: z.string().min(1).optional(),
  ...policyFields,
}).strict()

const configSchema = z.object({ profiles: z.record(z.string(), profileSchema) }).strict()

export function defaultConfigPath(): string {
  return resolve(homedir(), '.config', 'sakura-database-skill', 'profiles.json')
}

export async function loadConfig(path = defaultConfigPath()): Promise<AgentConfig> {
  try {
    const parsed = configSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    if (!parsed.success) throw new Error(`Invalid configuration: ${z.prettifyError(parsed.error)}`)
    return parsed.data
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: {} }
    throw error
  }
}

export async function writeExampleConfig(path = defaultConfigPath()): Promise<void> {
  const config: AgentConfig = {
    profiles: {
      development: {
        dialect: 'postgres',
        urlEnv: 'DATABASE_URL',
        environment: 'development',
        maxRows: 100,
        timeoutMs: 10_000,
      },
      production: {
        dialect: 'mysql',
        urlEnv: 'PRODUCTION_DATABASE_URL',
        environment: 'production',
        maxRows: 50,
        timeoutMs: 5_000,
        requireApproval: true,
      },
    },
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

export function resolveProfile(config: AgentConfig, name: string | undefined): { name: string; profile: Profile } | undefined {
  if (!name) return undefined
  const profile = config.profiles[name]
  if (!profile) throw new Error(`Unknown profile: ${name}`)
  return { name, profile }
}

export function resolveConnection(profile: Profile | undefined): { dialect: DialectName; url: string } {
  const dialect = profile?.dialect ?? process.env.DB_DIALECT as DialectName | undefined
  const url = profile?.url ?? (profile?.urlEnv ? process.env[profile.urlEnv] : process.env.DATABASE_URL)
  if (!dialect || !['postgres', 'mysql', 'mariadb', 'sqlite'].includes(dialect)) throw new Error('Set DB_DIALECT or use a profile with postgres, mysql, mariadb, or sqlite.')
  if (!url) throw new Error('Set DATABASE_URL or configure a profile urlEnv.')
  return { dialect, url }
}
