import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Policy, SPECTATOR, YOLO } from '../src/policy.js'

test('spectator queues instead of sending', () => {
  const policy = new Policy()
  assert.equal(policy.mode, SPECTATOR)

  const result = policy.submit({ text: 'hello', guest: 'bozo' })
  assert.equal(result.action, 'queued')
  assert.equal(policy.list().length, 1)
})

test('yolo sends straight through', () => {
  const policy = new Policy()
  policy.setMode(YOLO)

  const result = policy.submit({ text: 'hello', guest: 'bozo' })
  assert.equal(result.action, 'send')
  assert.equal(result.text, 'hello')
  assert.equal(policy.list().length, 0)
})

test('approve emits once and clears the queue', () => {
  const policy = new Policy()
  const seen = []
  policy.onEvent((event) => seen.push(event.type))

  const { id } = policy.submit({ text: 'ship it', guest: 'bozo' })
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

  const { id } = policy.submit({ text: 'rm -rf', guest: 'bozo' })
  policy.deny(id)
  assert.equal(sent.length, 0)
  assert.equal(policy.list().length, 0)
})

test('newlines collapse so one message stays one turn', () => {
  const policy = new Policy()
  policy.setMode(YOLO)

  const result = policy.submit({ text: 'first\nsecond\r\nthird', guest: 'bozo' })
  assert.equal(result.text, 'first second third')
})

test('empty submissions are ignored', () => {
  const policy = new Policy()
  assert.equal(policy.submit({ text: '   \n  ' }).action, 'ignored')
  assert.equal(policy.submit({ text: null }).action, 'ignored')
})

test('a spectator cannot answer a dialog with keys', () => {
  const policy = new Policy()
  const result = policy.submitKey({ key: 'Enter', guest: 'bozo' })
  assert.equal(result.action, 'refused')
  assert.equal(result.reason, 'spectator')
})

test('yolo lets keys through', () => {
  const policy = new Policy()
  policy.setMode(YOLO)
  assert.equal(policy.submitKey({ key: 'Down', guest: 'bozo' }).action, 'send')
  assert.equal(policy.submitKey({ key: '2', guest: 'bozo' }).action, 'send')
})

test('keys outside the allowlist are rejected even in yolo', () => {
  const policy = new Policy()
  policy.setMode(YOLO)
  for (const key of ['C-c', 'q', 'F1', ';', 'Enter Enter', '']) {
    assert.equal(policy.submitKey({ key, guest: 'bozo' }).action, 'rejected', key)
  }
})

test('unknown modes are rejected', () => {
  const policy = new Policy()
  assert.throws(() => policy.setMode('admin'))
  assert.equal(policy.mode, SPECTATOR)
})
