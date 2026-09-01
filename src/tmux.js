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
const PROMPT = [/for shortcuts/]

// Injecting text while a modal is up types into nothing and the trailing Enter
// confirms whatever option is highlighted, so every write path has to check
// this first.
export async function paneState(name) {
  if (!(await paneAlive(name))) return 'dead'
  const screen = await capturePlain(name)
  if (DIALOG.some((re) => re.test(screen))) return 'dialog'
  if (BUSY.some((re) => re.test(screen))) return 'busy'
  if (PROMPT.some((re) => re.test(screen))) return 'prompt'
  return 'unknown'
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
