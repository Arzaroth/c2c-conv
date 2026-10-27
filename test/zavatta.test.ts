import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type AddressInfo } from 'node:net'

import { LocalTransport } from '../src/transport/local.js'
import { BozoLink, HISTORY_PAGE, historyPage, stripAnsi, wakes } from '../src/zavatta.js'

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

const turns = (n: number): TranscriptEntry[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `turn ${i + 1}` }))

test('history says how much there is and where the older turns start', () => {
  const page = historyPage(turns(50))
  assert.match(page, new RegExp(`^turns ${50 - HISTORY_PAGE + 1}-50 of 50\\. Older turns: before=${50 - HISTORY_PAGE + 1}\\.`))
  assert.match(page, /#50 claude: turn 50$/)
  assert.doesNotMatch(page, /#30 /)
})

test('before pages back from a page already read', () => {
  const page = historyPage(turns(50), { limit: 5, before: 11 })
  assert.match(page, /^turns 6-10 of 50\. Older turns: before=6\./)
  assert.match(page, /#6 claude: turn 6/)
  assert.doesNotMatch(page, /#11 /)
})

test('the first page says there is nothing older', () => {
  assert.match(historyPage(turns(3), { limit: 10 }), /^turns 1-3 of 3\.\n/)
  assert.match(historyPage(turns(3), { before: 1 }), /nothing before turn 1/)
  assert.equal(historyPage([]), '(nothing in the conversation yet)')
})

function freePort(): Promise<number> {
  return new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

// A ringmaster restarting drops every socket, and an MCP server that exited on
// that took the agent's tools away. Only a bye means the session is over.
test('an agent comes back after a drop and stays gone after a bye', async () => {
  const port = await freePort()
  const ring = new LocalTransport({ port, host: '127.0.0.1', token: 'restart-token' })
  const channels: Channel[] = []
  ring.on('bozo', (channel: Channel) => {
    channels.push(channel)
    channel.on('text', () => channel.sendJson({ type: 'hoink', mode: 'gallery' } as ServerMessage))
  })
  await ring.start()

  const agent = new BozoLink({ url: `ws://127.0.0.1:${port}/?t=restart-token` })
  try {
    await agent.connect()
    const back = new Promise((r) => agent.once('reconnected', r))
    channels[0].close()
    await back
    assert.equal(agent.connected, true)
    assert.equal(channels.length, 2)

    const ended = new Promise((r) => agent.once('ended', r))
    channels[1].sendJson({ type: 'bye', text: 'the session ended' } as ServerMessage)
    channels[1].close()
    await ended
    await new Promise((r) => setTimeout(r, 1200))
    assert.equal(channels.length, 2)
  } finally {
    agent.close()
    await ring.stop()
  }
})
