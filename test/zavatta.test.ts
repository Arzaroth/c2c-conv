import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BozoLink, stripAnsi, wakes } from '../src/zavatta.js'

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

const link = (
  { state = 'prompt', outbox = [], pending = [] }:
  { state?: PaneState; outbox?: OutboxEntry[]; pending?: PendingEntry[] },
) => ({ state, outbox, pending })

const held = (id: number): PendingEntry => ({ id, text: 'later', at: 0 })
const queued = (id: number): OutboxEntry => ({ id, text: 'soon', at: 0, state: 'waiting' })

test('a session already at a prompt does not make an agent wait for a change', () => {
  assert.equal(wakes('idle', null, link({})), 'idle')
  assert.equal(wakes('idle', null, link({ state: 'busy' })), null)
})

test('idle is not free while something of the agent is still on its way in', () => {
  assert.equal(wakes('idle', null, link({ outbox: [queued(1)] })), null)
  assert.equal(wakes('idle', null, link({ pending: [held(1)] })), null)
})

test('a dialog wakes a wait that asked for one, and idle does not answer it', () => {
  assert.equal(wakes('dialog', null, link({ state: 'dialog' })), 'dialog')
  assert.equal(wakes('idle', null, link({ state: 'dialog' })), null)
})

test('a reply is an assistant turn, not any transcript record', () => {
  const busy = link({ state: 'busy' })
  const assistant: ServerMessage = { type: 'transcript', entry: { role: 'assistant', text: 'done' } }
  const user: ServerMessage = { type: 'transcript', entry: { role: 'user', text: 'do it' } }
  assert.equal(wakes('reply', assistant, busy), 'reply')
  assert.equal(wakes('reply', user, busy), null)
})

test('the lane wakes a wait without going near the session', () => {
  const lane: ServerMessage = { type: 'f2f', msg: { id: 1, from: 'bozo', text: 'stop', at: 0 } }
  assert.equal(wakes('lane', lane, link({ state: 'busy' })), 'lane')
  assert.equal(wakes('idle', lane, link({ state: 'busy' })), null)
})

test('anything reports which of them it was', () => {
  const lane: ServerMessage = { type: 'f2f', msg: { id: 1, from: 'bozo', text: 'stop', at: 0 } }
  assert.equal(wakes('anything', lane, link({ state: 'busy' })), 'lane')
  assert.equal(wakes('anything', null, link({ state: 'dialog' })), 'dialog')
  assert.equal(wakes('anything', null, link({})), 'idle')
})

test('a wait that runs out says nothing happened rather than throwing', async () => {
  const agent = new BozoLink({ url: 'ws://unused' })
  agent.state = 'busy'
  assert.deepEqual(
    await agent.wait({ for: 'idle', timeoutMs: 20 }),
    { done: false, why: null, state: 'busy' },
  )
})

test('a wait comes back on the message that satisfies it', async () => {
  const agent = new BozoLink({ url: 'ws://unused' })
  agent.state = 'busy'
  const settled = agent.wait({ for: 'idle', timeoutMs: 2000 })
  agent.state = 'prompt'
  agent.emit('message', { type: 'state', state: 'prompt' } as ServerMessage)
  assert.equal((await settled).why, 'idle')
})

test('a dropped connection ends a wait instead of hanging it to the timeout', async () => {
  const agent = new BozoLink({ url: 'ws://unused' })
  agent.state = 'busy'
  const settled = agent.wait({ for: 'idle', timeoutMs: 60000 })
  agent.emit('closed')
  await assert.rejects(settled, /closed while waiting/)
})
