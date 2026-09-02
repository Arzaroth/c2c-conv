import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toEntry, transcriptPath } from '../src/transcript.js'

test('the transcript path is the cwd slug plus the session id', () => {
  const path = transcriptPath({ cwd: '/home/arzaroth', sessionId: 'abc-123' })
  assert.match(path, /\.claude\/projects\/-home-arzaroth\/abc-123\.jsonl$/)
})

test('nested working directories slug every separator', () => {
  const path = transcriptPath({ cwd: '/home/arzaroth/Repos/c2c-conv', sessionId: 'x' })
  assert.match(path, /projects\/-home-arzaroth-Repos-c2c-conv\/x\.jsonl$/)
})

test('a typed prompt becomes a user turn', () => {
  const entry = toEntry({
    type: 'user',
    message: { content: 'ship the patch' },
    timestamp: '2026-09-01T10:00:00Z',
  })
  assert.deepEqual(entry, { role: 'user', text: 'ship the patch', at: '2026-09-01T10:00:00Z' })
})

test('a block-form prompt becomes a user turn', () => {
  const entry = toEntry({
    type: 'user',
    message: { content: [{ type: 'text', text: 'ship the patch' }] },
  })
  assert.ok(entry)
  assert.equal(entry.role, 'user')
  assert.equal(entry.text, 'ship the patch')
})

// Tool results are user-role records too, and they carry whole files and
// command output. Rendering them as things a person said would be nonsense.
test('a tool result is not a user turn', () => {
  const entry = toEntry({
    type: 'user',
    message: {
      content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'total 1688\ndrwxr-xr-x ...' }],
    },
  })
  assert.equal(entry, null)
})

test('meta records are skipped', () => {
  const entry = toEntry({
    type: 'user',
    isMeta: true,
    message: { content: [{ type: 'text', text: '[Image: /tmp/pasted.png]' }] },
  })
  assert.equal(entry, null)
})

test('subagent records are skipped', () => {
  const entry = toEntry({
    type: 'user',
    isSidechain: true,
    message: { content: 'go research this' },
  })
  assert.equal(entry, null)
})

test('an assistant turn keeps its text and names its tools', () => {
  const entry = toEntry({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Looking at the config.' },
        { type: 'tool_use', name: 'Read', input: {} },
        { type: 'tool_use', name: 'Bash', input: {} },
      ],
    },
  })
  assert.ok(entry)
  assert.equal(entry.role, 'assistant')
  assert.equal(entry.text, 'Looking at the config.')
  assert.deepEqual(entry.tools, ['Read', 'Bash'])
})

test('a tool-only assistant turn still reports the tools', () => {
  const entry = toEntry({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
  })
  assert.ok(entry)
  assert.equal(entry.text, '')
  assert.deepEqual(entry.tools, ['Edit'])
})

test('thinking-only turns produce nothing', () => {
  const entry = toEntry({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
  })
  assert.equal(entry, null)
})

test('bookkeeping record types are ignored', () => {
  for (const type of ['attachment', 'mode', 'permission-mode', 'ai-title', 'file-history-snapshot']) {
    assert.equal(toEntry({ type, message: { content: 'x' } }), null, type)
  }
})

test('malformed records do not throw', () => {
  for (const record of [null, undefined, {}, { type: 'assistant' }, { type: 'user', message: {} }]) {
    assert.doesNotThrow(() => toEntry(record))
    assert.equal(toEntry(record), null)
  }
})
