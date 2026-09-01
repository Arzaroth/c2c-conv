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
  const seen = []
  policy.onEvent((event) => seen.push(event.type))

  const { id } = policy.submit({ text: 'ship it', bozo: 'bozo' })
  assert.deepEqual(policy.approve(id).text, 'ship it')
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

  const { id } = policy.submit({ text: 'rm -rf', bozo: 'bozo' })
  policy.deny(id)
  assert.equal(sent.length, 0)
  assert.equal(policy.list().length, 0)
})

test('newlines collapse so one message stays one turn', () => {
  const policy = new Policy()
  policy.setMode(YOLO)

  const result = policy.submit({ text: 'first\nsecond\r\nthird', bozo: 'bozo' })
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

// Headless sessions start in yolo, because the approval keys need an attached
// terminal and a detached gallery session is one nobody can ever release.
test('a mode can be chosen at construction time', () => {
  const policy = new Policy()
  assert.equal(policy.mode, GALLERY)
  assert.equal(policy.setMode(YOLO), YOLO)
  assert.equal(policy.submit({ text: 'straight in', bozo: 'b' }).action, 'send')
})
