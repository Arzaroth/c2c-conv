const token = new URLSearchParams(location.search).get('t') || ''

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
}

let paneState = 'unknown'

function refreshKeypad() {
  el.keypad.hidden = paneState !== 'dialog'
  const usable = mode === 'yolo'
  for (const button of el.keypad.querySelectorAll('button')) button.disabled = !usable
  el.keypad.querySelector('.keypad-label').textContent = usable
    ? '🤡 the session is asking'
    : '🤡 the session is asking - only the host can answer'
}

el.keypad.addEventListener('click', (event) => {
  const key = event.target.dataset?.key
  if (!key || socket?.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ type: 'key', key }))
})

const term = new Terminal({
  cursorBlink: false,
  disableStdin: true,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 13,
  // The guest mirrors a fixed-size pane that repaints in place, so scrollback
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

// The guest terminal has to keep the host's exact column count or the live ANSI
// stream lands in the wrong places, so the whole grid is scaled to fit rather
// than reflowed.
// Fit by font size rather than a CSS transform: xterm then renders natively at
// the chosen size, so the text stays crisp instead of being scaled bitmap. The
// host's rows and columns are fixed, so whatever is left over after fitting is
// aspect-ratio letterboxing and gets centred.
let fitting = false

function rescale() {
  if (fitting) return
  fitting = true
  requestAnimationFrame(() => {
    try {
      fit()
    } finally {
      fitting = false
    }
  })
}

function fit() {
  const view = el.screen.querySelector('.xterm')
  const grid = el.screen.querySelector('.xterm-screen')
  if (!view || !grid) return

  view.style.transform = 'none'
  // Pin the element to the character grid: left to itself it stretches to the
  // container, which both mispositions the centring and strands the scrollbar
  // out in the empty gap.
  view.style.width = `${grid.offsetWidth}px`
  view.style.height = `${grid.offsetHeight}px`

  const width = grid.offsetWidth
  const height = grid.offsetHeight
  const availableWidth = el.screen.clientWidth - 16
  const availableHeight = el.screen.clientHeight - 12
  if (!width || !height || availableWidth <= 0 || availableHeight <= 0) return

  // The host's rows and columns are fixed, so one axis fills and the other
  // letterboxes. Scaling about the centre lets the flex parent centre the
  // leftover evenly instead of stranding it all on the right.
  const scale = Math.min(availableWidth / width, availableHeight / height)
  view.style.transformOrigin = 'center center'
  view.style.transform = `scale(${scale})`
}

addEventListener('resize', rescale)

const pending = new Map()
let mode = 'spectator'
let socket = null
let retry = 500

function setMode(next) {
  mode = next
  el.mode.className = `badge ${next}`
  el.modeText.textContent = next === 'yolo' ? 'YOLO' : 'SPECTATOR'
  el.hint.innerHTML = next === 'yolo'
    ? 'Straight through. What you send lands as if the host typed it.'
    : 'The host has to <b>release</b> anything you send.'
  refreshKeypad()
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
    what.textContent = 'waiting for the host'

    const text = document.createElement('span')
    text.textContent = entry.text

    row.append(num, what, text)
    el.pending.appendChild(row)
  }
}

function endpoint() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const room = location.pathname.startsWith('/r/') ? decodeURIComponent(location.pathname.slice(3)) : null
  const query = room
    ? `room=${encodeURIComponent(room)}&t=${encodeURIComponent(token)}`
    : `t=${encodeURIComponent(token)}`
  return `${proto}://${location.host}/${room ? 'guest' : ''}?${query}`
}

function connect() {
  socket = new WebSocket(endpoint())
  socket.binaryType = 'arraybuffer'

  socket.onopen = () => {
    retry = 500
    setLink(true)
    announce()
  }

  socket.onclose = () => {
    setLink(false)
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
    case 'hello':
      paneState = msg.state ?? 'unknown'
      setMode(msg.mode)
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
      pending.set(msg.id, { id: msg.id, text: msg.text })
      renderPending()
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
  }
}

el.form.addEventListener('submit', (event) => {
  event.preventDefault()
  const text = el.text.value.trim()
  if (!text || socket?.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ type: 'submit', text }))
  el.text.value = ''
})

let name = localStorage.getItem('c2c-name') || 'guest'
el.who.value = name

function announce() {
  if (socket?.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ type: 'name', name }))
}

el.who.addEventListener('change', () => {
  name = el.who.value.trim() || 'guest'
  el.who.value = name
  localStorage.setItem('c2c-name', name)
  announce()
})

setMode('spectator')
setLink(false)
connect()
