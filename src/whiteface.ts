import { timingSafeEqualString } from './secret.js'

// The whiteface is the clown who runs the ring: the host, from a browser. These
// are the control commands it may run, the same ones c2c ctl offers. status is
// out because it carries the token, stop because ending the session is the
// host's alone.
export const WHITEFACE_COMMANDS = new Set<string>([
  'list', 'mode', 'approve', 'deny', 'approve-next', 'deny-next', 'approve-all', 'deny-all',
  'outbox', 'cancel', 'cancel-all', 'bump',
])

// Set.has takes a string and gives back a boolean, which leaves the caller
// holding a type it cannot hand to the control dispatcher. This narrows.
export function isWhitefaceCommand(type: string): type is WhitefaceCommand {
  return WHITEFACE_COMMANDS.has(type)
}

export type ClaimResult = { ok: true } | { ok: false; reason: string }

// Generic in the holder so the ringmaster gets its own bozo type back out of
// .holder, while the tests can hold anything they like.
export class Whiteface<Holder = unknown> {
  #token: string | null
  #holder: Holder | null = null

  // A separate secret from the bozo token: leaking the share link must not
  // hand over control of the session with it. No token means no whiteface.
  constructor(token?: string | null) {
    this.#token = token || null
  }

  get enabled(): boolean {
    return this.#token !== null
  }

  get token(): string | null {
    return this.#token
  }

  get holder(): Holder | null {
    return this.#holder
  }

  holds(bozo: Holder | null): boolean {
    return this.#holder !== null && this.#holder === bozo
  }

  // One holder at a time. The token stays valid rather than being consumed so
  // a dropped connection can reclaim the role, but nobody can take it from
  // whoever holds it.
  claim(bozo: Holder, token: unknown): ClaimResult {
    if (!this.#token || !timingSafeEqualString(token, this.#token)) {
      return { ok: false, reason: 'bad token' }
    }
    if (this.#holder && this.#holder !== bozo) {
      return { ok: false, reason: 'someone else is the whiteface' }
    }
    this.#holder = bozo
    return { ok: true }
  }

  release(bozo: Holder): boolean {
    if (!this.holds(bozo)) return false
    this.#holder = null
    return true
  }
}
