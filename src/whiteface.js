import { timingSafeEqualString } from './secret.js'

// The whiteface is the clown who runs the ring: the host, from a browser. These
// are the control commands it may run, the same ones c2c ctl offers. status is
// out because it carries the token, stop because ending the session is the
// host's alone.
export const WHITEFACE_COMMANDS = new Set([
  'list', 'mode', 'approve', 'deny', 'approve-next', 'deny-next', 'approve-all', 'deny-all',
])

export class Whiteface {
  #token
  #holder = null

  // A separate secret from the bozo token: leaking the share link must not
  // hand over control of the session with it. No token means no whiteface.
  constructor(token) {
    this.#token = token || null
  }

  get enabled() {
    return this.#token !== null
  }

  get token() {
    return this.#token
  }

  get holder() {
    return this.#holder
  }

  holds(bozo) {
    return this.#holder !== null && this.#holder === bozo
  }

  // One holder at a time. The token stays valid rather than being consumed so
  // a dropped connection can reclaim the role, but nobody can take it from
  // whoever holds it.
  claim(bozo, token) {
    if (!this.#token || !timingSafeEqualString(token, this.#token)) {
      return { ok: false, reason: 'bad token' }
    }
    if (this.#holder && this.#holder !== bozo) {
      return { ok: false, reason: 'someone else is the whiteface' }
    }
    this.#holder = bozo
    return { ok: true }
  }

  release(bozo) {
    if (!this.holds(bozo)) return false
    this.#holder = null
    return true
  }
}
