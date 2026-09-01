import { EventEmitter } from 'node:events'

const BACKOFF_MIN = 500
const BACKOFF_MAX = 15000

// One outbound socket carries every guest in the room, so guest-addressed
// traffic is enveloped and broadcasts are sent once rather than per guest.
class BrokerGuest extends EventEmitter {
  closed = false
  origin = 'broker'

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

export class BrokerTransport extends EventEmitter {
  name = 'broker'

  #url
  #room
  #token
  #socket = null
  #guests = new Map()
  #backoff = BACKOFF_MIN
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
      this.#retry()
    })

    socket.addEventListener('error', () => {})
  }

  #dispatch(msg) {
    if (msg.event === 'join') {
      const guest = new BrokerGuest(msg.from, this)
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

  #retry(err) {
    if (this.#stopped) return
    if (err) this.emit('status', { connected: false, error: err.message })
    this.#timer = setTimeout(() => this.#connect(), this.#backoff)
    this.#backoff = Math.min(this.#backoff * 2, BACKOFF_MAX)
  }
}
