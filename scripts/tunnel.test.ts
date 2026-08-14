import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'
import { waitForPort } from './tunnel.js'

test('waits until an SSH forwarded port is actually ready', async () => {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))

  const server = createServer((socket) => socket.end())
  const startedAt = Date.now()
  const timer = setTimeout(() => server.listen(port, '127.0.0.1'), 700)
  try {
    await waitForPort(port, 2_000)
    assert.ok(Date.now() - startedAt >= 600)
  } finally {
    clearTimeout(timer)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('fails when an SSH forwarded port never becomes ready', async () => {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  await assert.rejects(() => waitForPort(port, 200), /did not become ready/i)
})
