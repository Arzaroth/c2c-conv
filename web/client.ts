import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

const params = new URLSearchParams(location.search)
const token = params.get('t') || ''
// Presenting this makes you the whiteface: the clown who runs the ring.
const whitefaceToken = params.get('w') || ''

// index.html is the only place these ids exist, so a missing one is a broken
// build rather than something to render around.
function pick<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error(`c2c: #${id} is missing from the page`)
  return found as T
}

const el = {
  mode: pick<HTMLDivElement>('mode'),
  modeText: pick<HTMLSpanElement>('mode-text'),
  link: pick<HTMLDivElement>('link'),
  who: pick<HTMLInputElement>('who'),
  pending: pick<HTMLDivElement>('pending'),
  form: pick<HTMLFormElement>('composer'),
  text: pick<HTMLInputElement>('text'),
  send: pick<HTMLButtonElement>('send'),
  hint: pick<HTMLDivElement>('hint'),
  screen: pick<HTMLDivElement>('screen'),
  keypad: pick<HTMLDivElement>('keypad'),
  history: pick<HTMLDivElement>('history'),
  historyList: pick<HTMLDivElement>('history-list'),
  historyToggle: pick<HTMLButtonElement>('history-toggle'),
  f2f: pick<HTMLDivElement>('f2f'),
  f2fScroll: pick<HTMLDivElement>('f2f-scroll'),
  f2fList: pick<HTMLDivElement>('f2f-list'),
  f2fForm: pick<HTMLFormElement>('f2f-form'),
  f2fText: pick<HTMLInputElement>('f2f-text'),
  f2fToggle: pick<HTMLButtonElement>('f2f-toggle'),
  scrollback: pick<HTMLDivElement>('scrollback'),
  scrollToggle: pick<HTMLButtonElement>('scroll-toggle'),
  scrollScreen: pick<HTMLDivElement>('scroll-screen'),
  scrollBar: pick<HTMLDivElement>('scroll-bar'),
  scrollCount: pick<HTMLSpanElement>('scroll-count'),
  outbox: pick<HTMLDivElement>('outbox'),
}

// Not "history": this is a plain script, so a top-level binding by that name
// would be shadowing window.history.
const turns: TranscriptEntry[] = []
const lane: F2fMessage[] = []

// Four surfaces, one at a time, and the live mirror is what is underneath them
// all. The scrollback is a snapshot rather than a fifth thing the pane stream
// writes into: the mirror pins its cursor to a fixed grid, so a view that
// scrolls cannot be the same surface without every later redraw landing a row
// off.
type Panel = 'history' | 'f2f' | 'scroll'
type View = 'live' | Panel

const PANELS: { name: Panel; label: string; tab: HTMLButtonElement; panel: HTMLElement }[] = [
  { name: 'f2f', label: 'f2f', tab: el.f2fToggle, panel: el.f2f },
  { name: 'history', label: 'history', tab: el.historyToggle, panel: el.history },
  { name: 'scroll', label: 'scrollback', tab: el.scrollToggle, panel: el.scrollback },
]

let showing: View = 'live'
const unseen: Record<Panel, number> = { history: 0, f2f: 0, scroll: 0 }

function renderTabs(): void {
  for (const { name, label, tab } of PANELS) {
    tab.classList.toggle('on', showing === name)
    tab.textContent = label
    const count = unseen[name]
    if (showing !== name && count) {
      const badge = document.createElement('span')
      badge.className = 'count'
      badge.textContent = count > 99 ? '99+' : String(count)
      tab.appendChild(badge)
    }
  }
}

function setView(next: View): void {
  showing = next
  el.screen.hidden = next !== 'live'
  for (const { name, panel } of PANELS) panel.hidden = name !== next

  if (next === 'live') rescale()
  if (next === 'history') {
    unseen.history = 0
    renderHistory()
    el.history.scrollTop = el.history.scrollHeight
  }
  if (next === 'f2f') {
    unseen.f2f = 0
    renderLane()
    el.f2fScroll.scrollTop = el.f2fScroll.scrollHeight
    el.f2fText.focus()
  }
  // A snapshot is only worth what it was worth when it was taken, so opening
  // the tab always asks for a fresh one.
  if (next === 'scroll') {
    ensureScrollTerm()
    requestScrollback()
    rescale()
  }
  renderTabs()
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

for (const { name, tab } of PANELS) {
  tab.addEventListener('click', () => setView(showing === name ? 'live' : name))
}

function turnElement(entry: TranscriptEntry): HTMLDivElement {
  const row = document.createElement('div')
  row.className = `turn ${entry.role}`

  const who = document.createElement('span')
  who.className = 'who'
  who.textContent = entry.role === 'user' ? '🤡 typed' : '● claude'
  row.appendChild(who)

  if (entry.text) {
    const body = document.createElement('div')
    body.className = 'body'
    body.textContent = entry.text
    row.appendChild(body)
  }

  if (entry.tools?.length) {
    const tools = document.createElement('div')
    tools.className = 'tools'
    for (const name of entry.tools) {
      const chip = document.createElement('span')
      chip.className = 'tool'
      chip.textContent = name
      tools.appendChild(chip)
    }
    row.appendChild(tools)
  }

  return row
}

function appendTurn(entry: TranscriptEntry): void {
  const atBottom = el.history.scrollTop + el.history.clientHeight >= el.history.scrollHeight - 40
  el.historyList.querySelector('.history-empty')?.remove()
  el.historyList.appendChild(turnElement(entry))
  if (showing === 'history' && atBottom) el.history.scrollTop = el.history.scrollHeight
}

function renderHistory(): void {
  el.historyList.replaceChildren()
  if (!turns.length) {
    const empty = document.createElement('div')
    empty.className = 'history-empty'
    empty.textContent = 'Nothing yet. The conversation shows up here as it happens.'
    el.historyList.appendChild(empty)
    return
  }
  for (const entry of turns) el.historyList.appendChild(turnElement(entry))
}

/* ── farce-to-farce ───────────────────────────────────────────────────────── */

function lineElement(msg: F2fMessage): HTMLDivElement {
  const row = document.createElement('div')
  row.className = `line${msg.host ? ' host' : msg.from === bozoName ? ' mine' : ''}`

  const from = document.createElement('span')
  from.className = 'from'
  from.textContent = msg.from

  const said = document.createElement('span')
  said.className = 'said'
  said.textContent = msg.text

  const at = document.createElement('span')
  at.className = 'at'
  at.textContent = clock(msg.at)

  row.append(from, said, at)
  return row
}

function appendLine(msg: F2fMessage): void {
  const atBottom = el.f2fScroll.scrollTop + el.f2fScroll.clientHeight >= el.f2fScroll.scrollHeight - 40
  el.f2fList.querySelector('.lane-empty')?.remove()
  el.f2fList.appendChild(lineElement(msg))
  if (atBottom) el.f2fScroll.scrollTop = el.f2fScroll.scrollHeight
}

function renderLane(): void {
  el.f2fList.replaceChildren()
  if (!lane.length) {
    const empty = document.createElement('div')
    empty.className = 'lane-empty'
    empty.textContent = 'Nobody has said anything yet. Claude will not hear any of it.'
    el.f2fList.appendChild(empty)
    return
  }
  for (const msg of lane) el.f2fList.appendChild(lineElement(msg))
}

el.f2fForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const text = el.f2fText.value.trim()
  if (!text) return
  send({ type: 'f2f', text })
  el.f2fText.value = ''
})

el.mode.addEventListener('click', () => {
  if (whiteface) send({ type: 'mode', mode: 'toggle' })
})

let paneState: PaneState = 'unknown'

function refreshKeypad(): void {
  el.keypad.hidden = paneState !== 'dialog'
  const canPress = mode === 'yolo' || whiteface
  for (const button of el.keypad.querySelectorAll('button')) button.disabled = !canPress
  const label = el.keypad.querySelector('.keypad-label')
  if (label) {
    label.textContent = canPress
      ? '🤡 the session is asking'
      : '🤡 the session is asking - only the host can answer'
  }
}

el.keypad.addEventListener('click', (event) => {
  const key = (event.target as HTMLElement | null)?.dataset?.key
  if (key) send({ type: 'key', key })
})

const term = new Terminal({
  cursorBlink: false,
  disableStdin: true,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 13,
  // The bozo mirrors a fixed-size pane that repaints in place, so scrollback
  // would only collect redraw debris.
  scrollback: 0,
  theme: {
    background: '#0b0910',
    foreground: '#f4efff',
    cursor: '#ff2e4c',
    selectionBackground: '#a06bff55',
  },
})
term.open(el.screen)
term.resize(80, 24)

// The scrollback view is a second terminal on purpose. It is fed one snapshot
// at a time and never sees the live stream, so it can have a scrollback buffer
// without any of it landing under the mirror's cursor arithmetic.
// Built on first use: xterm measures a character when it opens, and opening it
// inside a hidden panel measures zero.
let scrollTerm: Terminal | null = null

function ensureScrollTerm(): Terminal {
  if (!scrollTerm) {
    scrollTerm = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      scrollback: 20000,
      theme: {
        background: '#0b0910',
        foreground: '#f4efff',
        cursor: '#0b0910',
        selectionBackground: '#a06bff55',
      },
    })
    scrollTerm.open(el.scrollScreen)
    scrollTerm.resize(80, 24)
  }
  return scrollTerm
}

function requestScrollback(): void {
  el.scrollCount.textContent = 'asking for a snapshot...'
  send({ type: 'scrollback', lines: 5000 })
}

function applyScrollback(msg: { data: string; cols: number; rows: number; lines: number }): void {
  const surface = ensureScrollTerm()
  surface.reset()
  surface.resize(msg.cols, msg.rows)
  // Same as the live snapshot: capture-pane separates rows with a bare LF,
  // which moves down without returning to column 0.
  surface.write(msg.data.replace(/\r?\n$/, '').replace(/\r?\n/g, '\r\n'))
  surface.scrollToBottom()
  el.scrollCount.textContent = `${msg.lines} lines, taken at ${clock(Date.now())}`
  rescale()
}

el.scrollBar.addEventListener('click', (event) => {
  const what = (event.target as HTMLElement | null)?.dataset?.scroll
  if (!what) return
  const surface = ensureScrollTerm()
  if (what === 'top') surface.scrollToTop()
  if (what === 'bottom') surface.scrollToBottom()
  if (what === 'up') surface.scrollPages(-1)
  if (what === 'down') surface.scrollPages(1)
  if (what === 'refresh') requestScrollback()
})

// The bozo terminal has to keep the host's exact column count or the live ANSI
// stream lands in the wrong places, so the whole grid is scaled to fit rather
// than reflowed.
// Fit by font size rather than a CSS transform: xterm then renders natively at
// the chosen size, so the text stays crisp instead of being scaled bitmap. The
// host's rows and columns are fixed, so whatever is left over after fitting is
// aspect-ratio letterboxing and gets centred.
let pendingFit = false

// requestAnimationFrame does not fire in a background tab, so using it alone to
// release the coalescing flag latches it on forever and every later fit is
// swallowed. The timer is the fallback that still runs when hidden.
function rescale(): void {
  if (pendingFit) return
  pendingFit = true

  const run = () => {
    if (!pendingFit) return
    pendingFit = false
    try {
      fit(el.screen)
      fit(el.scrollScreen)
    } catch {}
  }

  requestAnimationFrame(run)
  setTimeout(run, 60)
}

function fit(host: HTMLElement): void {
  const frame = host.querySelector<HTMLElement>('.xterm')
  const grid = host.querySelector<HTMLElement>('.xterm-screen')
  if (!frame || !grid) return

  // Bail before touching the transform. Clearing it first and then giving up on
  // an unmeasurable container leaves the terminal permanently unscaled, which
  // is what happens every time a redraw arrives while another panel is open. A
  // hidden panel measures zero, so this covers both.
  const availableWidth = host.clientWidth - 16
  const availableHeight = host.clientHeight - 12
  if (availableWidth <= 0 || availableHeight <= 0) return

  frame.style.transform = 'none'
  // Pin the element to the character grid: left to itself it stretches to the
  // container, which both mispositions the centring and strands the scrollbar
  // out in the empty gap.
  frame.style.width = `${grid.offsetWidth}px`
  frame.style.height = `${grid.offsetHeight}px`

  const width = grid.offsetWidth
  const height = grid.offsetHeight
  if (!width || !height) return

  // The host's rows and columns are fixed, so one axis fills and the other
  // letterboxes. Scaling about the centre lets the flex parent centre the
  // leftover evenly instead of stranding it all on the right.
  const scale = Math.min(availableWidth / width, availableHeight / height)
  frame.style.transformOrigin = 'center center'
  frame.style.transform = `scale(${scale})`
}

addEventListener('resize', rescale)

const pending = new Map<number, { id: number; text: string; bozo?: string }>()
let outbox: OutboxEntry[] = []
let outboxMode: OutboxMode = 'drain'
let mode: Mode = 'gallery'
let whiteface = false
let socket: WebSocket | null = null
let retry = 500
let ended = false

function setMode(next: Mode): void {
  mode = next
  el.mode.className = `badge ${next}`
  el.modeText.textContent = next === 'yolo' ? 'YOLO' : 'GALLERY'
  el.hint.innerHTML = next === 'yolo'
    ? 'Straight through. What you send lands as if the host typed it.'
    : 'The host has to <b>release</b> anything you send.'
  refreshKeypad()
}

function send(payload: BozoMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
}

function setLink(up: boolean): void {
  el.link.textContent = up ? 'live' : 'offline'
  el.link.className = `badge link${up ? '' : ' down'}`
  el.send.disabled = !up
}

function renderPending(): void {
  el.pending.replaceChildren()
  for (const entry of pending.values()) {
    const row = document.createElement('div')
    row.className = 'ticket'

    const num = document.createElement('span')
    num.className = 'num'
    num.textContent = `#${entry.id}`

    const what = document.createElement('span')
    what.className = 'what'
    what.textContent = whiteface ? `from ${entry.bozo}` : 'waiting for the host'

    const text = document.createElement('span')
    text.textContent = entry.text

    row.append(num, what, text)

    if (whiteface) {
      const spacer = document.createElement('span')
      spacer.style.flex = '1'
      const release = document.createElement('button')
      release.className = 'ring-btn go'
      release.textContent = 'release'
      release.onclick = () => send({ type: 'approve', id: entry.id })
      const drop = document.createElement('button')
      drop.className = 'ring-btn'
      drop.textContent = 'drop'
      drop.onclick = () => send({ type: 'deny', id: entry.id })
      row.append(spacer, release, drop)
    }

    el.pending.appendChild(row)
  }
}

// Why the head of the outbox is not moving, in words rather than a pane state.
const HELD: Partial<Record<HoldReason, string>> = {
  draft: 'the host is typing',
  unknown: 'the session is not at a prompt',
  busy: 'the session is working',
  dialog: 'a dialog is up',
  'copy-mode': 'the pane is in copy mode',
  dead: 'the pane is gone',
  error: 'the write failed',
}

// Past the gate, waiting only on the session. Everyone sees this one: a bozo
// who sent something is entitled to know where it is in the line.
function renderOutbox(): void {
  el.outbox.replaceChildren()
  let place = 0

  for (const entry of outbox) {
    const going = entry.state === 'sending'
    const held = !going && entry.reason
    if (!going) place++

    const row = document.createElement('div')
    row.className = ['ticket', 'out', going ? 'sending' : '', held ? 'held' : '',
      entry.bozo === bozoName ? 'mine' : ''].filter(Boolean).join(' ')

    const num = document.createElement('span')
    num.className = 'num'
    num.textContent = `o${entry.id}`

    const what = document.createElement('span')
    what.className = 'what'
    what.textContent = going
      ? 'going in'
      : held
        ? `waiting - ${HELD[entry.reason!] ?? entry.reason}`
        : place === 1 && outboxMode === 'drain'
          ? 'next'
          : `${place} in line`

    const text = document.createElement('span')
    text.className = 'said'
    text.textContent = entry.text

    row.append(num, what, text)

    if (whiteface && !going) {
      const spacer = document.createElement('span')
      spacer.style.flex = '1'
      const first = document.createElement('button')
      first.className = 'ring-btn'
      first.textContent = 'first'
      first.onclick = () => send({ type: 'bump', id: entry.id })
      const drop = document.createElement('button')
      drop.className = 'ring-btn'
      drop.textContent = 'drop'
      drop.onclick = () => send({ type: 'cancel', id: entry.id })
      row.append(spacer, first, drop)
    }

    el.outbox.appendChild(row)
  }
}

function endpoint(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const room = location.pathname.startsWith('/r/') ? decodeURIComponent(location.pathname.slice(3)) : null
  const query = room
    ? `room=${encodeURIComponent(room)}&t=${encodeURIComponent(token)}`
    : `t=${encodeURIComponent(token)}`
  return `${proto}://${location.host}/${room ? 'bozo' : ''}?${query}`
}

function connect(): void {
  socket = new WebSocket(endpoint())
  socket.binaryType = 'arraybuffer'

  socket.onopen = () => {
    retry = 500
    setLink(true)
    hoink()
  }

  socket.onclose = () => {
    setLink(false)
    // The host's session is gone for good, so retrying would just spin.
    if (ended) return
    setTimeout(connect, retry)
    retry = Math.min(retry * 2, 8000)
  }

  socket.onmessage = (event: MessageEvent) => {
    if (event.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(event.data))
      return
    }
    handle(JSON.parse(event.data) as ServerMessage)
  }
}

function handle(msg: ServerMessage): void {
  switch (msg.type) {
    case 'hoink':
      paneState = msg.state ?? 'unknown'
      if (msg.name) el.who.value = msg.name
      whiteface = Boolean(msg.whiteface)
      document.body.classList.toggle('whiteface', whiteface)
      if (msg.pending) {
        pending.clear()
        for (const entry of msg.pending) pending.set(entry.id, entry)
      }
      outbox = msg.outbox ?? []
      outboxMode = msg.outboxMode ?? 'drain'
      renderOutbox()
      lane.length = 0
      lane.push(...(msg.f2f ?? []))
      if (showing === 'f2f') renderLane()
      else unseen.f2f = lane.length
      renderTabs()
      setMode(msg.mode)
      if (whiteface) {
        el.hint.innerHTML = 'You are the <b>whiteface</b>. You run the ring: release, drop, switch mode.'
      }
      renderPending()
      term.resize(msg.cols, msg.rows)
      rescale()
      break
    case 'state':
      paneState = msg.state
      refreshKeypad()
      break
    case 'resize':
      term.resize(msg.cols, msg.rows)
      rescale()
      break
    case 'rejected':
      el.hint.innerHTML = msg.reason === 'queue full'
        ? 'Not sent: too many messages are already waiting for the host.'
        : 'Not sent: that message is too long.'
      break
    case 'key:refused':
      el.hint.innerHTML = 'Only the host can answer that. Ask them for <b>yolo</b>.'
      break
    case 'screen':
      // capture-pane separates rows with a bare LF, which on its own moves down
      // without returning to column 0. Its trailing newline has to go too: it
      // would scroll a full-height snapshot up by one row and put every later
      // relative redraw one row off.
      term.reset()
      term.write(msg.data.replace(/\r?\n$/, '').replace(/\r?\n/g, '\r\n'))
      if (msg.cursor) term.write(`\x1b[${msg.cursor.y + 1};${msg.cursor.x + 1}H`)
      rescale()
      break
    case 'named':
      el.who.value = msg.name
      break
    case 'pending':
    case 'policy:queued':
      pending.set(msg.id, { id: msg.id, text: msg.text, bozo: msg.bozo })
      renderPending()
      break
    case 'whiteface:refused':
      el.hint.textContent = `Not the whiteface: ${msg.reason}.`
      break
    case 'control':
      if (!msg.ok) el.hint.textContent = `Refused: ${msg.error}.`
      break
    case 'policy:mode':
      setMode(msg.mode)
      break
    case 'policy:approved':
    case 'policy:denied':
      pending.delete(msg.id)
      renderPending()
      break
    case 'outbox':
      outbox = msg.entries
      outboxMode = msg.mode
      renderOutbox()
      break
    case 'f2f':
      lane.push(msg.msg)
      if (showing === 'f2f') appendLine(msg.msg)
      else {
        unseen.f2f++
        renderTabs()
      }
      break
    case 'scrollback':
      applyScrollback(msg)
      break
    case 'accepted':
      el.hint.innerHTML = outboxMode === 'through'
        ? 'In. If the session is working, claude queues it.'
        : 'In the <b>outbox</b>. It goes in when the session is free.'
      break
    // Only a message the outbox gave up on gets here now. Anything merely
    // blocked is sitting in the outbox with its reason on it.
    case 'policy:held':
      el.hint.innerHTML = `Not delivered: ${HELD[msg.state] ?? msg.state}.`
      break
    case 'notice':
      term.write(`\r\n\x1b[38;5;246m[c2c] ${msg.text}\x1b[39m\r\n`)
      break
    case 'bye':
      ended = true
      el.link.textContent = 'ended'
      el.hint.textContent = `${msg.text}. Nothing more will arrive.`
      el.send.disabled = true
      term.write(`\r\n\x1b[38;5;246m[c2c] ${msg.text}\x1b[39m\r\n`)
      break
    case 'transcript:history':
      turns.length = 0
      turns.push(...msg.entries)
      if (showing === 'history') renderHistory()
      else unseen.history = turns.length
      renderTabs()
      break
    case 'transcript':
      turns.push(msg.entry)
      if (showing === 'history') appendTurn(msg.entry)
      else unseen.history++
      renderTabs()
      break
  }
}

el.form.addEventListener('submit', (event) => {
  event.preventDefault()
  const text = el.text.value.trim()
  if (!text) return
  send({ type: 'submit', text })
  el.text.value = ''
})

// Not "name" either: window.name is a string that is already there.
let bozoName = localStorage.getItem('c2c-name') || 'bozo'
el.who.value = bozoName

// HOINK is the greeting: the bozo announces itself and the ringmaster hoinks
// back with the mode, the pane size and the current screen.
function hoink(): void {
  send({ type: 'hoink', name: bozoName, whiteface: whitefaceToken || undefined })
}

function announce(): void {
  send({ type: 'name', name: bozoName })
}

el.who.addEventListener('change', () => {
  bozoName = el.who.value.trim() || 'bozo'
  el.who.value = bozoName
  localStorage.setItem('c2c-name', bozoName)
  announce()
})

renderTabs()
setMode('gallery')
setLink(false)
connect()
