import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

export function defaultConfigPath(): string {
  return resolve(homedir(), '.config', 'sakura-database-skill', 'profiles.json')
}

export async function loadConfig(path = defaultConfigPath()): Promise<AgentConfig> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as AgentConfig
    if (!parsed || typeof parsed !== 'object' || !parsed.profiles || typeof parsed.profiles !== 'object') {
      throw new Error('Config must contain a profiles object.')
    }
    return parsed
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
  if (!dialect || !['postgres', 'mysql', 'sqlite'].includes(dialect)) throw new Error('Set DB_DIALECT or use a profile with postgres, mysql, or sqlite.')
  if (!url) throw new Error('Set DATABASE_URL or configure a profile urlEnv.')
  return { dialect, url }
}
