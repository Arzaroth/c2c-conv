import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'

import { LocalTransport } from '../src/transport/local.js'

test('the url names the bound address', () => {
  const local = new LocalTransport({ port: 7331, host: '192.168.1.5', token: 'abc' })
  assert.equal(local.url, 'http://192.168.1.5:7331/?t=abc')
})

// Browsers refuse 0.0.0.0, and nobody can open "::". Loopback always answers.
test('a wildcard bind is shown as loopback', () => {
  for (const host of ['0.0.0.0', '::']) {
    const local = new LocalTransport({ port: 7331, host, token: 'abc' })
    assert.equal(local.url, 'http://127.0.0.1:7331/?t=abc', host)
  }
})

// The token is the only credential, so the link is revoked by replacing it.
test('rotating the token changes the link the transport hands out', () => {
  const local = new LocalTransport({ port: 7331, host: '127.0.0.1', token: 'abc' })
  local.setToken('def')
  assert.equal(local.url, 'http://127.0.0.1:7331/?t=def')
})

// The url is only half of it: what actually revokes a link is the upgrade
// being checked against the token as it now stands.
test('a socket on the old token is refused once the token has been rotated', async () => {
  const port = await freePort()
  const local = new LocalTransport({ port, host: '127.0.0.1', token: 'the-old-one' })
  await local.start()

  try {
    assert.equal(await opens(port, 'the-old-one'), true)
    local.setToken('the-new-one')
    assert.equal(await opens(port, 'the-old-one'), false)
    assert.equal(await opens(port, 'the-new-one'), true)
  } finally {
    await local.stop()
  }
})

function opens(port: number, token: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?t=${token}`)
    ws.addEventListener('open', () => {
      ws.close()
      resolve(true)
    })
    ws.addEventListener('error', () => resolve(false))
  })
}

function freePort(): Promise<number> {
  return new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })
}
