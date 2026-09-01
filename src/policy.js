export const SPECTATOR = 'spectator'
export const YOLO = 'yolo'

export class Policy {
  #mode = SPECTATOR
  #pending = new Map()
  #nextId = 1
  #listeners = new Set()

  get mode() {
    return this.#mode
  }

  setMode(mode) {
    if (mode !== SPECTATOR && mode !== YOLO) {
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

  submit({ text, guest }) {
    const clean = normalize(text)
    if (!clean) return { action: 'ignored' }

    if (this.#mode === YOLO) {
      this.#emit({ type: 'sent', text: clean, guest })
      return { action: 'send', text: clean }
    }

    const id = this.#nextId++
    const entry = { id, text: clean, guest, at: Date.now() }
    this.#pending.set(id, entry)
    this.#emit({ type: 'queued', ...entry })
    return { action: 'queued', id }
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

// The prompt box submits on Enter, so a raw newline inside guest text would
// split one message into several turns.
function normalize(text) {
  if (typeof text !== 'string') return ''
  return text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
}
