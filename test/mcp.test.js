import { test } from 'node:test'
import assert from 'node:assert/strict'

import { stripAnsi } from '../src/mcp.js'

test('screen text reaches an agent without escape sequences', () => {
  const raw = '\x1b[1m\x1b[38;5;220mClaude Code\x1b[39m\x1b[22m v2.1.251'
  assert.equal(stripAnsi(raw), 'Claude Code v2.1.251')
})

test('hyperlink and charset sequences are stripped too', () => {
  assert.equal(stripAnsi('\x1b]8;;https://example.com\x07link\x1b]8;;\x07'), 'link')
  assert.equal(stripAnsi('\x1b(Bplain'), 'plain')
})

test('ordinary text is untouched', () => {
  assert.equal(stripAnsi('❯ nothing to strip here'), '❯ nothing to strip here')
})
