// Everything cleared to reach the session goes through here, one at a time.
// The gate in policy.ts decides whether a message may be sent at all; this
// decides when it actually lands, and holds it until then.
//
// Before this existed a cleared message was written straight to the pane, and a
// pane that was busy for longer than the timeout dropped it with a notice. A
// message someone was told was sent, that never arrived, is the one failure the
// design cannot afford.

export const MAX_OUTBOX = 50

// How long to sit before looking at the pane again while the head is blocked.
export const RETRY_MS = 400

// drain waits for the session to finish a turn before the next message goes in,
// so the queue is visible here and the order is ours. through types into a busy
// pane and lets claude do its own queueing, so the messages end up in its UI
// instead: faster, but nothing can be cancelled once it is in.
export const OUTBOX_MODES: OutboxMode[] = ['drain', 'through']

export type SendOutcome =
  | { ok: true }
  | { ok: false; retry: boolean; reason: HoldReason }

export type OutboxEvent =
  | { type: 'changed' }
  | { type: 'sent'; entry: OutboxEntry }
  | { type: 'failed'; entry: OutboxEntry; reason: HoldReason }
  | { type: 'waiting'; entry: OutboxEntry; reason: HoldReason }

export type CancelResult =
  | { ok: true; entry: OutboxEntry }
  | { ok: false; error: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class Outbox {
  #queue: OutboxEntry[] = []
  #nextId = 1
  #mode: OutboxMode
  #send: (entry: OutboxEntry) => Promise<SendOutcome>
  #listeners = new Set<(event: OutboxEvent) => void>()
  #pumping = false
  #stopped = false
  #retryMs: number

  constructor(
    { mode = 'drain', send, retryMs = RETRY_MS }:
    { mode?: OutboxMode; send: (entry: OutboxEntry) => Promise<SendOutcome>; retryMs?: number },
  ) {
    this.#mode = mode
    this.#send = send
    this.#retryMs = retryMs
  }

  get mode(): OutboxMode {
    return this.#mode
  }

  get idle(): boolean {
    return !this.#pumping && this.#queue.length === 0
  }

  onEvent(fn: (event: OutboxEvent) => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  list(): OutboxEntry[] {
    return this.#queue.map((entry) => ({ ...entry }))
  }

  add({ text, bozo }: { text: string; bozo?: string }): OutboxEntry | null {
    if (this.#queue.length >= MAX_OUTBOX) return null
    const entry: OutboxEntry = {
      id: this.#nextId++,
      text,
      bozo,
      at: Date.now(),
      state: 'waiting',
    }
    this.#queue.push(entry)
    this.#emit({ type: 'changed' })
    this.#pump()
    return entry
  }

  // The one in flight is already going down the wire, so it cannot be taken
  // back. Saying so is better than reporting a cancel that did not happen.
  cancel(id: number): CancelResult {
    const index = this.#queue.findIndex((entry) => entry.id === id)
    if (index === -1) return { ok: false, error: `nothing in the outbox with id ${id}` }
    const entry = this.#queue[index]
    if (entry.state === 'sending') return { ok: false, error: `o${id} is already going in` }
    this.#queue.splice(index, 1)
    this.#emit({ type: 'changed' })
    return { ok: true, entry }
  }

  cancelAll(): OutboxEntry[] {
    const dropped = this.#queue.filter((entry) => entry.state !== 'sending')
    this.#queue = this.#queue.filter((entry) => entry.state === 'sending')
    if (dropped.length) this.#emit({ type: 'changed' })
    return dropped
  }

  // To the front of the line, or behind whatever is already going in.
  bump(id: number): CancelResult {
    const index = this.#queue.findIndex((entry) => entry.id === id)
    if (index === -1) return { ok: false, error: `nothing in the outbox with id ${id}` }
    const entry = this.#queue[index]
    if (entry.state === 'sending') return { ok: false, error: `o${id} is already going in` }
    const front = this.#queue[0]?.state === 'sending' ? 1 : 0
    if (index === front) return { ok: true, entry }
    this.#queue.splice(index, 1)
    this.#queue.splice(front, 0, entry)
    this.#emit({ type: 'changed' })
    return { ok: true, entry }
  }

  stop(): void {
    this.#stopped = true
  }

  #emit(event: OutboxEvent): void {
    for (const fn of this.#listeners) fn(event)
  }

  async #pump(): Promise<void> {
    if (this.#pumping || this.#stopped) return
    this.#pumping = true
    try {
      while (this.#queue.length && !this.#stopped) {
        // The reason is deliberately left on the entry across an attempt: it is
        // what tells a repeat block from a new one, and "still busy" in the
        // host's pane every time round the loop is worse than silence.
        const entry = this.#queue[0]
        entry.state = 'sending'
        this.#emit({ type: 'changed' })

        const outcome = await this.#send(entry)

        // Cancelling the head is refused while it is in flight, so it is still
        // ours - but the queue behind it may have been rearranged.
        if (this.#queue[0] !== entry) continue

        if (outcome.ok) {
          this.#queue.shift()
          entry.state = 'waiting'
          this.#emit({ type: 'sent', entry })
          this.#emit({ type: 'changed' })
          continue
        }

        if (!outcome.retry) {
          this.#queue.shift()
          this.#emit({ type: 'failed', entry, reason: outcome.reason })
          this.#emit({ type: 'changed' })
          continue
        }

        // Blocked, not lost. The reason is worth saying once per change rather
        // than every time round the loop.
        const changed = entry.reason !== outcome.reason
        entry.state = 'waiting'
        entry.reason = outcome.reason
        if (changed) this.#emit({ type: 'waiting', entry, reason: outcome.reason })
        this.#emit({ type: 'changed' })
        await sleep(this.#retryMs)
      }
    } finally {
      this.#pumping = false
    }
  }
}
