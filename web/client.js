const params = new URLSearchParams(location.search)
const token = params.get('t') || ''
// Presenting this makes you the whiteface: the clown who runs the ring.
const whitefaceToken = params.get('w') || ''

const el = {
  mode: document.getElementById('mode'),
  modeText: document.getElementById('mode-text'),
  link: document.getElementById('link'),
  who: document.getElementById('who'),
  pending: document.getElementById('pending'),
  form: document.getElementById('composer'),
  text: document.getElementById('text'),
  send: document.getElementById('send'),
  hint: document.getElementById('hint'),
  screen: document.getElementById('screen'),
  keypad: document.getElementById('keypad'),
  history: document.getElementById('history'),
  historyList: document.getElementById('history-list'),
  historyToggle: document.getElementById('history-toggle'),
}

const history = []
let historyOpen = false
let unseen = 0

function renderHistoryToggle() {
  el.historyToggle.classList.toggle('on', historyOpen)
  el.historyToggle.textContent = 'history'
  if (!historyOpen && unseen) {
    const badge = document.createElement('span')
    badge.className = 'count'
    badge.textContent = unseen > 99 ? '99+' : String(unseen)
    el.historyToggle.appendChild(badge)
  }
}

function turnElement(entry) {
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

function appendTurn(entry) {
  const atBottom = el.history.scrollTop + el.history.clientHeight >= el.history.scrollHeight - 40
  el.historyList.appendChild(turnElement(entry))
  if (historyOpen && atBottom) el.history.scrollTop = el.history.scrollHeight
}

function renderHistory() {
  el.historyList.replaceChildren()
  if (!history.length) {
    const empty = document.createElement('div')
    empty.className = 'history-empty'
    empty.textContent = 'Nothing yet. The conversation shows up here as it happens.'
    el.historyList.appendChild(empty)
    return
  }
  for (const entry of history) el.historyList.appendChild(turnElement(entry))
}

el.mode.addEventListener('click', () => {
  if (whiteface) send({ type: 'mode', mode: 'toggle' })
})

el.historyToggle.addEventListener('click', () => {
  historyOpen = !historyOpen
  el.history.hidden = !historyOpen
  el.screen.hidden = historyOpen
  if (historyOpen) {
    unseen = 0
    renderHistory()
    el.history.scrollTop = el.history.scrollHeight
  } else {
    rescale()
  }
  renderHistoryToggle()
})

let paneState = 'unknown'

function refreshKeypad() {
  el.keypad.hidden = paneState !== 'dialog'
  const canPress = mode === 'yolo' || whiteface
  for (const button of el.keypad.querySelectorAll('button')) button.disabled = !canPress
  el.keypad.querySelector('.keypad-label').textContent = canPress
    ? '🤡 the session is asking'
    : '🤡 the session is asking - only the host can answer'
}

el.keypad.addEventListener('click', (event) => {
  const key = event.target.dataset?.key
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
function rescale() {
  if (pendingFit) return
  pendingFit = true

  const run = () => {
    if (!pendingFit) return
    pendingFit = false
    try {
      fit()
    } catch {}
  }

  requestAnimationFrame(run)
  setTimeout(run, 60)
}

function fit() {
  const view = el.screen.querySelector('.xterm')
  const grid = el.screen.querySelector('.xterm-screen')
  if (!view || !grid) return

  // Bail before touching the transform. Clearing it first and then giving up on
  // an unmeasurable container leaves the terminal permanently unscaled, which
  // is what happens every time a redraw arrives while history is open.
  const availableWidth = el.screen.clientWidth - 16
  const availableHeight = el.screen.clientHeight - 12
  if (el.screen.hidden || availableWidth <= 0 || availableHeight <= 0) return

  view.style.transform = 'none'
  // Pin the element to the character grid: left to itself it stretches to the
  // container, which both mispositions the centring and strands the scrollbar
  // out in the empty gap.
  view.style.width = `${grid.offsetWidth}px`
  view.style.height = `${grid.offsetHeight}px`

  const width = grid.offsetWidth
  const height = grid.offsetHeight
  if (!width || !height) return

  // The host's rows and columns are fixed, so one axis fills and the other
  // letterboxes. Scaling about the centre lets the flex parent centre the
  // leftover evenly instead of stranding it all on the right.
  const scale = Math.min(availableWidth / width, availableHeight / height)
  view.style.transformOrigin = 'center center'
  view.style.transform = `scale(${scale})`
}

addEventListener('resize', rescale)

const pending = new Map()
let mode = 'gallery'
let whiteface = false
let socket = null
let retry = 500
let ended = false

function setMode(next) {
  mode = next
  el.mode.className = `badge ${next}`
  el.modeText.textContent = next === 'yolo' ? 'YOLO' : 'GALLERY'
  el.hint.innerHTML = next === 'yolo'
    ? 'Straight through. What you send lands as if the host typed it.'
    : 'The host has to <b>release</b> anything you send.'
  refreshKeypad()
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
}

function setLink(up) {
  el.link.textContent = up ? 'live' : 'offline'
  el.link.className = `badge link${up ? '' : ' down'}`
  el.send.disabled = !up
}

function renderPending() {
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

function endpoint() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const room = location.pathname.startsWith('/r/') ? decodeURIComponent(location.pathname.slice(3)) : null
  const query = room
    ? `room=${encodeURIComponent(room)}&t=${encodeURIComponent(token)}`
    : `t=${encodeURIComponent(token)}`
  return `${proto}://${location.host}/${room ? 'bozo' : ''}?${query}`
}

function connect() {
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

  socket.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(event.data))
      return
    }
    handle(JSON.parse(event.data))
  }
}

function handle(msg) {
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
    case 'policy:held':
      el.hint.innerHTML = msg.state === 'draft'
        ? 'Held: the host has an unsent draft in the prompt box.'
        : `Held: the session is <b>${msg.state}</b>. Try again once it is idle.`
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
      history.length = 0
      history.push(...msg.entries)
      if (historyOpen) renderHistory()
      else unseen = history.length
      renderHistoryToggle()
      break
    case 'transcript':
      history.push(msg.entry)
      if (historyOpen) appendTurn(msg.entry)
      else unseen++
      renderHistoryToggle()
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

let name = localStorage.getItem('c2c-name') || 'bozo'
el.who.value = name

// HOINK is the greeting: the bozo announces itself and the ringmaster hoinks
// back with the mode, the pane size and the current screen.
function hoink() {
  send({ type: 'hoink', name, whiteface: whitefaceToken || undefined })
}

function announce() {
  send({ type: 'name', name })
}

el.who.addEventListener('change', () => {
  name = el.who.value.trim() || 'bozo'
  el.who.value = name
  localStorage.setItem('c2c-name', name)
  announce()
})

renderHistoryToggle()
setMode('gallery')
setLink(false)
connect()
