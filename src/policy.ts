export const GALLERY = 'gallery'
export const YOLO = 'yolo'

// A message longer than this is not a prompt someone typed, and the queue is
// what a bozo can grow without the host agreeing to anything.
export const MAX_TEXT = 8000
export const MAX_PENDING = 50

// A clown car holds about thirty. Past that a shared terminal is a broadcast,
// and every bozo costs a copy of the pane stream.
export const MAX_BOZOS = 30

export const ALLOWED_KEYS = new Set([
  'Up', 'Down', 'Left', 'Right', 'Enter', 'Escape', 'Tab', 'BSpace',
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
])

export class Policy {
  #mode: Mode = GALLERY
  // Trust is per bozo and keyed by the connection's id, never by the name: two
  // bozos can call themselves the same thing, and a name is theirs to pick. So
  // it does not survive a reconnect either, which is the fail-safe direction:
  // whoever comes back is in the gallery until the host says otherwise.
  #trust = new Map<string, Mode>()
  #pending = new Map<number, PendingEntry>()
  #nextId = 1
  #listeners = new Set<(event: PolicyEvent) => void>()

  // The room default: what a bozo the host has said nothing about may do.
  get mode(): Mode {
    return this.#mode
  }

  setMode(mode: string): Mode {
    const next = asMode(mode)
    const changed = this.#mode !== next
    this.#mode = next
    if (changed) this.#emit({ type: 'mode', mode: next })
    return this.#mode
  }

  // What this one bozo may do, which is the room default until the host picks
  // them out. Everything that gates on a mode asks this rather than #mode.
  modeFor(bozo?: string): Mode {
    return (bozo && this.#trust.get(bozo)) || this.#mode
  }

  trustedMode(bozo: string): Mode | null {
    return this.#trust.get(bozo) ?? null
  }

  trusted(): [string, Mode][] {
    return [...this.#trust]
  }

  // Elevate one person to the ring without the other twenty-nine coming with
  // them. Pinning to gallery is worth as much as pinning to yolo: it holds
  // when the room default goes the other way.
  trust(bozo: string, mode: string): Mode {
    const next = asMode(mode)
    const changed = this.#trust.get(bozo) !== next
    this.#trust.set(bozo, next)
    if (changed) this.#emit({ type: 'trust', bozo, mode: next })
    return next
  }

  untrust(bozo: string): boolean {
    if (!this.#trust.delete(bozo)) return false
    this.#emit({ type: 'trust', bozo, mode: null })
    return true
  }

  // They are gone, so nobody needs telling and the id must not be left behind:
  // ids are not reused, but trust that outlives its holder is still a leak.
  forget(bozo: string): void {
    this.#trust.delete(bozo)
  }

  onEvent(fn: (event: PolicyEvent) => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  #emit(event: PolicyEvent): void {
    for (const fn of this.#listeners) fn(event)
  }

  submit({ text, bozo, bozoId }: { text: unknown; bozo?: string; bozoId?: string }): SubmitResult {
    const clean = normalize(text)
    if (!clean) return { action: 'ignored' }
    if (clean.length > MAX_TEXT) {
      return { action: 'rejected', reason: 'too long' }
    }

    if (this.modeFor(bozoId) === YOLO) {
      this.#emit({ type: 'sent', text: clean, bozo })
      return { action: 'send', text: clean }
    }

    if (this.#pending.size >= MAX_PENDING) {
      return { action: 'rejected', reason: 'queue full' }
    }

    const id = this.#nextId++
    const entry: PendingEntry = { id, text: clean, bozo, at: Date.now() }
    this.#pending.set(id, entry)
    this.#emit({ type: 'queued', ...entry })
    return { action: 'queued', id }
  }

  // Answering a dialog is a side effect by definition, and queueing individual
  // arrow presses for approval would be unusable, so keys are a yolo-only
  // capability rather than a third thing on the ladder. The whiteface is the
  // host, and the host can always answer the pane.
  submitKey(
    { key, bozo, bozoId, whiteface = false }:
    { key: string; bozo?: string; bozoId?: string; whiteface?: boolean },
  ): KeyResult {
    if (!ALLOWED_KEYS.has(key)) return { action: 'rejected', reason: 'unknown key' }
    if (this.modeFor(bozoId) !== YOLO && !whiteface) return { action: 'refused', reason: 'gallery' }
    this.#emit({ type: 'key', key, bozo })
    return { action: 'send', key }
  }

  list(): PendingEntry[] {
    return [...this.#pending.values()]
  }

  approve(id: number): PendingEntry | null {
    const entry = this.#pending.get(id)
    if (!entry) return null
    this.#pending.delete(id)
    this.#emit({ type: 'approved', ...entry })
    return entry
  }

  deny(id: number): PendingEntry | null {
    const entry = this.#pending.get(id)
    if (!entry) return null
    this.#pending.delete(id)
    this.#emit({ type: 'denied', ...entry })
    return entry
  }

  approveAll(): PendingEntry[] {
    const all = this.list()
    this.#pending.clear()
    for (const entry of all) this.#emit({ type: 'approved', ...entry })
    return all
  }

  denyAll(): PendingEntry[] {
    const all = this.list()
    this.#pending.clear()
    for (const entry of all) this.#emit({ type: 'denied', ...entry })
    return all
  }
}

// The old spellings stay valid wherever a mode is named, trust included. They
// are resolved here rather than at each caller so there is one list of them.
const ALIASES: Record<string, string> = { spectator: GALLERY, ring: YOLO }

function asMode(mode: string): Mode {
  const named = ALIASES[mode] ?? mode
  if (named !== GALLERY && named !== YOLO) {
    throw new Error(`unknown mode: ${mode}`)
  }
  return named
}

// The prompt box submits on Enter, so a raw newline inside bozo text would
// split one message into several turns.
function normalize(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
}
