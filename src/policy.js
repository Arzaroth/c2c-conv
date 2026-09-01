export const GALLERY = 'gallery'
export const YOLO = 'yolo'

// A message longer than this is not a prompt someone typed, and the queue is
// what a bozo can grow without the host agreeing to anything.
export const MAX_TEXT = 8000
export const MAX_PENDING = 50

export const ALLOWED_KEYS = new Set([
  'Up', 'Down', 'Left', 'Right', 'Enter', 'Escape', 'Tab', 'BSpace',
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
])

export class Policy {
  #mode = GALLERY
  #pending = new Map()
  #nextId = 1
  #listeners = new Set()

  get mode() {
    return this.#mode
  }

  setMode(mode) {
    if (mode !== GALLERY && mode !== YOLO) {
      throw new Error(`unknown mode: ${mode}`)
    }
    const changed = this.#mode !== mode
    this.#mode = mode
    if (changed) this.#emit({ type: 'mode', mode })
    return this.#mode
  }

  onEvent(fn) {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  #emit(event) {
    for (const fn of this.#listeners) fn(event)
  }

  submit({ text, bozo }) {
    const clean = normalize(text)
    if (!clean) return { action: 'ignored' }
    if (clean.length > MAX_TEXT) {
      return { action: 'rejected', reason: 'too long' }
    }

    if (this.#mode === YOLO) {
      this.#emit({ type: 'sent', text: clean, bozo })
      return { action: 'send', text: clean }
    }

    if (this.#pending.size >= MAX_PENDING) {
      return { action: 'rejected', reason: 'queue full' }
    }

    const id = this.#nextId++
    const entry = { id, text: clean, bozo, at: Date.now() }
    this.#pending.set(id, entry)
    this.#emit({ type: 'queued', ...entry })
    return { action: 'queued', id }
  }

  // Answering a dialog is a side effect by definition, and queueing individual
  // arrow presses for approval would be unusable, so keys are a ring-only
  // capability rather than a third thing on the ladder.
  submitKey({ key, bozo }) {
    if (!ALLOWED_KEYS.has(key)) return { action: 'rejected', reason: 'unknown key' }
    if (this.#mode !== YOLO) return { action: 'refused', reason: 'gallery' }
    this.#emit({ type: 'key', key, bozo })
    return { action: 'send', key }
  }

  list() {
    return [...this.#pending.values()]
  }

  approve(id) {
    const entry = this.#pending.get(id)
    if (!entry) return null
    this.#pending.delete(id)
    this.#emit({ type: 'approved', ...entry })
    return entry
  }

  deny(id) {
    const entry = this.#pending.get(id)
    if (!entry) return null
    this.#pending.delete(id)
    this.#emit({ type: 'denied', ...entry })
    return entry
  }

  approveAll() {
    const all = this.list()
    this.#pending.clear()
    for (const entry of all) this.#emit({ type: 'approved', ...entry })
    return all
  }

  denyAll() {
    const all = this.list()
    this.#pending.clear()
    for (const entry of all) this.#emit({ type: 'denied', ...entry })
    return all
  }
}

// The prompt box submits on Enter, so a raw newline inside bozo text would
// split one message into several turns.
function normalize(text) {
  if (typeof text !== 'string') return ''
  return text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
}
