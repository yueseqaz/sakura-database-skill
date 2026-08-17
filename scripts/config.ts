import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { DialectName, Policy } from './core.js'

export type CredentialSourceFormat = 'dotenv' | 'spring-properties' | 'spring-yaml'

export interface CredentialSource {
  format: CredentialSourceFormat
  path: string
  urlKey?: string
  usernameKey?: string
  passwordKey?: string
  hostKey?: string
  portKey?: string
  databaseKey?: string
}

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
  credentialSource?: CredentialSource
  sshTunnel?: SshTunnelConfig
  auditLog?: string
  auditMaxBytes?: number
  auditRetentionFiles?: number
}

export interface AgentConfig {
  profiles: Record<string, Profile>
}

export interface DiscoveredProfileCandidate {
  id: string
  source: string
  format: CredentialSourceFormat
  preview: string
  host?: string
  database?: string
  suggestedName: string
  credentialSource: CredentialSource
}

const policyFields = {
  environment: z.enum(['development', 'staging', 'production']).optional(),
  maxRows: z.number().int().min(1).max(10_000).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  sensitiveColumns: z.array(z.string().min(1)).optional(),
  requireApproval: z.boolean().optional(),
  allowSensitive: z.boolean().optional(),
  allowedTables: z.array(z.string().min(1)).optional(),
  deniedTables: z.array(z.string().min(1)).optional(),
  allowedColumns: z.record(z.string(), z.array(z.string().min(1))).optional(),
  deniedColumns: z.record(z.string(), z.array(z.string().min(1))).optional(),
  requiredFilters: z.record(z.string(), z.array(z.string().min(1))).optional(),
  maxEstimatedRows: z.number().int().positive().optional(),
  allowWrites: z.boolean().optional(),
  allowDelete: z.boolean().optional(),
  maxAffectedRows: z.number().int().min(1).max(10_000).optional(),
  allowSchemaChanges: z.boolean().optional(),
  allowDrop: z.boolean().optional(),
  allowCreateDatabase: z.boolean().optional(),
  allowedDatabases: z.array(z.string().min(1)).optional(),
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

const credentialSourceSchema = z.object({
  format: z.enum(['dotenv', 'spring-properties', 'spring-yaml']),
  path: z.string().min(1),
  urlKey: z.string().min(1).optional(),
  usernameKey: z.string().min(1).optional(),
  passwordKey: z.string().min(1).optional(),
  hostKey: z.string().min(1).optional(),
  portKey: z.string().min(1).optional(),
  databaseKey: z.string().min(1).optional(),
}).strict().refine((source) => source.urlKey || (source.hostKey && source.databaseKey), {
  message: 'credentialSource requires urlKey or both hostKey and databaseKey.',
})

const profileSchema = z.object({
  dialect: z.literal('mysql'),
  url: z.string().min(1).optional(),
  urlEnv: z.string().min(1).optional(),
  credentialSource: credentialSourceSchema.optional(),
  sshTunnel: sshTunnelSchema.optional(),
  auditLog: z.string().min(1).optional(),
  auditMaxBytes: z.number().int().min(256).optional(),
  auditRetentionFiles: z.number().int().min(0).max(1_000).optional(),
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
        dialect: 'mysql',
        urlEnv: 'DATABASE_URL',
        environment: 'development',
        maxRows: 100,
        timeoutMs: 10_000,
        allowWrites: false,
      },
      production: {
        dialect: 'mysql',
        urlEnv: 'PRODUCTION_DATABASE_URL',
        environment: 'production',
        maxRows: 50,
        timeoutMs: 5_000,
        requireApproval: true,
        auditMaxBytes: 5_242_880,
        auditRetentionFiles: 10,
        allowWrites: false,
        allowSchemaChanges: false,
        allowDrop: false,
      },
    },
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function stripYamlComment(value: string): string {
  let quote: string | undefined
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if ((character === '"' || character === "'") && value[index - 1] !== '\\') quote = quote === character ? undefined : quote ?? character
    if (character === '#' && !quote && (index === 0 || /\s/.test(value[index - 1]))) return value.slice(0, index).trimEnd()
  }
  return value
}

function parseDotenv(content: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (match) values[match[1]] = unquote(stripYamlComment(match[2]))
  }
  return values
}

function parseProperties(content: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue
    const separator = trimmed.search(/[=:]/)
    if (separator <= 0) continue
    values[trimmed.slice(0, separator).trim()] = unquote(trimmed.slice(separator + 1).trim())
  }
  return values
}

function parseYamlScalars(content: string): Record<string, string> {
  const values: Record<string, string> = {}
  const parents: Array<{ indent: number; key: string }> = []
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#') || line.trimStart().startsWith('-')) continue
    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()
    const separator = trimmed.indexOf(':')
    if (separator <= 0) continue
    const key = unquote(trimmed.slice(0, separator).trim())
    const rawValue = stripYamlComment(trimmed.slice(separator + 1).trim())
    while (parents.length && parents[parents.length - 1].indent >= indent) parents.pop()
    const path = [...parents.map((parent) => parent.key), key].join('.')
    if (!rawValue) parents.push({ indent, key })
    else values[path] = unquote(rawValue)
  }
  return values
}

async function readCredentialValues(source: CredentialSource): Promise<Record<string, string>> {
  const content = await readFile(source.path, 'utf8')
  if (source.format === 'dotenv') return parseDotenv(content)
  if (source.format === 'spring-properties') return parseProperties(content)
  return parseYamlScalars(content)
}

function expandValue(raw: string | undefined, values: Record<string, string>, environment: NodeJS.ProcessEnv): string | undefined {
  if (raw === undefined) return undefined
  let result = raw
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const expanded = result.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g, (match, name: string, fallback: string | undefined) => {
      return environment[name] ?? values[name] ?? fallback ?? match
    })
    if (expanded === result) break
    result = expanded
  }
  if (/\$\{[^}]+\}/.test(result)) throw new Error('A credential source references an environment variable that is not set.')
  return result
}

function normalizeMysqlUrl(value: string): string {
  const normalized = value.startsWith('jdbc:mysql://') ? value.slice('jdbc:'.length) : value
  if (!normalized.startsWith('mysql://')) throw new Error('Discovered connection is not a MySQL URL.')
  return normalized
}

function connectionUrlFromValues(source: CredentialSource, values: Record<string, string>, environment: NodeJS.ProcessEnv): string {
  const read = (key: string | undefined) => expandValue(key ? values[key] : undefined, values, environment)
  let rawUrl = read(source.urlKey)
  if (!rawUrl && source.hostKey && source.databaseKey) {
    const host = read(source.hostKey)
    const database = read(source.databaseKey)
    if (!host || !database) throw new Error('Credential source is missing its host or database value.')
    rawUrl = `mysql://${host}:${read(source.portKey) ?? '3306'}/${database}`
  }
  if (!rawUrl) throw new Error('Credential source does not contain its configured database URL.')
  let parsed: URL
  try { parsed = new URL(normalizeMysqlUrl(rawUrl)) } catch { throw new Error('Credential source contains invalid MySQL connection settings.') }
  const username = read(source.usernameKey)
  const password = read(source.passwordKey)
  if (username !== undefined) parsed.username = username
  if (password !== undefined) parsed.password = password
  return parsed.toString()
}

function sourceFormat(path: string): CredentialSourceFormat | undefined {
  const name = basename(path)
  if (/\.(?:example|sample|template)$/.test(name)) return undefined
  if (name === '.env' || name.startsWith('.env.')) return 'dotenv'
  if (/^application(?:-[^.]+)?\.properties$/.test(name)) return 'spring-properties'
  if (/^application(?:-[^.]+)?\.ya?ml$/.test(name)) return 'spring-yaml'
  return undefined
}

async function findConfigFiles(projectPath: string): Promise<Array<{ path: string; format: CredentialSourceFormat }>> {
  const root = resolve(projectPath)
  const found: Array<{ path: string; format: CredentialSourceFormat }> = []
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', 'target', 'vendor', '.next'])
  let visited = 0
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 8) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      visited += 1
      if (visited > 10_000) throw new Error('Project configuration discovery exceeded 10,000 filesystem entries.')
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await walk(join(directory, entry.name), depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const path = join(directory, entry.name)
      const format = sourceFormat(path)
      if (format) found.push({ path, format })
    }
  }
  await walk(root, 0)
  return found.sort((left, right) => left.path.localeCompare(right.path))
}

function sourceCandidates(path: string, format: CredentialSourceFormat, values: Record<string, string>): CredentialSource[] {
  if (format === 'dotenv') {
    const urlKeys = Object.keys(values).filter((key) => /(?:^|_)(?:DATABASE|MYSQL)_?URL$/.test(key) || key === 'DB_URL')
    const candidates: CredentialSource[] = urlKeys
      .filter((key) => /^(?:jdbc:)?mysql:\/\//.test(values[key]) || /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::[^}]*)?\}$/.test(values[key]))
      .map((urlKey) => ({ format, path, urlKey }))
    const groups = [
      { host: 'DB_HOST', port: 'DB_PORT', databases: ['DB_NAME', 'DB_DATABASE'], users: ['DB_USER', 'DB_USERNAME'], password: 'DB_PASSWORD' },
      { host: 'MYSQL_HOST', port: 'MYSQL_PORT', databases: ['MYSQL_DATABASE', 'MYSQL_NAME'], users: ['MYSQL_USER', 'MYSQL_USERNAME'], password: 'MYSQL_PASSWORD' },
      { host: 'DATABASE_HOST', port: 'DATABASE_PORT', databases: ['DATABASE_NAME', 'DATABASE_DATABASE'], users: ['DATABASE_USER', 'DATABASE_USERNAME'], password: 'DATABASE_PASSWORD' },
    ]
    for (const group of groups) {
      const databaseKey = group.databases.find((key) => values[key] !== undefined)
      if (values[group.host] === undefined || !databaseKey) continue
      candidates.push({
        format,
        path,
        hostKey: group.host,
        portKey: values[group.port] !== undefined ? group.port : undefined,
        databaseKey,
        usernameKey: group.users.find((key) => values[key] !== undefined),
        passwordKey: values[group.password] !== undefined ? group.password : undefined,
      })
    }
    return candidates
  }
  const urlKeys = ['spring.datasource.url', 'datasource.url'].filter((key) => values[key] !== undefined)
  return urlKeys.map((urlKey) => {
    const prefix = urlKey.slice(0, -'.url'.length)
    return {
      format,
      path,
      urlKey,
      usernameKey: values[`${prefix}.username`] !== undefined ? `${prefix}.username` : undefined,
      passwordKey: values[`${prefix}.password`] !== undefined ? `${prefix}.password` : undefined,
    }
  })
}

function safeCandidatePreview(source: CredentialSource, values: Record<string, string>): { preview: string; host?: string; database?: string } {
  try {
    const raw = source.urlKey ? values[source.urlKey] : undefined
    if (!raw && source.hostKey && source.databaseKey) {
      const host = values[source.hostKey]
      const database = values[source.databaseKey]
      if (!host || !database || host.includes('${') || database.includes('${')) return { preview: 'mysql://[environment]' }
      const port = source.portKey ? values[source.portKey] : undefined
      return { preview: `mysql://[REDACTED]@${host}${port ? `:${port}` : ''}/${database}`, host, database }
    }
    if (!raw || raw.includes('${')) return { preview: 'mysql://[environment]' }
    const parsed = new URL(normalizeMysqlUrl(raw))
    const database = parsed.pathname.replace(/^\//, '') || undefined
    return { preview: `mysql://[REDACTED]@${parsed.host}/${database ?? ''}`, host: parsed.hostname, database }
  } catch {
    return { preview: 'mysql://[unresolved]' }
  }
}

export async function discoverProjectProfiles(projectPath: string): Promise<DiscoveredProfileCandidate[]> {
  const root = resolve(projectPath)
  const candidates: DiscoveredProfileCandidate[] = []
  for (const file of await findConfigFiles(root)) {
    let values: Record<string, string>
    try { values = await readCredentialValues({ format: file.format, path: file.path, urlKey: 'placeholder' }) } catch { continue }
    for (const credentialSource of sourceCandidates(file.path, file.format, values)) {
      const descriptor = JSON.stringify({ source: relative(root, file.path), ...credentialSource, path: undefined })
      const id = createHash('sha256').update(descriptor).digest('hex').slice(0, 16)
      const safe = safeCandidatePreview(credentialSource, values)
      const suggestedName = (safe.database ?? basename(root)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'project'
      candidates.push({ id, source: file.path, format: file.format, ...safe, suggestedName, credentialSource })
    }
  }
  return candidates
}

async function writeConfigAtomic(path: string, config: AgentConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await rename(temporaryPath, path)
  await chmod(path, 0o600)
}

export async function importDiscoveredProfile(options: {
  projectPath: string
  candidateId: string
  profileName: string
  configPath?: string
  replace?: boolean
}): Promise<{ name: string; created: boolean; configPath: string }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.profileName)) throw new Error('Profile name may contain only letters, numbers, dots, underscores, and hyphens.')
  const candidate = (await discoverProjectProfiles(options.projectPath)).find((item) => item.id === options.candidateId)
  if (!candidate) throw new Error('Discovery candidate was not found. Run config discover again before importing.')
  const configPath = options.configPath ?? defaultConfigPath()
  const config = await loadConfig(configPath)
  const created = config.profiles[options.profileName] === undefined
  if (!created && !options.replace) throw new Error(`Profile ${options.profileName} already exists; use --replace to overwrite it.`)
  config.profiles[options.profileName] = {
    dialect: 'mysql',
    credentialSource: candidate.credentialSource,
    environment: /prod(?:uction)?/i.test(candidate.source) ? 'production' : 'development',
    maxRows: 100,
    timeoutMs: 10_000,
    allowWrites: false,
    allowSchemaChanges: false,
    allowDrop: false,
  }
  await writeConfigAtomic(configPath, config)
  return { name: options.profileName, created, configPath }
}

export function resolveProfile(config: AgentConfig, name: string | undefined): { name: string; profile: Profile } | undefined {
  if (!name) return undefined
  const profile = config.profiles[name]
  if (!profile) throw new Error(`Unknown profile: ${name}`)
  return { name, profile }
}

export async function resolveConnection(profile: Profile | undefined, environment: NodeJS.ProcessEnv = process.env): Promise<{ dialect: DialectName; url: string }> {
  const dialect = profile?.dialect ?? (process.env.DB_DIALECT || 'mysql') as DialectName
  const url = profile?.url
    ?? (profile?.urlEnv ? environment[profile.urlEnv] : environment.DATABASE_URL)
    ?? (profile?.credentialSource ? connectionUrlFromValues(profile.credentialSource, await readCredentialValues(profile.credentialSource), environment) : undefined)
  if (dialect !== 'mysql') throw new Error('This version only supports MySQL.')
  if (!url) throw new Error('Set DATABASE_URL or configure a profile urlEnv or credentialSource.')
  return { dialect, url }
}
