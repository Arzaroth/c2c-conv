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

// Captured off a live pane: the suggestion Claude Code offers after a turn is
// dim, and the box under it is empty. Reading it as a draft held every queued
// message behind a line nobody had typed.
const SUGGESTED = screen(
  '● ALPHA',
  '',
  RULE,
  '\x1b[39m❯ \x1b[2mnettoie les chemins obsolètes\x1b[0m',
  RULE,
  '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents'
)

test('a dim suggestion is not a draft', () => {
  assert.equal(readPromptBox(SUGGESTED), '')
  assert.equal(classifyScreen(SUGGESTED), 'prompt')
})

test('a coloured draft is still a draft', () => {
  const coloured = screen(RULE, '\x1b[39m❯ deploy to prod\x1b[0m', RULE, '  ⏸ manual mode on')
  assert.equal(readPromptBox(coloured), 'deploy to prod')
})

// The half-typed case is the one that has to survive: what the host put in is
// kept, and only the completion offered after it is dropped.
test('what was typed survives the suggestion offered after it', () => {
  const half = screen(RULE, '❯ deploy \x1b[2mto prod\x1b[0m', RULE, '  ⏸ manual mode on')
  assert.equal(readPromptBox(half), 'deploy')
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

test('a dialog hint left in the transcript above the input box is not a dialog', () => {
  const cancelled = screen(
    '● Usage limit reached · continuing automatically at 2pm · esc to cancel',
    '',
    '✻ Sautéed for 0s · done 6:54 PM',
    '',
    '● Automatic continue cancelled · /rate-limit-options to re-arm',
    RULE,
    '❯ ',
    RULE,
    '  ⏵⏵ auto mode on (shift+tab to cycle)'
  )
  assert.equal(classifyScreen(cancelled), 'prompt')
})

test('a dialog hint with no input box drawn is still a dialog', () => {
  assert.equal(classifyScreen(screen('● Usage limit reached · esc to cancel', '', '  waiting')), 'dialog')
})

// /model answers in one line, so its echo sat in the same last eight lines as
// the input box, was taken for the box, and the session read as unknown with
// the outbox waiting behind it for good.
test('a short turn echoed just above the input box does not hide the box', () => {
  const shortTurn = screen(
    '❯ /model',
    '  ⎿  Set model to Haiku 5.5 and saved as your default for new sessions',
    '',
    RULE,
    '❯ ',
    RULE,
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  )
  assert.equal(classifyScreen(shortTurn), 'prompt')
  assert.equal(readPromptBox(shortTurn), '')
})
