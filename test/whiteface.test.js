import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Whiteface } from '../src/whiteface.js'

const alice = { name: 'alice' }
const bob = { name: 'bob' }

test('the right token claims the role', () => {
  const role = new Whiteface('secret')
  assert.deepEqual(role.claim(alice, 'secret'), { ok: true })
  assert.equal(role.holds(alice), true)
  assert.equal(role.holder, alice)
})

test('a wrong or missing token is refused', () => {
  const role = new Whiteface('secret')
  assert.deepEqual(role.claim(alice, 'guess'), { ok: false, reason: 'bad token' })
  assert.deepEqual(role.claim(alice, undefined), { ok: false, reason: 'bad token' })
  assert.deepEqual(role.claim(alice, 42), { ok: false, reason: 'bad token' })
  assert.equal(role.holds(alice), false)
})

test('without a token nobody can claim it, not even with the empty string', () => {
  const role = new Whiteface('')
  assert.equal(role.enabled, false)
  assert.deepEqual(role.claim(alice, ''), { ok: false, reason: 'bad token' })
})

test('one holder at a time', () => {
  const role = new Whiteface('secret')
  role.claim(alice, 'secret')
  assert.deepEqual(role.claim(bob, 'secret'), { ok: false, reason: 'someone else is the whiteface' })
  assert.equal(role.holds(bob), false)
  assert.equal(role.holds(alice), true)
})

test('the holder can claim again, so a reconnecting hoink is harmless', () => {
  const role = new Whiteface('secret')
  role.claim(alice, 'secret')
  assert.deepEqual(role.claim(alice, 'secret'), { ok: true })
})

test('the role is free again once released, and the token still works', () => {
  const role = new Whiteface('secret')
  role.claim(alice, 'secret')
  assert.equal(role.release(alice), true)
  assert.equal(role.holder, null)
  assert.deepEqual(role.claim(bob, 'secret'), { ok: true })
})

test('only the holder can release it', () => {
  const role = new Whiteface('secret')
  role.claim(alice, 'secret')
  assert.equal(role.release(bob), false)
  assert.equal(role.holds(alice), true)
})

test('nobody holds a fresh role', () => {
  const role = new Whiteface('secret')
  assert.equal(role.holds(alice), false)
  assert.equal(role.holds(null), false)
  assert.equal(role.release(alice), false)
})
