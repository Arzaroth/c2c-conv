import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const SERVER = 'c2c'

// -f /dev/null: the c2c server starts with no config at all. Loading the host's
// ~/.tmux.conf would let their prefix, key tables, status bar and plugins decide
// what c2c's documented keys do, and would fight the status line. A shared
// session has to behave the same way on everyone's machine, so the prefix here
// is always the tmux default regardless of what the host uses elsewhere.
// Exported so tests can drive the same server the implementation uses.
export const SERVER_ARGS = ['-L', SERVER, '-f', '/dev/null']

// The timeout matters: send-keys blocks indefinitely if the pane is sitting at
// a tmux command prompt, and a hung call would wedge the write queue for the
// rest of the session.
function tmux(args: string[]) {
  return run('tmux', [...SERVER_ARGS, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10000,
  })
}

export async function hasSession(name: string): Promise<boolean> {
  try {
    await tmux(['has-session', '-t', name])
    return true
  } catch {
    return false
  }
}

// How many lines of pane history tmux keeps, which is the ceiling on what the
// scrollback view can show. Set on the server before the pane exists: a pane
// takes its limit at creation and ignores the option afterwards.
export const HISTORY_LIMIT = 10000

export async function newSession(
  { name, cwd, command, cols = 200, rows = 50 }:
  { name: string; cwd: string; command: string; cols?: number; rows?: number },
): Promise<void> {
  try {
    await tmux(['set-option', '-g', 'history-limit', String(HISTORY_LIMIT)])
  } catch {}
  await tmux([
    'new-session', '-d',
    '-s', name,
    '-c', cwd,
    '-x', String(cols),
    '-y', String(rows),
    command,
  ])
}

// The status line reads a file the ringmaster keeps up to date rather than shelling
// out to the CLI every couple of seconds.
export async function configureHost(
  name: string,
  { node, cli, status }: { node: string; cli: string; status: string },
): Promise<void> {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
  // Output from run-shell is opened in a view-mode pane, which hijacks the
  // session: the pane stops being claude and starts interpreting keystrokes as
  // copy-mode commands. The bindings have to be completely silent.
  //
  // #{session_name} is resolved by tmux when the key is pressed. Baking the name
  // in would be wrong with more than one shared session, because key tables are
  // server-global: the last session configured would win, and approving from one
  // session would release a message into another.
  const run = (args: string) => `${quote(node)} ${quote(cli)} ${args} -s '#{session_name}' >/dev/null 2>&1`

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

export async function killSession(name: string): Promise<void> {
  try {
    await tmux(['kill-session', '-t', name])
  } catch {}
}

export async function paneSize(name: string): Promise<PaneSize> {
  const { stdout } = await tmux(['display-message', '-p', '-t', name, '#{pane_width} #{pane_height}'])
  const [cols, rows] = stdout.trim().split(/\s+/).map(Number) as [number, number]
  return { cols, rows }
}

export async function capturePane(name: string): Promise<string> {
  const { stdout } = await tmux(['capture-pane', '-p', '-e', '-t', name])
  return stdout
}

// The pane plus what has scrolled off it. A separate surface from the live
// mirror by construction: this is a snapshot, and the mirror repaints in place
// against a fixed grid, so anything taller than the grid cannot live in it.
export async function captureScrollback(name: string, lines: number): Promise<string> {
  const wanted = Math.max(0, Math.min(Math.trunc(lines) || 0, HISTORY_LIMIT))
  const { stdout } = await tmux(['capture-pane', '-p', '-e', '-S', `-${wanted}`, '-t', name])
  return stdout
}

// -e wraps each word in its own SGR pair, which breaks phrase matching, so
// state detection reads an uncoloured capture instead.
export async function capturePlain(name: string): Promise<string> {
  const { stdout } = await tmux(['capture-pane', '-p', '-t', name])
  return stdout
}

// The live stream positions the cursor relatively, so a bozo seeded with a
// snapshot has to start from the host's actual cursor or every later redraw
// lands a row off.
export async function cursor(name: string): Promise<CursorPosition> {
  const { stdout } = await tmux(['display-message', '-p', '-t', name, '#{cursor_x} #{cursor_y}'])
  const [x, y] = stdout.trim().split(/\s+/).map(Number) as [number, number]
  return { x, y }
}

export async function panePid(name: string): Promise<number | null> {
  try {
    const { stdout } = await tmux(['display-message', '-p', '-t', name, '#{pane_pid}'])
    return Number(stdout.trim()) || null
  } catch {
    return null
  }
}

export async function paneAlive(name: string): Promise<boolean> {
  try {
    const { stdout } = await tmux(['display-message', '-p', '-t', name, '#{pane_dead}'])
    return stdout.trim() === '0'
  } catch {
    return false
  }
}

const DIALOG = [/Enter to confirm/i, /Esc to (cancel|reject|go back)/i]
const BUSY = [/esc to interrupt/i]

// Claude Code paints a suggested prompt into the empty box in dim text, the one
// tab accepts. Nobody typed it and it is repainted after every turn, so reading
// it as a draft wedges every queued message behind a line nobody wrote. The
// characters are identical either way: only the colour tells the two apart.
const GHOST = /\x1b\[2m.*?(?:\x1b\[(?:0|22)m|$)/g
const SGR = /\x1b\[[0-9;]*m/g

function unpaint(line: string): string {
  return line.replace(GHOST, '').replace(SGR, '')
}

// The footer text changes as soon as the host types a draft, so the input box
// is identified structurally instead: a prompt marker sitting directly under
// the box's top rule. Prompt markers in the scrollback are the echo of previous
// turns and have no rule above them, so scanning for a bare marker would read
// the last submitted message back as if it were an unsent draft.
// Returns null when there is no input box on screen at all.
export function readPromptBox(screen: string): string | null {
  const tail = screen.split('\n').map(unpaint).slice(-8)
  const index = tail.findIndex((line) => /^\s*❯/.test(line))
  if (index <= 0 || !/^\s*─{20,}/.test(tail[index - 1])) return null
  return tail[index].replace(/^\s*❯\s?/, '').trim()
}

// Injecting text while a modal is up types into nothing and the trailing Enter
// confirms whatever option is highlighted, so every write path has to check
// this first.
export function classifyScreen(screen: string): Extract<PaneState, 'dialog' | 'busy' | 'prompt' | 'unknown'> {
  if (DIALOG.some((re) => re.test(screen))) return 'dialog'
  if (BUSY.some((re) => re.test(screen))) return 'busy'
  if (readPromptBox(screen) !== null) return 'prompt'
  return 'unknown'
}

export async function paneInMode(name: string): Promise<boolean> {
  try {
    const { stdout } = await tmux(['display-message', '-p', '-t', name, '#{pane_in_mode}'])
    return stdout.trim() === '1'
  } catch {
    return false
  }
}

export async function paneState(name: string): Promise<PaneState> {
  if (!(await paneAlive(name))) return 'dead'
  // In copy or view mode the pane is no longer claude's input: sent text is
  // read as copy-mode commands, where a stray "t" or "/" opens a tmux prompt
  // that swallows the rest and blocks send-keys forever.
  if (await paneInMode(name)) return 'copy-mode'
  return classifyScreen(await capturePlain(name))
}

// Anything sitting in the input box is the host's unsent draft, and injecting
// would splice bozo text into the middle of it. null means the box is not on
// screen, which is not the same as it being empty. This is the one read that
// keeps its escapes: a suggestion and a draft are the same characters in
// different colours, and stripping them first would lose the difference.
export async function promptDraft(name: string): Promise<string | null> {
  return readPromptBox(await capturePane(name))
}

export async function waitForPrompt(name: string, timeoutMs = 15000): Promise<PaneState> {
  const deadline = Date.now() + timeoutMs
  let state = await paneState(name)
  while (state === 'busy' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    state = await paneState(name)
  }
  return state
}

// -l sends the text literally so bozo input can never be read as a tmux key
// name, and -- stops a leading dash from being parsed as a flag.
export async function sendText(name: string, text: string): Promise<void> {
  await tmux(['send-keys', '-t', name, '-l', '--', text])
}

export async function sendKey(name: string, key: string): Promise<void> {
  await tmux(['send-keys', '-t', name, key])
}

export async function submit(name: string, text: string): Promise<void> {
  await sendText(name, text)
  await sendKey(name, 'Enter')
}

// display-message expands #{...} formats, and most of what gets notified is a
// bozo's name or a bozo's words. A doubled hash is the literal one.
export async function notify(name: string, message: string): Promise<void> {
  try {
    await tmux(['display-message', '-t', name, message.replace(/#/g, '##')])
  } catch {}
}

export async function startPipe(name: string, file: string): Promise<void> {
  await tmux(['pipe-pane', '-t', name])
  await tmux(['pipe-pane', '-t', name, `cat >> ${JSON.stringify(file)}`])
}

export async function stopPipe(name: string): Promise<void> {
  try {
    await tmux(['pipe-pane', '-t', name])
  } catch {}
}

export function attachArgs(name: string): string[] {
  return ['-L', SERVER, '-f', '/dev/null', 'attach-session', '-t', name]
}
