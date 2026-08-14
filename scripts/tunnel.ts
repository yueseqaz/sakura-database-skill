import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import type { SshTunnelConfig } from './config.js'

export interface ActiveTunnel {
  localPort: number
  close(): Promise<void>
}

export async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port })
        socket.setTimeout(250)
        socket.once('connect', () => { socket.destroy(); resolve() })
        socket.once('error', reject)
        socket.once('timeout', () => { socket.destroy(); reject(new Error('Port probe timed out.')) })
      })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(`SSH tunnel port ${port} did not become ready within ${timeoutMs}ms.`)
}

export async function openTunnel(config: SshTunnelConfig): Promise<ActiveTunnel> {
  const localPort = config.localPort ?? config.remotePort
  const args = [
    '-N', '-L', `${localPort}:${config.remoteHost}:${config.remotePort}`,
    '-p', String(config.sshPort ?? 22), '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
  ]
  if (config.identityFile) args.push('-i', config.identityFile)
  args.push(`${config.user}@${config.host}`)
  const child = spawn('ssh', args, { stdio: 'ignore' })
  try {
    await Promise.race([
      waitForPort(localPort),
      new Promise<never>((_, reject) => {
        child.once('error', reject)
        child.once('exit', (code) => reject(new Error(`SSH tunnel exited before becoming ready (${code ?? 'unknown'}).`)))
      }),
    ])
  } catch (error) {
    if (!child.killed) child.kill()
    throw error
  }
  return {
    localPort,
    close: async () => {
      if (child.exitCode !== null || child.killed) return
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.kill()
      })
    },
  }
}
