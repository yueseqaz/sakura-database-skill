import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadConfig, resolveConnection, resolveProfile } from './config.js'

const execFileAsync = promisify(execFile)

export interface DoctorCheck {
  name: string
  ok: boolean
  detail: string
}

export async function doctor(configPath: string, profileName?: string): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = []
  const nodeMajor = Number(process.versions.node.split('.')[0])
  checks.push({ name: 'runtime', ok: nodeMajor >= 20, detail: `Node.js ${process.versions.node}` })

  try {
    const config = await loadConfig(configPath)
    checks.push({ name: 'config', ok: true, detail: `${Object.keys(config.profiles).length} profile(s) loaded` })
    const resolved = resolveProfile(config, profileName)
    try {
      const connection = resolveConnection(resolved?.profile)
      checks.push({ name: 'connection-config', ok: true, detail: `${connection.dialect} credentials are configured` })
    } catch (error) {
      checks.push({ name: 'connection-config', ok: false, detail: error instanceof Error ? error.message : String(error) })
    }

    const needsSsh = resolved?.profile.sshTunnel !== undefined
    if (needsSsh) {
      try {
        await execFileAsync('ssh', ['-V'])
        checks.push({ name: 'ssh', ok: true, detail: 'ssh executable is available' })
      } catch {
        checks.push({ name: 'ssh', ok: false, detail: 'ssh executable is required by the selected profile' })
      }
    }
  } catch (error) {
    checks.push({ name: 'config', ok: false, detail: error instanceof Error ? error.message : String(error) })
  }

  return { ok: checks.every((check) => check.ok), checks }
}
