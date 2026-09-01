const token = new URLSearchParams(location.search).get('t') || ''

const el = {
  mode: document.getElementById('mode'),
  link: document.getElementById('link'),
  who: document.getElementById('who'),
  pending: document.getElementById('pending'),
  form: document.getElementById('composer'),
  text: document.getElementById('text'),
  send: document.getElementById('send'),
  hint: document.getElementById('hint'),
}

const term = new Terminal({
  convertEol: false,
  cursorBlink: false,
  disableStdin: true,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 13,
  scrollback: 10000,
  theme: { background: '#14121a', foreground: '#e8e4f0' },
})
const fit = new FitAddon.FitAddon()
term.loadAddon(fit)
term.open(document.getElementById('screen'))
fit.fit()
addEventListener('resize', () => fit.fit())

const pending = new Map()
let mode = 'spectator'
let socket = null
let retry = 500

function setMode(next) {
  mode = next
  el.mode.textContent = next === 'yolo' ? 'yolo - sends immediately' : 'spectator - host approves'
  el.mode.className = `badge ${next}`
  el.hint.textContent = next === 'yolo'
    ? 'Your messages go straight into the session as if the host typed them.'
    : 'Your messages wait for the host to release them.'
}

function setLink(up) {
  el.link.textContent = up ? 'live' : 'offline'
  el.link.className = `badge link${up ? '' : ' down'}`
  el.send.disabled = !up
}

function renderPending() {
  el.pending.innerHTML = ''
  for (const entry of pending.values()) {
    const row = document.createElement('div')
    row.textContent = `waiting for host approval - #${entry.id} ${entry.text}`
    el.pending.appendChild(row)
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  socket = new WebSocket(`${proto}://${location.host}/?t=${encodeURIComponent(token)}`)
  socket.binaryType = 'arraybuffer'

  socket.onopen = () => {
    retry = 500
    setLink(true)
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
      setMode(msg.mode)
      term.resize(msg.cols, msg.rows)
      break
    case 'screen':
      term.reset()
      term.write(msg.data)
      break
    case 'named':
      el.who.textContent = msg.name
      break
    case 'pending':
      pending.set(msg.id, { id: msg.id, text: msg.text })
      renderPending()
      break
    case 'accepted':
      break
    case 'policy:mode':
      setMode(msg.mode)
      break
    case 'policy:approved':
    case 'policy:denied':
      pending.delete(msg.id)
      renderPending()
      break
  }
}

el.form.addEventListener('submit', (event) => {
  event.preventDefault()
  const text = el.text.value.trim()
  if (!text || !socket || socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ type: 'submit', text }))
  el.text.value = ''
})

const saved = localStorage.getItem('c2c-name')
const name = saved || prompt('Your name?') || 'guest'
localStorage.setItem('c2c-name', name)
el.who.textContent = name

setMode('spectator')
setLink(false)
connect()

const announce = setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'name', name }))
    clearInterval(announce)
  }
}, 200)
