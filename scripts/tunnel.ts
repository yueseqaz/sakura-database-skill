import { spawn } from 'node:child_process'
import type { SshTunnelConfig } from './config.js'

export interface ActiveTunnel {
  localPort: number
  close(): Promise<void>
}

export async function openTunnel(config: SshTunnelConfig): Promise<ActiveTunnel> {
  const localPort = config.localPort ?? config.remotePort
  const args = ['-N', '-L', `${localPort}:${config.remoteHost}:${config.remotePort}`, '-p', String(config.sshPort ?? 22)]
  if (config.identityFile) args.push('-i', config.identityFile)
  args.push(`${config.user}@${config.host}`)
  const child = spawn('ssh', args, { stdio: 'ignore' })
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(resolveReady, 500)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`SSH tunnel exited before becoming ready (${code ?? 'unknown'}).`))
    })
  })
  return {
    localPort,
    close: async () => { if (!child.killed) child.kill() },
  }
}
