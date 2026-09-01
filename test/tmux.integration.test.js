// Every bug that cost real time in this project lived in the tmux integration,
// not in the pure logic: text injected into copy mode wedging the write queue,
// bozo text being read as tmux keys, bindings pointing at the wrong session.
// None of that is reachable from a unit test, so these drive a real tmux server.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import * as tmux from '../src/tmux.js'

const run = promisify(execFile)
const NAME = `c2ctest${process.pid}`

const raw = (args) => run('tmux', [...tmux.SERVER_ARGS, ...args])
const settle = (ms = 350) => new Promise((r) => setTimeout(r, ms))

let available = true

before(async () => {
  try {
    await run('tmux', ['-V'])
  } catch {
    available = false
    return
  }
  await tmux.newSession({ name: NAME, cwd: '/tmp', command: 'sh', cols: 80, rows: 20 })
  await settle(500)
})

after(async () => {
  if (available) await tmux.killSession(NAME)
})

test('the session comes up and the pane is alive', { skip: !available }, async () => {
  assert.equal(await tmux.hasSession(NAME), true)
  assert.equal(await tmux.paneAlive(NAME), true)
  const { cols, rows } = await tmux.paneSize(NAME)
  assert.equal(cols, 80)
  assert.equal(rows, 20)
})

// The guarantee that bozo input can never act as a tmux key. tmux falls back
// to literal text for anything it does not recognise as a key name, so this
// only bites when the text is exactly one: "C-u" as a key clears the line,
// while as text it is three characters. Without -l this test fails.
test('bozo text is sent literally, never as a key name', { skip: !available }, async () => {
  await raw(['send-keys', '-t', NAME, 'C-u'])
  await tmux.sendText(NAME, 'marker')
  await tmux.sendText(NAME, 'C-u')
  await settle()

  const screen = await tmux.capturePlain(NAME)
  assert.match(screen, /markerC-u/, 'C-u must arrive as text, not clear the line')

  await raw(['send-keys', '-t', NAME, 'C-u'])
  await settle()
  assert.doesNotMatch(await tmux.capturePlain(NAME), /markerC-u/, 'a real C-u should clear it')
})

// A leading dash must not be parsed as a flag by send-keys.
test('text starting with a dash is not treated as an option', { skip: !available }, async () => {
  await tmux.sendText(NAME, '--not-a-flag')
  await settle()
  assert.match(await tmux.capturePlain(NAME), /--not-a-flag/)
  await raw(['send-keys', '-t', NAME, 'C-u'])
  await settle()
})

// The wedge: text injected into copy mode is read as copy-mode commands, where
// a stray "t" or "/" opens a tmux prompt that swallows everything after it and
// blocks send-keys forever.
test('a pane in copy mode reports copy-mode, not prompt', { skip: !available }, async () => {
  await raw(['copy-mode', '-t', NAME])
  await settle()

  assert.equal(await tmux.paneInMode(NAME), true)
  assert.equal(await tmux.paneState(NAME), 'copy-mode')

  await raw(['send-keys', '-t', NAME, 'q'])
  await settle()
  assert.equal(await tmux.paneInMode(NAME), false)
  assert.notEqual(await tmux.paneState(NAME), 'copy-mode')
})

test('a pane running a plain shell is not mistaken for a claude prompt', { skip: !available }, async () => {
  assert.equal(await tmux.paneState(NAME), 'unknown')
  assert.equal(await tmux.promptDraft(NAME), null)
})

// Key tables are server-global. Baking the session name into the bindings made
// approving from one shared session release a message into another.
test('host bindings resolve the session at press time', { skip: !available }, async () => {
  await tmux.configureHost(NAME, { node: '/usr/bin/node', cli: '/opt/c2c/cli.js', status: '/tmp/status.txt' })

  const { stdout } = await raw(['list-keys', '-T', 'prefix'])
  const binding = stdout.split('\n').find((line) => /\s+a\s+run-shell/.test(line))

  assert.ok(binding, 'prefix+a should be bound')
  assert.match(binding, /#\{session_name\}/)
  assert.doesNotMatch(binding, new RegExp(`-s '${NAME}'`), 'the session name must not be baked in')
})

// run-shell output is opened in a view-mode pane, which takes the pane away
// from claude entirely.
test('host bindings produce no output for tmux to display', { skip: !available }, async () => {
  const { stdout } = await raw(['list-keys', '-T', 'prefix'])
  for (const key of ['a', 'd', 'y']) {
    const binding = stdout.split('\n').find((line) => new RegExp(`\\s+${key}\\s+run-shell`).test(line))
    assert.ok(binding, `prefix+${key} should be bound`)
    assert.match(binding, />\/dev\/null 2>&1/, `prefix+${key} must be silent`)
  }
})

test('the cursor position is readable for seeding a bozo', { skip: !available }, async () => {
  const { x, y } = await tmux.cursor(NAME)
  assert.ok(Number.isInteger(x) && x >= 0)
  assert.ok(Number.isInteger(y) && y >= 0)
})

test('a killed session reports dead rather than throwing', { skip: !available }, async () => {
  const doomed = `${NAME}gone`
  await tmux.newSession({ name: doomed, cwd: '/tmp', command: 'sh' })
  await settle(300)
  await tmux.killSession(doomed)
  await settle(300)

  assert.equal(await tmux.hasSession(doomed), false)
  assert.equal(await tmux.paneState(doomed), 'dead')
})
