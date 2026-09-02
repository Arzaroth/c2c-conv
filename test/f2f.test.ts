import { test } from 'node:test'
import assert from 'node:assert/strict'

import { F2F_HISTORY, Farce, MAX_F2F_TEXT } from '../src/f2f.js'

test('a line is kept with who said it', () => {
  const farce = new Farce()
  const msg = farce.say({ from: 'bozo', text: 'wait, do not run that' })

  assert.equal(msg?.from, 'bozo')
  assert.equal(msg?.text, 'wait, do not run that')
  assert.equal(farce.history().length, 1)
})

test('nothing is said when there is nothing to say', () => {
  const farce = new Farce()
  assert.equal(farce.say({ from: 'bozo', text: '   ' }), null)
  assert.equal(farce.say({ from: 'bozo', text: 42 }), null)
  assert.equal(farce.history().length, 0)
})

test('newlines collapse so one line stays one line', () => {
  const farce = new Farce()
  const msg = farce.say({ from: 'bozo', text: 'first\nsecond\r\nthird' })
  assert.equal(msg?.text, 'first second third')
})

test('a very long line is cut rather than refused', () => {
  const farce = new Farce()
  const msg = farce.say({ from: 'bozo', text: 'x'.repeat(MAX_F2F_TEXT + 500) })
  assert.equal(msg?.text.length, MAX_F2F_TEXT)
})

test('the host is marked, so the pane and the browser can be told apart', () => {
  const farce = new Farce()
  assert.equal(farce.say({ from: 'host', text: 'on it', host: true })?.host, true)
  assert.equal(farce.say({ from: 'bozo', text: 'ta' })?.host, false)
})

test('history is bounded and the greeting takes the tail of it', () => {
  const farce = new Farce()
  for (let i = 0; i < F2F_HISTORY + 20; i++) farce.say({ from: 'bozo', text: `line ${i}` })

  assert.equal(farce.history().length, F2F_HISTORY)
  assert.equal(farce.history()[0].text, 'line 20')
  assert.deepEqual(farce.history(2).map((m) => m.text), [
    `line ${F2F_HISTORY + 18}`,
    `line ${F2F_HISTORY + 19}`,
  ])
})
