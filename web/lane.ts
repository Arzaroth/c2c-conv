// The f2f lane, as a chat surface rather than a log: who is here, who is
// typing, what arrived while you were looking at the terminal, and what you
// typed that has not come back yet.
//
// Nothing in here reaches the session. That is the whole feature, so the panel
// says so and the code has no path to the composer that does.

interface LaneDom {
  scroll: HTMLElement
  list: HTMLElement
  form: HTMLFormElement
  input: HTMLInputElement
  here: HTMLElement
  typing: HTMLElement
  jump: HTMLButtonElement
}

// A line of your own, drawn before the round trip. It settles when the
// ringmaster sends it back with the nonce it was given.
interface Draft {
  nonce: string
  text: string
  at: number
  failed: boolean
  timer: number
}

// Consecutive lines from the same clown inside this stay one block: the name
// is said once rather than down the whole margin.
const GROUP_MS = 5 * 60 * 1000

// How long a line of yours may go unanswered before it is called failed. The
// round trip is a websocket echo, so this is generous by an order of magnitude.
const SETTLE_MS = 8000

// A typing hint is worth about as long as it takes to finish a sentence.
const TYPING_MS = 5000
const TYPING_EVERY_MS = 3000

let dom: LaneDom
let send: (msg: BozoMessage) => void
let onUnseen: (count: number) => void

const lane: F2fMessage[] = []
const drafts: Draft[] = []
const typing = new Map<string, number>()

let me = 'bozo'
let shown = false
let live = true
let unseen = 0
// The id of the first line that landed while you were somewhere else, so the
// panel can say where you got to. Kept while the panel is open: it is only in
// the way once you have left and come back.
let unreadFrom: number | null = null
let atBottom = true
let lastTypingSent = 0
let typingTimer: number | undefined

export function mountLane(parts: LaneDom, hooks: {
  send: (msg: BozoMessage) => void
  unseen: (count: number) => void
}): void {
  dom = parts
  send = hooks.send
  onUnseen = hooks.unseen

  dom.form.addEventListener('submit', (event) => {
    event.preventDefault()
    say(dom.input.value.trim())
    dom.input.value = ''
  })

  dom.input.addEventListener('input', () => {
    if (!dom.input.value.trim()) return
    const now = Date.now()
    if (now - lastTypingSent < TYPING_EVERY_MS) return
    lastTypingSent = now
    send({ type: 'typing' })
  })

  dom.scroll.addEventListener('scroll', () => {
    atBottom = dom.scroll.scrollTop + dom.scroll.clientHeight >= dom.scroll.scrollHeight - 40
    if (atBottom) dom.jump.hidden = true
  })

  dom.jump.addEventListener('click', () => {
    atBottom = true
    dom.jump.hidden = true
    toBottom()
  })
}

export function laneMe(name: string): void {
  me = name
  render()
}

export function laneLive(up: boolean): void {
  live = up
  // A dropped socket is not proof the line was lost, and saying "failed" would
  // be a guess. It is enough to stop pretending it is still on its way.
  if (!up) for (const draft of drafts) fail(draft)
}

export function laneSeed(msgs: F2fMessage[]): void {
  lane.length = 0
  lane.push(...msgs)
  unseen = shown ? 0 : lane.length
  onUnseen(unseen)
  render()
  if (shown) toBottom()
}

export function laneSaid(msg: F2fMessage, nonce?: string): void {
  const draft = nonce ? drafts.findIndex((d) => d.nonce === nonce) : -1
  if (draft !== -1) {
    clearTimeout(drafts[draft].timer)
    drafts.splice(draft, 1)
  }

  typing.delete(msg.from)
  lane.push(msg)

  if (!shown) {
    unseen++
    if (unreadFrom === null) unreadFrom = msg.id
    onUnseen(unseen)
  }
  render()
  if (shown && (atBottom || msg.from === me)) toBottom()
  else if (shown) nudge()
}

export function laneTyping(name: string): void {
  typing.set(name, Date.now() + TYPING_MS)
  renderTyping()
}

// Who else is in the lane, so a line typed into an empty room does not look
// like one that was read.
export function laneHere(bozos: RosterEntry[]): void {
  dom.here.replaceChildren()
  if (bozos.length <= 1) {
    const alone = document.createElement('span')
    alone.className = 'lane-alone'
    alone.textContent = 'Nobody else is in the lane. Whatever you say here will keep.'
    dom.here.appendChild(alone)
    return
  }

  const label = document.createElement('span')
  label.className = 'lane-here-label'
  label.textContent = `${bozos.length} in the lane`
  dom.here.appendChild(label)

  for (const bozo of bozos) {
    const chip = document.createElement('span')
    chip.className = `who-chip${bozo.idle ? ' away' : ''}`
    const pip = document.createElement('span')
    pip.className = `pip ${bozo.idle ? 'idle' : 'here'}`
    const name = document.createElement('span')
    name.textContent = bozo.name
    chip.append(pip, name)
    if (bozo.whiteface) {
      const crown = document.createElement('span')
      crown.className = 'chip-white'
      crown.textContent = 'whiteface'
      chip.appendChild(crown)
    }
    dom.here.appendChild(chip)
  }
}

export function laneShown(next: boolean): void {
  shown = next
  if (!next) {
    // Left the panel: the marker has done its job, and keeping it would put a
    // "new" line above something you have already read.
    unreadFrom = null
    return
  }
  unseen = 0
  onUnseen(0)
  atBottom = true
  dom.jump.hidden = true
  render()
  toBottom()
  dom.input.focus()
}

function say(text: string): void {
  if (!text) return
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const draft: Draft = {
    nonce,
    text,
    at: Date.now(),
    failed: false,
    timer: setTimeout(() => fail(draft), SETTLE_MS) as unknown as number,
  }
  drafts.push(draft)
  render()
  toBottom()
  if (live) send({ type: 'f2f', text, nonce })
  else fail(draft)
}

function fail(draft: Draft): void {
  if (draft.failed) return
  clearTimeout(draft.timer)
  draft.failed = true
  render()
}

function retry(draft: Draft): void {
  draft.failed = false
  draft.timer = setTimeout(() => fail(draft), SETTLE_MS) as unknown as number
  render()
  if (live) send({ type: 'f2f', text: draft.text, nonce: draft.nonce })
  else fail(draft)
}

function discard(draft: Draft): void {
  const index = drafts.indexOf(draft)
  if (index === -1) return
  clearTimeout(draft.timer)
  drafts.splice(index, 1)
  render()
}

function toBottom(): void {
  dom.scroll.scrollTop = dom.scroll.scrollHeight
}

function nudge(): void {
  dom.jump.hidden = false
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

function dayLabel(at: number): string {
  const now = Date.now()
  if (sameDay(at, now)) return 'today'
  if (sameDay(at, now - 86_400_000)) return 'yesterday'
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function divider(text: string, className: string): HTMLDivElement {
  const row = document.createElement('div')
  row.className = `lane-divider ${className}`
  const label = document.createElement('span')
  label.textContent = text
  row.appendChild(label)
  return row
}

function lineElement(msg: F2fMessage, grouped: boolean): HTMLDivElement {
  const mine = !msg.host && msg.from === me
  const row = document.createElement('div')
  row.className = `line${msg.host ? ' host' : mine ? ' mine' : ''}${grouped ? ' grouped' : ''}`

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

function draftElement(draft: Draft): HTMLDivElement {
  const row = document.createElement('div')
  row.className = `line mine ${draft.failed ? 'failed' : 'sending'}`

  const from = document.createElement('span')
  from.className = 'from'
  from.textContent = me

  const said = document.createElement('span')
  said.className = 'said'
  said.textContent = draft.text

  const at = document.createElement('span')
  at.className = 'at'
  at.textContent = draft.failed ? 'no answer' : 'saying...'

  row.append(from, said, at)

  if (draft.failed) {
    const again = document.createElement('button')
    again.className = 'ring-btn small'
    again.textContent = 'again'
    again.onclick = () => retry(draft)
    const drop = document.createElement('button')
    drop.className = 'ring-btn small'
    drop.textContent = 'drop'
    drop.onclick = () => discard(draft)
    row.append(again, drop)
  }

  return row
}

function render(): void {
  dom.list.replaceChildren()

  if (!lane.length && !drafts.length) {
    const empty = document.createElement('div')
    empty.className = 'lane-empty'
    empty.textContent = 'Nobody has said anything yet. Claude will not hear any of it.'
    dom.list.appendChild(empty)
    renderTyping()
    return
  }

  let previous: F2fMessage | null = null
  for (const msg of lane) {
    let broken = false
    if (!previous || !sameDay(previous.at, msg.at)) {
      dom.list.appendChild(divider(dayLabel(msg.at), 'day'))
      broken = true
    }
    if (msg.id === unreadFrom) {
      dom.list.appendChild(divider('new', 'new'))
      broken = true
    }
    const grouped = !broken && previous !== null
      && previous.from === msg.from
      && Boolean(previous.host) === Boolean(msg.host)
      && msg.at - previous.at < GROUP_MS
    dom.list.appendChild(lineElement(msg, grouped))
    previous = msg
  }

  for (const draft of drafts) dom.list.appendChild(draftElement(draft))
  renderTyping()
}

function renderTyping(): void {
  const now = Date.now()
  for (const [name, until] of typing) {
    if (until <= now) typing.delete(name)
  }

  const who = [...typing.keys()].filter((name) => name !== me)
  dom.typing.textContent = !who.length
    ? ''
    : who.length === 1
      ? `${who[0]} is typing...`
      : who.length === 2
        ? `${who[0]} and ${who[1]} are typing...`
        : `${who.length} clowns are typing...`

  clearTimeout(typingTimer)
  if (who.length) typingTimer = setTimeout(renderTyping, 1000) as unknown as number
}
