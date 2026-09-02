// farce-to-farce: the lane between the clowns that never reaches claude.
//
// clown to clown is what the session hears. This is not that: nothing said here
// is injected, queued or transcribed, so "wait, do not run that" can be said
// without becoming a prompt. It is the one thing two people sharing a session
// could not do before.

export const MAX_F2F_TEXT = 2000

// Enough to catch up on arrival without turning the greeting into a transfer.
export const F2F_HISTORY = 200

export class Farce {
  #msgs: F2fMessage[] = []
  #nextId = 1

  say({ from, text, host = false }: { from: string; text: unknown; host?: boolean }): F2fMessage | null {
    const clean = normalize(text)
    if (!clean) return null
    const msg: F2fMessage = {
      id: this.#nextId++,
      from,
      text: clean.slice(0, MAX_F2F_TEXT),
      at: Date.now(),
      host,
    }
    this.#msgs.push(msg)
    if (this.#msgs.length > F2F_HISTORY) this.#msgs.shift()
    return msg
  }

  history(limit?: number): F2fMessage[] {
    return limit && limit > 0 ? this.#msgs.slice(-limit) : [...this.#msgs]
  }
}

// The composer is one line, and a chat message spread over several rows would
// only be a rendering problem for everybody else.
function normalize(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
}
