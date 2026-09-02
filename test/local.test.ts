import { test } from 'node:test'
import assert from 'node:assert/strict'

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
