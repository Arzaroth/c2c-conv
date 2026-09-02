import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { WEB_ROOT } from '../src/root.js'

// The ringmaster and the bigtop both serve WEB_ROOT, and the client only exists
// there once vite has built it. A wrong outDir would be a 404 on every page.
test('the web root is the built client', async () => {
  assert.ok(WEB_ROOT.endsWith(join('dist', 'web')), WEB_ROOT)
  const page = await readFile(join(WEB_ROOT, 'index.html'), 'utf8')
  assert.match(page, /<script type="module"[^>]*src="\/assets\//)
})

// "No runtime dependencies" includes the browser: xterm is bundled at build
// time rather than fetched when a bozo opens the page.
test('the page loads nothing from a CDN', async () => {
  const page = await readFile(join(WEB_ROOT, 'index.html'), 'utf8')
  assert.doesNotMatch(page, /<(script|link)[^>]*(src|href)="https?:/)
})
