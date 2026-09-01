import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, chmodSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Tunnel, parseTunnelUrl, resolveCloudflared } from '../src/tunnel.js'

test('the quick tunnel URL is read out of the banner', () => {
  const line = '2026-09-01T12:00:00Z INF |  https://polite-clown-shoes-honk.trycloudflare.com  |'
  assert.equal(parseTunnelUrl(line), 'https://polite-clown-shoes-honk.trycloudflare.com')
})

// cloudflared logs plenty of other URLs. Mistaking one for the tunnel would
// hand the host a link that goes nowhere.
test('ordinary log lines are not mistaken for the tunnel', () => {
  for (const line of [
    '2026-09-01T12:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
    '2026-09-01T12:00:00Z INF Connection registered connIndex=0 location=cdg',
    '2026-09-01T12:00:00Z INF Updated to new configuration at https://api.cloudflare.com/client/v4',
  ]) {
    const found = parseTunnelUrl(line)
    assert.ok(found === null || found.endsWith('.trycloudflare.com'), line)
  }
})

test('a named tunnel hostname is accepted from the announcement', () => {
  const line = 'INF |  Visit it at: https://share.example.com  |'
  assert.equal(parseTunnelUrl(line), 'https://share.example.com')
})

test('a missing binary is reported as such', async () => {
  const tunnel = new Tunnel({ port: 1234, bin: '/nonexistent/cloudflared' })
  await assert.rejects(() => tunnel.start(2000), /cloudflared not found/)
})

// cloudflared is not installed here, so the lifecycle is exercised against a
// stub that prints the same banner. This proves the parsing and the plumbing,
// not that a real tunnel works.
test('a stub announcing a URL resolves the tunnel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-tunnel-'))
  const bin = join(dir, 'fake-cloudflared')
  writeFileSync(bin, `#!/bin/sh
echo "INF Requesting new quick Tunnel on trycloudflare.com..." >&2
echo "INF +------------------------------------------+" >&2
echo "INF |  Your quick Tunnel has been created!     |" >&2
echo "INF |  https://honking-bozo-tent.trycloudflare.com |" >&2
echo "INF +------------------------------------------+" >&2
sleep 30
`)
  chmodSync(bin, 0o755)

  const tunnel = new Tunnel({ port: 7331, bin })
  const url = await tunnel.start(8000)
  assert.equal(url, 'https://honking-bozo-tent.trycloudflare.com')
  assert.equal(tunnel.url, url)
  tunnel.stop()
})

test('a stub that exits without announcing is reported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-tunnel-'))
  const bin = join(dir, 'dying-cloudflared')
  writeFileSync(bin, '#!/bin/sh\necho "ERR failed to connect" >&2\nexit 1\n')
  chmodSync(bin, 0o755)

  const tunnel = new Tunnel({ port: 7331, bin })
  await assert.rejects(() => tunnel.start(8000), /exited with code 1/)
})

// The npm cloudflared package is not a dependency, but if someone has installed
// it there is no reason to make them install a second copy of the same binary.
test('a locally installed npm cloudflared is used when present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-npm-'))
  const binDir = join(dir, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, 'cloudflared')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n')
  chmodSync(bin, 0o755)

  assert.equal(resolveCloudflared(dir), bin)
})

test('PATH wins when there is no local copy', () => {
  const empty = mkdtempSync(join(tmpdir(), 'c2c-empty-'))
  assert.equal(resolveCloudflared(empty), 'cloudflared')
})

test('an explicit override beats everything', () => {
  const previous = process.env.C2C_CLOUDFLARED
  process.env.C2C_CLOUDFLARED = '/opt/custom/cloudflared'
  try {
    assert.equal(resolveCloudflared('/tmp'), '/opt/custom/cloudflared')
  } finally {
    if (previous === undefined) delete process.env.C2C_CLOUDFLARED
    else process.env.C2C_CLOUDFLARED = previous
  }
})
