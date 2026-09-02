import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_OUTBOX, Outbox, type SendOutcome } from '../src/outbox.js'

const settled = () => new Promise((r) => setTimeout(r, 30))

// A send that answers whatever the test tells it to, and records what it saw.
function scripted(answers: SendOutcome[]) {
  const seen: string[] = []
  const send = async (entry: OutboxEntry): Promise<SendOutcome> => {
    seen.push(entry.text)
    return answers.shift() ?? { ok: true }
  }
  return { send, seen }
}

test('messages go in one at a time, in order', async () => {
  const { send, seen } = scripted([])
  const outbox = new Outbox({ send, retryMs: 1 })

  outbox.add({ text: 'first', bozo: 'a' })
  outbox.add({ text: 'second', bozo: 'b' })
  outbox.add({ text: 'third', bozo: 'a' })
  await settled()

  assert.deepEqual(seen, ['first', 'second', 'third'])
  assert.equal(outbox.list().length, 0)
})

test('a busy session holds the queue rather than dropping it', async () => {
  const { send, seen } = scripted([
    { ok: false, retry: true, reason: 'busy' },
    { ok: false, retry: true, reason: 'busy' },
    { ok: true },
  ])
  const outbox = new Outbox({ send, retryMs: 1 })

  outbox.add({ text: 'run the tests', bozo: 'bozo' })
  await settled()

  assert.deepEqual(seen, ['run the tests', 'run the tests', 'run the tests'])
  assert.equal(outbox.list().length, 0)
})

test('why it is waiting is said once per reason, not once per attempt', async () => {
  const { send } = scripted([
    { ok: false, retry: true, reason: 'busy' },
    { ok: false, retry: true, reason: 'busy' },
    { ok: false, retry: true, reason: 'draft' },
    { ok: true },
  ])
  const outbox = new Outbox({ send, retryMs: 1 })
  const reasons: string[] = []
  outbox.onEvent((event) => {
    if (event.type === 'waiting') reasons.push(event.reason)
  })

  outbox.add({ text: 'hello', bozo: 'bozo' })
  await settled()

  assert.deepEqual(reasons, ['busy', 'draft'])
})

test('a dead pane fails the message instead of retrying forever', async () => {
  const { send } = scripted([{ ok: false, retry: false, reason: 'dead' }])
  const outbox = new Outbox({ send, retryMs: 1 })
  const failed: string[] = []
  outbox.onEvent((event) => {
    if (event.type === 'failed') failed.push(event.entry.text)
  })

  outbox.add({ text: 'anyone there', bozo: 'bozo' })
  await settled()

  assert.deepEqual(failed, ['anyone there'])
  assert.equal(outbox.list().length, 0)
})

test('cancel takes one out of the line before it goes in', async () => {
  const seen: string[] = []
  const outbox = new Outbox({
    send: (entry) => {
      seen.push(entry.text)
      return new Promise<SendOutcome>(() => {})
    },
    retryMs: 5,
  })

  outbox.add({ text: 'first', bozo: 'a' })
  const second = outbox.add({ text: 'second', bozo: 'b' })!
  await settled()

  assert.equal(outbox.cancel(second.id).ok, true)
  assert.deepEqual(outbox.list().map((e) => e.text), ['first'])
  assert.deepEqual(seen, ['first'])
  outbox.stop()
})

test('the one already going in cannot be taken back', async () => {
  let release: (outcome: SendOutcome) => void = () => {}
  const outbox = new Outbox({
    send: () => new Promise<SendOutcome>((resolve) => { release = resolve }),
    retryMs: 1,
  })

  const entry = outbox.add({ text: 'rm -rf', bozo: 'bozo' })!
  await settled()

  const result = outbox.cancel(entry.id)
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.error : '', /already going in/)
  release({ ok: true })
})

test('bump moves a message to the front of the line', async () => {
  const outbox = new Outbox({
    send: () => new Promise<SendOutcome>(() => {}),
    retryMs: 5,
  })

  outbox.add({ text: 'first', bozo: 'a' })
  outbox.add({ text: 'second', bozo: 'b' })
  const third = outbox.add({ text: 'third', bozo: 'c' })!
  await settled()

  // The head is in flight, so the front of the line is behind it.
  assert.equal(outbox.bump(third.id).ok, true)
  assert.deepEqual(outbox.list().map((e) => e.text), ['first', 'third', 'second'])
  outbox.stop()
})

test('the outbox is capped, and says so by refusing', () => {
  const outbox = new Outbox({ send: async () => ({ ok: false, retry: true, reason: 'busy' }), retryMs: 5 })
  for (let i = 0; i < MAX_OUTBOX; i++) {
    assert.ok(outbox.add({ text: `message ${i}`, bozo: 'bozo' }))
  }
  assert.equal(outbox.add({ text: 'one too many', bozo: 'bozo' }), null)
  outbox.stop()
})

test('cancel-all clears what is waiting and leaves what is going in', async () => {
  let release: (outcome: SendOutcome) => void = () => {}
  const outbox = new Outbox({
    send: () => new Promise<SendOutcome>((resolve) => { release = resolve }),
    retryMs: 1,
  })

  outbox.add({ text: 'going in', bozo: 'a' })
  outbox.add({ text: 'waiting', bozo: 'b' })
  await settled()

  const dropped = outbox.cancelAll()
  assert.deepEqual(dropped.map((e) => e.text), ['waiting'])
  assert.deepEqual(outbox.list().map((e) => e.text), ['going in'])
  release({ ok: true })
})
