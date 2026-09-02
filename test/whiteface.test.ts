import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Whiteface, WHITEFACE_COMMANDS } from '../src/whiteface.js'

interface Holder {
  name: string
}

const alice: Holder = { name: 'alice' }
const bob: Holder = { name: 'bob' }

test('the right token claims the role', () => {
  const role = new Whiteface<Holder>('secret')
  assert.deepEqual(role.claim(alice, 'secret'), { ok: true })
  assert.equal(role.holds(alice), true)
  assert.equal(role.holder, alice)
})

test('a wrong or missing token is refused', () => {
  const role = new Whiteface<Holder>('secret')
  assert.deepEqual(role.claim(alice, 'guess'), { ok: false, reason: 'bad token' })
  assert.deepEqual(role.claim(alice, undefined), { ok: false, reason: 'bad token' })
  assert.deepEqual(role.claim(alice, 42), { ok: false, reason: 'bad token' })
  assert.equal(role.holds(alice), false)
})

test('without a token nobody can claim it, not even with the empty string', () => {
  const role = new Whiteface<Holder>('')
  assert.equal(role.enabled, false)
  assert.deepEqual(role.claim(alice, ''), { ok: false, reason: 'bad token' })
})

test('one holder at a time', () => {
  const role = new Whiteface<Holder>('secret')
  role.claim(alice, 'secret')
  assert.deepEqual(role.claim(bob, 'secret'), { ok: false, reason: 'someone else is the whiteface' })
  assert.equal(role.holds(bob), false)
  assert.equal(role.holds(alice), true)
})

test('the holder can claim again, so a reconnecting hoink is harmless', () => {
  const role = new Whiteface<Holder>('secret')
  role.claim(alice, 'secret')
  assert.deepEqual(role.claim(alice, 'secret'), { ok: true })
})

test('the role is free again once released, and the token still works', () => {
  const role = new Whiteface<Holder>('secret')
  role.claim(alice, 'secret')
  assert.equal(role.release(alice), true)
  assert.equal(role.holder, null)
  assert.deepEqual(role.claim(bob, 'secret'), { ok: true })
})

test('only the holder can release it', () => {
  const role = new Whiteface<Holder>('secret')
  role.claim(alice, 'secret')
  assert.equal(role.release(bob), false)
  assert.equal(role.holds(alice), true)
})

test('nobody holds a fresh role', () => {
  const role = new Whiteface<Holder>('secret')
  assert.equal(role.holds(alice), false)
  assert.equal(role.holds(null), false)
  assert.equal(role.release(alice), false)
})

// status carries the token and stop ends the session: those stay with c2c ctl.
test('the whiteface gets the release, drop, outbox and mode commands but not status or stop', () => {
  for (const cmd of ['approve', 'deny', 'approve-next', 'deny-next', 'approve-all', 'deny-all', 'mode', 'list',
    'outbox', 'cancel', 'cancel-all', 'bump']) {
    assert.equal(WHITEFACE_COMMANDS.has(cmd), true, cmd)
  }
  // say is not refused so much as pointless here: a browser has the f2f lane
  // itself, and c2c say exists for the host, who does not.
  for (const cmd of ['status', 'stop', 'say', 'submit', 'key', 'hoink', 'name', 'refresh', 'f2f', 'scrollback']) {
    assert.equal(WHITEFACE_COMMANDS.has(cmd), false, cmd)
  }
})

test('rotating the token puts the holder out and kills the old secret', () => {
  const role = new Whiteface<Holder>('secret')
  role.claim(alice, 'secret')
  role.rotate('fresh')

  assert.equal(role.holder, null)
  assert.deepEqual(role.claim(alice, 'secret'), { ok: false, reason: 'bad token' })
  assert.deepEqual(role.claim(bob, 'fresh'), { ok: true })
})

test('a rotated role is still a role: it does not turn itself off', () => {
  const role = new Whiteface<Holder>('secret')
  role.rotate('fresh')
  assert.equal(role.enabled, true)
})
