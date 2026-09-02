import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyScreen, readPromptBox } from '../src/tmux.js'

const RULE = '─'.repeat(200)

function screen(...lines: string[]) {
  return lines.join('\n') + '\n'
}

const IDLE = screen(
  '❯ Reply with exactly the word ALPHA and nothing else.',
  '',
  '● ALPHA',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⏸ manual mode on · ? for shortcuts · ← for agents'
)

const DRAFTED = screen(
  '❯ Reply with exactly the word ALPHA and nothing else.',
  '',
  '● ALPHA',
  '',
  RULE,
  '❯ deploy to prod',
  RULE,
  '  ⏸ manual mode on'
)

const BUSY = screen(
  '❯ do a thing',
  '',
  '✻ Working...',
  RULE,
  '❯ ',
  RULE,
  '  esc to interrupt'
)

const DIALOG = screen(
  '  Select model',
  '',
  '    1. Default',
  '  ❯ 2. Opus',
  '',
  '  Enter to confirm · Esc to cancel'
)

test('an empty input box reads as an empty draft', () => {
  assert.equal(readPromptBox(IDLE), '')
  assert.equal(classifyScreen(IDLE), 'prompt')
})

test('a typed draft is read out of the input box', () => {
  assert.equal(readPromptBox(DRAFTED), 'deploy to prod')
})

// The footer loses "for shortcuts" the moment the host types, so anything
// keyed off footer text misreads a drafted pane as unknown.
test('a drafted pane is still a prompt', () => {
  assert.equal(classifyScreen(DRAFTED), 'prompt')
})

// Submitted turns are echoed with the same marker. Scanning for a bare marker
// reads the last submitted message back as if it were an unsent draft, which
// makes every follow-up message look like it would splice into one.
test('the echo of a previous turn is not mistaken for a draft', () => {
  const midRedraw = screen(
    '❯ Reply with exactly the word ALPHA and nothing else.',
    '',
    '● ALPHA'
  )
  assert.equal(readPromptBox(midRedraw), null)
  assert.notEqual(readPromptBox(midRedraw), 'Reply with exactly the word ALPHA and nothing else.')
})

test('no input box is null, which is not the same as empty', () => {
  assert.equal(readPromptBox(screen('just output', 'more output')), null)
  assert.notEqual(readPromptBox(screen('just output')), '')
})

test('a marker without a rule above it is not an input box', () => {
  assert.equal(readPromptBox(screen('some text', '❯ not a box', 'trailing')), null)
})

test('a running turn classifies as busy, not prompt', () => {
  assert.equal(classifyScreen(BUSY), 'busy')
})

test('a dialog outranks everything else on screen', () => {
  assert.equal(classifyScreen(DIALOG), 'dialog')
})

test('a dialog is still a dialog when a prompt box is also drawn', () => {
  const both = screen(RULE, '❯ ', RULE, '  Enter to confirm · Esc to cancel')
  assert.equal(classifyScreen(both), 'dialog')
})
