import { EventEmitter } from 'node:events'

const BACKOFF_MIN = 500
const BACKOFF_MAX = 15000

// One outbound socket carries every guest in the room, so guest-addressed
// traffic is enveloped and broadcasts are sent once rather than per guest.
class BigtopGuest extends EventEmitter {
  closed = false
  origin = 'bigtop'

  constructor(id, uplink) {
    super()
    this.id = id
    this.uplink = uplink
  }

  sendJson(payload) {
    this.uplink.sendTo(this.id, payload)
  }

  sendBinary(chunk) {
    this.uplink.sendBinaryTo(this.id, chunk)
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.uplink.evict(this.id)
    this.emit('close')
  }
}

export class BigtopTransport extends EventEmitter {
  name = 'bigtop'

  #url
  #room
  #token
  #socket = null
  #guests = new Map()
  #backoff = BACKOFF_MIN
  #diagnosed = false
  #stopped = false
  #timer = null

  constructor({ url, room, token }) {
    super()
    this.#url = url.replace(/\/$/, '')
    this.#room = room
    this.#token = token
  }

  get guestUrl() {
    const http = this.#url.replace(/^ws/, 'http')
    return `${http}/r/${encodeURIComponent(this.#room)}?t=${encodeURIComponent(this.#token)}`
  }

  get connected() {
    return this.#socket?.readyState === WebSocket.OPEN
  }

  async start() {
    this.#connect()
  }

  async stop() {
    this.#stopped = true
    clearTimeout(this.#timer)
    for (const guest of this.#guests.values()) guest.close()
    this.#guests.clear()
    this.#socket?.close()
  }

  broadcastBinary(chunk) {
    this.#send(chunk)
  }

  broadcastJson(value) {
    this.#send(JSON.stringify({ to: '*', payload: value }))
  }

  sendTo(id, payload) {
    this.#send(JSON.stringify({ to: id, payload }))
  }

  sendBinaryTo(id, chunk) {
    this.#send(JSON.stringify({ to: id, bin: chunk.toString('base64') }))
  }

  evict(id) {
    this.#guests.delete(id)
    this.#send(JSON.stringify({ to: id, evict: true }))
  }

  #send(data) {
    if (!this.connected) return
    try {
      this.#socket.send(data)
    } catch {}
  }

  #connect() {
    if (this.#stopped) return

    const url = `${this.#url}/uplink?room=${encodeURIComponent(this.#room)}&t=${encodeURIComponent(this.#token)}`
    let socket
    try {
      socket = new WebSocket(url)
    } catch (err) {
      this.#retry(err)
      return
    }
    this.#socket = socket

    socket.addEventListener('open', () => {
      this.#backoff = BACKOFF_MIN
      this.#diagnosed = false
      this.emit('status', { connected: true, room: this.#room })
    })

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      this.#dispatch(msg)
    })

    socket.addEventListener('close', (event) => {
      for (const guest of this.#guests.values()) guest.close()
      this.#guests.clear()
      this.emit('status', { connected: false, code: event.code, reason: event.reason })
      this.#diagnose()
      this.#retry()
    })

    // Nothing useful here: a failed WebSocket hands back a bare TypeError with
    // no message and no cause, so the reason is diagnosed separately below.
    socket.addEventListener('error', () => {})
  }

  #dispatch(msg) {
    if (msg.event === 'join') {
      const guest = new BigtopGuest(msg.from, this)
      this.#guests.set(msg.from, guest)
      this.emit('guest', guest)
      return
    }
    if (msg.event === 'leave') {
      const guest = this.#guests.get(msg.from)
      if (guest) {
        this.#guests.delete(msg.from)
        guest.closed = true
        guest.emit('close')
      }
      return
    }
    if (msg.event === 'message') {
      const guest = this.#guests.get(msg.from)
      if (guest) guest.emit('text', JSON.stringify(msg.payload))
    }
  }

  // A websocket failure carries no reason, but an ordinary request to the same
  // origin does, so one probe turns "code 1006" into something a deployer can
  // act on: a bad certificate, a refused connection, an unknown host. Runs once
  // per outage rather than on every retry.
  async #diagnose() {
    if (this.#diagnosed || this.#stopped) return
    this.#diagnosed = true

    const origin = this.#url.replace(/^ws/, 'http')
    try {
      const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(5000) })
      this.emit('status', {
        connected: false,
        hint: response.ok
          ? 'bigtop is reachable but refused the uplink - check the room name and token'
          : `bigtop answered ${response.status} on /healthz`,
      })
    } catch (err) {
      // fetch reports "fetch failed"; the actual reason (ECONNREFUSED, a TLS
      // error code, ENOTFOUND) is one level down in cause.
      const cause = err.cause?.code ?? err.cause?.message
      this.emit('status', {
        connected: false,
        hint: `cannot reach bigtop: ${cause ?? err.message}`,
      })
    }
  }

  #retry(err) {
    if (this.#stopped) return
    if (err) this.emit('status', { connected: false, error: err.message })
    this.#timer = setTimeout(() => this.#connect(), this.#backoff)
    this.#backoff = Math.min(this.#backoff * 2, BACKOFF_MAX)
  }
}
