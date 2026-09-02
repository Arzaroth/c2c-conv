// Who is in the circus. The roster is the one surface that answers "is anyone
// still there", and for the whiteface it is also where trust is handed out:
// nobody can be let into the ring without somebody to point at first.

interface CircusDom {
  list: HTMLElement
  count: HTMLElement
  room: HTMLElement
  toggle: HTMLButtonElement
}

interface CircusState {
  mode: Mode
  bozos: RosterEntry[]
  me: string
  whiteface: boolean
}

let dom: CircusDom
let send: (msg: BozoMessage) => void
let state: CircusState = { mode: 'gallery', bozos: [], me: '', whiteface: false }

export function mountCircus(parts: CircusDom, sender: (msg: BozoMessage) => void): void {
  dom = parts
  send = sender
  dom.toggle.addEventListener('click', () => send({ type: 'mode', mode: 'toggle' }))
}

export function renderCircus(next: Partial<CircusState>): void {
  state = { ...state, ...next }
  const { mode, bozos, me, whiteface } = state

  dom.count.textContent = bozos.length === 1 ? '1 here' : `${bozos.length} here`
  dom.room.innerHTML = `the room is <b>${mode}</b> by default`
  dom.toggle.hidden = !whiteface

  dom.list.replaceChildren()
  if (!bozos.length) {
    const empty = document.createElement('div')
    empty.className = 'circus-empty'
    empty.textContent = 'The tent is empty. Nobody has hoinked in yet.'
    dom.list.appendChild(empty)
    return
  }
  for (const bozo of bozos) dom.list.appendChild(row(bozo, me, whiteface))
}

function tag(text: string, className: string): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = `tag ${className}`
  span.textContent = text
  return span
}

function row(bozo: RosterEntry, me: string, whiteface: boolean): HTMLDivElement {
  const line = document.createElement('div')
  line.className = `bozo${bozo.id === me ? ' mine' : ''}${bozo.idle ? ' away' : ''}`

  const dot = document.createElement('span')
  dot.className = `pip ${bozo.idle ? 'idle' : 'here'}`
  dot.title = bozo.idle ? 'not looking at the moment' : 'watching'

  const name = document.createElement('span')
  name.className = 'bozo-name'
  name.textContent = bozo.name

  line.append(dot, name)
  if (bozo.id === me) line.appendChild(tag('you', 'you'))
  if (bozo.whiteface) line.appendChild(tag('whiteface', 'white'))
  // Trusted is the part worth calling out: it is the one that outlives a change
  // to the room default.
  line.appendChild(tag(bozo.trusted ? `${bozo.mode} - trusted` : bozo.mode, `mode ${bozo.mode}`))
  if (bozo.idle) line.appendChild(tag('idle', 'idle'))

  // Which way they got in, which is a transport rather than an address.
  const via = document.createElement('span')
  via.className = 'bozo-via'
  via.textContent = bozo.via
  line.appendChild(via)

  const spacer = document.createElement('span')
  spacer.className = 'spacer'
  line.appendChild(spacer)

  if (whiteface) line.append(...controls(bozo, me))
  return line
}

function controls(bozo: RosterEntry, me: string): HTMLButtonElement[] {
  const buttons: HTMLButtonElement[] = []

  const trust = (mode: string, label: string, on: boolean) => {
    const button = document.createElement('button')
    button.className = `ring-btn small${on ? ' on' : ''}`
    button.textContent = label
    button.onclick = () => send({ type: 'trust', who: bozo.id, mode })
    buttons.push(button)
  }

  trust('gallery', 'gallery', bozo.trusted && bozo.mode === 'gallery')
  trust('yolo', 'ring', bozo.trusted && bozo.mode === 'yolo')

  const free = document.createElement('button')
  free.className = 'ring-btn small'
  free.textContent = 'default'
  free.disabled = !bozo.trusted
  free.title = 'back to whatever the room does'
  free.onclick = () => send({ type: 'trust', who: bozo.id, mode: 'default' })
  buttons.push(free)

  // Kicking yourself is not a thing anyone means to do, and the whiteface is
  // the one person here who cannot be replaced by reconnecting.
  if (bozo.id !== me) {
    const kick = document.createElement('button')
    kick.className = 'ring-btn small out'
    kick.textContent = 'kick'
    kick.title = 'close their connection - the link they hold still works'
    kick.onclick = () => send({ type: 'kick', who: bozo.id })
    buttons.push(kick)
  }

  return buttons
}
