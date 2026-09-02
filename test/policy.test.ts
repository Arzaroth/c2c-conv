import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_PENDING, MAX_TEXT, Policy, GALLERY, YOLO } from '../src/policy.js'

test('gallery queues instead of sending', () => {
  const policy = new Policy()
  assert.equal(policy.mode, GALLERY)

  const result = policy.submit({ text: 'hello', bozo: 'bozo' })
  assert.equal(result.action, 'queued')
  assert.equal(policy.list().length, 1)
})

test('ring sends straight through', () => {
  const policy = new Policy()
  policy.setMode(YOLO)

  const result = policy.submit({ text: 'hello', bozo: 'bozo' })
  assert.equal(result.action, 'send')
  assert.equal(result.text, 'hello')
  assert.equal(policy.list().length, 0)
})

test('approve emits once and clears the queue', () => {
  const policy = new Policy()
  const seen: string[] = []
  policy.onEvent((event) => seen.push(event.type))

  const queued = policy.submit({ text: 'ship it', bozo: 'bozo' })
  assert.ok(queued.action === 'queued')
  const id = queued.id
  assert.deepEqual(policy.approve(id)?.text, 'ship it')
  assert.equal(policy.approve(id), null)
  assert.equal(policy.list().length, 0)
  assert.deepEqual(seen, ['queued', 'approved'])
})

test('deny drops the message without sending', () => {
  const policy = new Policy()
  const sent = []
  policy.onEvent((event) => {
    if (event.type === 'approved' || event.type === 'sent') sent.push(event)
  })

  const queued = policy.submit({ text: 'rm -rf', bozo: 'bozo' })
  assert.ok(queued.action === 'queued')
  policy.deny(queued.id)
  assert.equal(sent.length, 0)
  assert.equal(policy.list().length, 0)
})

test('newlines collapse so one message stays one turn', () => {
  const policy = new Policy()
  policy.setMode(YOLO)

  const result = policy.submit({ text: 'first\nsecond\r\nthird', bozo: 'bozo' })
  assert.ok(result.action === 'send')
  assert.equal(result.text, 'first second third')
})

test('empty submissions are ignored', () => {
  const policy = new Policy()
  assert.equal(policy.submit({ text: '   \n  ' }).action, 'ignored')
  assert.equal(policy.submit({ text: null }).action, 'ignored')
})

test('a gallery cannot answer a dialog with keys', () => {
  const policy = new Policy()
  const result = policy.submitKey({ key: 'Enter', bozo: 'bozo' })
  assert.equal(result.action, 'refused')
  assert.equal(result.reason, 'gallery')
})

test('ring lets keys through', () => {
  const policy = new Policy()
  policy.setMode(YOLO)
  assert.equal(policy.submitKey({ key: 'Down', bozo: 'bozo' }).action, 'send')
  assert.equal(policy.submitKey({ key: '2', bozo: 'bozo' }).action, 'send')
})

test('keys outside the allowlist are rejected even in ring', () => {
  const policy = new Policy()
  policy.setMode(YOLO)
  for (const key of ['C-c', 'q', 'F1', ';', 'Enter Enter', '']) {
    assert.equal(policy.submitKey({ key, bozo: 'bozo' }).action, 'rejected', key)
  }
})

test('unknown modes are rejected', () => {
  const policy = new Policy()
  assert.throws(() => policy.setMode('admin'))
  assert.equal(policy.mode, GALLERY)
})

test('an oversized message is rejected rather than queued', () => {
  const policy = new Policy()
  const result = policy.submit({ text: 'x'.repeat(MAX_TEXT + 1), bozo: 'bozo' })
  assert.equal(result.action, 'rejected')
  assert.equal(result.reason, 'too long')
  assert.equal(policy.list().length, 0)
})

test('a message right at the limit still goes through', () => {
  const policy = new Policy()
  assert.equal(policy.submit({ text: 'x'.repeat(MAX_TEXT), bozo: 'bozo' }).action, 'queued')
})

// The queue is the one thing a bozo can grow without the host agreeing to
// anything, so it cannot be unbounded.
test('the pending queue is capped', () => {
  const policy = new Policy()
  for (let i = 0; i < MAX_PENDING; i++) {
    assert.equal(policy.submit({ text: `message ${i}`, bozo: 'bozo' }).action, 'queued')
  }
  const overflow = policy.submit({ text: 'one too many', bozo: 'bozo' })
  assert.equal(overflow.action, 'rejected')
  assert.equal(overflow.reason, 'queue full')
  assert.equal(policy.list().length, MAX_PENDING)
})

test('draining the queue makes room again', () => {
  const policy = new Policy()
  for (let i = 0; i < MAX_PENDING; i++) policy.submit({ text: `m${i}`, bozo: 'bozo' })
  policy.approveAll()
  assert.equal(policy.submit({ text: 'now there is room', bozo: 'bozo' }).action, 'queued')
})

// ring has no queue, so the cap must not accidentally gate it.
test('the queue cap does not apply in ring', () => {
  const policy = new Policy()
  policy.setMode(YOLO)
  for (let i = 0; i < MAX_PENDING + 10; i++) {
    assert.equal(policy.submit({ text: `m${i}`, bozo: 'bozo' }).action, 'send')
  }
})

// The whiteface is the host, and the host can always answer the pane.
test('the whiteface can answer a dialog in gallery', () => {
  const policy = new Policy()
  assert.equal(policy.submitKey({ key: 'Down', bozo: 'host', whiteface: true }).action, 'send')
  assert.equal(policy.submitKey({ key: 'Down', bozo: 'bozo' }).action, 'refused')
})

// Per-bozo trust: the room is thirty seats, and elevating one person must not
// elevate the other twenty-nine.
test('one bozo can be let into the ring without the room going with them', () => {
  const policy = new Policy()
  policy.trust('alice', YOLO)

  assert.equal(policy.mode, GALLERY)
  assert.equal(policy.modeFor('alice'), YOLO)
  assert.equal(policy.modeFor('bob'), GALLERY)
  assert.equal(policy.submit({ text: 'go', bozo: 'alice', bozoId: 'alice' }).action, 'send')
  assert.equal(policy.submit({ text: 'go', bozo: 'bob', bozoId: 'bob' }).action, 'queued')
})

// The pin is worth as much pointing down as up: it is what the host reaches for
// when the room is in yolo and one bozo should not be.
test('a bozo pinned to gallery stays there when the room goes to yolo', () => {
  const policy = new Policy()
  policy.trust('bob', GALLERY)
  policy.setMode(YOLO)

  assert.equal(policy.modeFor('bob'), GALLERY)
  assert.equal(policy.submit({ text: 'go', bozo: 'bob', bozoId: 'bob' }).action, 'queued')
  assert.equal(policy.submit({ text: 'go', bozo: 'alice', bozoId: 'alice' }).action, 'send')
})

test('keys follow the same per-bozo answer as messages', () => {
  const policy = new Policy()
  policy.trust('alice', YOLO)

  assert.equal(policy.submitKey({ key: 'Enter', bozo: 'alice', bozoId: 'alice' }).action, 'send')
  assert.equal(policy.submitKey({ key: 'Enter', bozo: 'bob', bozoId: 'bob' }).action, 'refused')
})

test('untrust puts a bozo back on the room default, and says so once', () => {
  const policy = new Policy()
  const seen: PolicyEvent[] = []
  policy.onEvent((event) => {
    if (event.type === 'trust') seen.push(event)
  })

  policy.trust('alice', YOLO)
  policy.trust('alice', YOLO)
  assert.equal(policy.untrust('alice'), true)
  assert.equal(policy.untrust('alice'), false)

  assert.equal(policy.modeFor('alice'), GALLERY)
  assert.deepEqual(seen, [
    { type: 'trust', bozo: 'alice', mode: YOLO },
    { type: 'trust', bozo: 'alice', mode: null },
  ])
})

// Trust was for the person on the other end of that socket. Whoever comes back
// on the next one is in the gallery until the host says otherwise.
test('trust does not outlive the connection it was given to', () => {
  const policy = new Policy()
  policy.trust('alice', YOLO)
  policy.forget('alice')

  assert.equal(policy.modeFor('alice'), GALLERY)
  assert.equal(policy.trustedMode('alice'), null)
})

test('an unknown mode is refused for one bozo as it is for the room', () => {
  const policy = new Policy()
  assert.throws(() => policy.trust('alice', 'admin'))
  assert.equal(policy.trustedMode('alice'), null)
})

// The old spellings stay valid wherever a mode is named.
test('ring and spectator still name the two modes', () => {
  const policy = new Policy()
  assert.equal(policy.setMode('ring'), YOLO)
  assert.equal(policy.setMode('spectator'), GALLERY)
  assert.equal(policy.trust('alice', 'ring'), YOLO)
})

test('the whiteface still cannot press keys outside the allowlist', () => {
  const policy = new Policy()
  assert.equal(policy.submitKey({ key: 'C-c', bozo: 'host', whiteface: true }).action, 'rejected')
})
