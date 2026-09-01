import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const SERVER = 'c2c'

function tmux(args) {
  return run('tmux', ['-L', SERVER, ...args], { maxBuffer: 16 * 1024 * 1024 })
}

export async function hasSession(name) {
  try {
    await tmux(['has-session', '-t', name])
    return true
  } catch {
    return false
  }
}

export async function newSession({ name, cwd, command, cols = 200, rows = 50 }) {
  await tmux([
    'new-session', '-d',
    '-s', name,
    '-c', cwd,
    '-x', String(cols),
    '-y', String(rows),
    command,
  ])
}

// The status line reads a file the relay keeps up to date rather than shelling
// out to the CLI every couple of seconds.
export async function configureHost(name, { node, cli, status }) {
  const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`
  const run = (args) => `${quote(node)} ${quote(cli)} ${args} -s ${quote(name)}`

  await tmux(['set-option', '-t', name, 'status', 'on'])
  await tmux(['set-option', '-t', name, 'status-interval', '2'])
  await tmux(['set-option', '-t', name, 'status-style', 'bg=#1a1624,fg=#f4efff'])
  await tmux(['set-option', '-t', name, 'status-left', ''])
  await tmux(['set-option', '-t', name, 'window-status-format', ''])
  await tmux(['set-option', '-t', name, 'window-status-current-format', ''])
  await tmux(['set-option', '-t', name, 'status-right-length', '120'])
  await tmux([
    'set-option', '-t', name, 'status-right',
    `#(cat ${JSON.stringify(status)} 2>/dev/null)`,
  ])

  for (const [key, args] of [
    ['a', 'ctl approve-next'],
    ['d', 'ctl deny-next'],
    ['y', 'ctl mode toggle'],
  ]) {
    await tmux(['bind-key', '-T', 'prefix', key, 'run-shell', '-b', run(args)])
  }
}

export async function killSession(name) {
  try {
    await tmux(['kill-session', '-t', name])
  } catch {}
}

export async function paneSize(name) {
  const { stdout } = await tmux(['display-message', '-p', '-t', name, '#{pane_width} #{pane_height}'])
  const [cols, rows] = stdout.trim().split(/\s+/).map(Number)
  return { cols, rows }
}

export async function capturePane(name) {
  const { stdout } = await tmux(['capture-pane', '-p', '-e', '-t', name])
  return stdout
}

// -e wraps each word in its own SGR pair, which breaks phrase matching, so
// state detection reads an uncoloured capture instead.
export async function capturePlain(name) {
  const { stdout } = await tmux(['capture-pane', '-p', '-t', name])
  return stdout
}

// The live stream positions the cursor relatively, so a guest seeded with a
// snapshot has to start from the host's actual cursor or every later redraw
// lands a row off.
export async function cursor(name) {
  const { stdout } = await tmux(['display-message', '-p', '-t', name, '#{cursor_x} #{cursor_y}'])
  const [x, y] = stdout.trim().split(/\s+/).map(Number)
  return { x, y }
}

export async function paneAlive(name) {
  try {
    const { stdout } = await tmux(['display-message', '-p', '-t', name, '#{pane_dead}'])
    return stdout.trim() === '0'
  } catch {
    return false
  }
}

const DIALOG = [/Enter to confirm/i, /Esc to (cancel|reject|go back)/i]
const BUSY = [/esc to interrupt/i]

// The footer text changes as soon as the host types a draft, so the input box
// is identified structurally instead: a prompt marker sitting directly under
// the box's top rule. Prompt markers in the scrollback are the echo of previous
// turns and have no rule above them, so scanning for a bare marker would read
// the last submitted message back as if it were an unsent draft.
// Returns null when there is no input box on screen at all.
export function readPromptBox(screen) {
  const tail = screen.split('\n').slice(-8)
  const index = tail.findIndex((line) => /^\s*❯/.test(line))
  if (index <= 0 || !/^\s*─{20,}/.test(tail[index - 1])) return null
  return tail[index].replace(/^\s*❯\s?/, '').trim()
}

// Injecting text while a modal is up types into nothing and the trailing Enter
// confirms whatever option is highlighted, so every write path has to check
// this first.
export function classifyScreen(screen) {
  if (DIALOG.some((re) => re.test(screen))) return 'dialog'
  if (BUSY.some((re) => re.test(screen))) return 'busy'
  if (readPromptBox(screen) !== null) return 'prompt'
  return 'unknown'
}

export async function paneState(name) {
  if (!(await paneAlive(name))) return 'dead'
  return classifyScreen(await capturePlain(name))
}

// Anything sitting in the input box is the host's unsent draft, and injecting
// would splice guest text into the middle of it. null means the box is not on
// screen, which is not the same as it being empty.
export async function promptDraft(name) {
  return readPromptBox(await capturePlain(name))
}

export async function waitForPrompt(name, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let state = await paneState(name)
  while (state === 'busy' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    state = await paneState(name)
  }
  return state
}

// -l sends the text literally so guest input can never be read as a tmux key
// name, and -- stops a leading dash from being parsed as a flag.
export async function sendText(name, text) {
  await tmux(['send-keys', '-t', name, '-l', '--', text])
}

export async function sendKey(name, key) {
  await tmux(['send-keys', '-t', name, key])
}

export async function submit(name, text) {
  await sendText(name, text)
  await sendKey(name, 'Enter')
}

export async function notify(name, message) {
  try {
    await tmux(['display-message', '-t', name, message])
  } catch {}
}

export async function startPipe(name, file) {
  await tmux(['pipe-pane', '-t', name])
  await tmux(['pipe-pane', '-t', name, `cat >> ${JSON.stringify(file)}`])
}

export async function stopPipe(name) {
  try {
    await tmux(['pipe-pane', '-t', name])
  } catch {}
}

export function attachArgs(name) {
  return ['-L', SERVER, 'attach-session', '-t', name]
}
