#!/usr/bin/env node
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, resolve, sep } from 'node:path'

import { handshake } from '../src/ws.js'
import { timingSafeEqualString } from '../src/secret.js'

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const MAX_GUESTS = 16
const HEARTBEAT_MS = 15000

// A broker is meant to sit on a public host, where anything unbounded is
// somebody else's memory to grow. Claiming a room costs nothing, so the number
// of them has to be capped.
const MAX_ROOMS = 64
const MAX_ROOM_NAME = 64
const MIN_TOKEN = 8

const ROOM_NAME = /^[\w.-]+$/

function validRoom(room) {
  return typeof room === 'string' && room.length <= MAX_ROOM_NAME && ROOM_NAME.test(room)
}

// A room is only as private as its token, and the broker is the one place that
// can insist the host picked a real one.
function validToken(token) {
  return typeof token === 'string' && token.length >= MIN_TOKEN && token.length <= 256
}

// Without this a half-open connection keeps a room name claimed forever: the
// host is gone but the socket never errors, so every later host gets refused.
function heartbeat(ws, intervalMs = HEARTBEAT_MS) {
  let alive = true
  ws.on('pong', () => {
    alive = true
  })
  const timer = setInterval(() => {
    if (!alive) {
      clearInterval(timer)
      ws.close()
      return
    }
    alive = false
    ws.ping()
  }, intervalMs)
  ws.on('close', () => clearInterval(timer))
  return timer
}

export class Broker {
  #rooms = new Map()
  #server = null

  constructor({ heartbeatMs = HEARTBEAT_MS } = {}) {
    this.heartbeatMs = heartbeatMs
  }

  get rooms() {
    return this.#rooms
  }

  async listen(port, host) {
    this.#server = createServer((req, res) => this.#serve(req, res))
    this.#server.on('upgrade', (req, socket) => this.#upgrade(req, socket))
    await new Promise((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(port, host, resolve)
    })
    return this.#server.address()
  }

  close() {
    for (const room of this.#rooms.values()) {
      room.host?.close()
      for (const guest of room.guests.values()) guest.close()
    }
    this.#rooms.clear()
    this.#server?.close()
  }

  async #serve(req, res) {
    const url = new URL(req.url, 'http://localhost')

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, rooms: this.#rooms.size }))
      return
    }

    // /r/<room> is the guest entry point; everything else is a static asset.
    const file = url.pathname.startsWith('/r/') ? 'index.html' : url.pathname.slice(1) || 'index.html'
    const target = resolvePublic(file)
    if (!target) {
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end('forbidden\n')
      return
    }

    try {
      const body = await readFile(target)
      res.writeHead(200, {
        'content-type': MIME[extname(file)] || 'application/octet-stream',
        'cache-control': 'no-cache, no-store, must-revalidate',
      })
      res.end(body)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found\n')
    }
  }

  #upgrade(req, socket) {
    const url = new URL(req.url, 'http://localhost')
    const room = url.searchParams.get('room')
    const token = url.searchParams.get('t')

    if (!room || !token) return reject(socket, 400, 'room and token required')
    if (!validRoom(room)) return reject(socket, 400, 'bad room name')
    if (!validToken(token)) return reject(socket, 400, 'token too short')

    if (url.pathname === '/uplink') return this.#acceptHost(req, socket, room, token)
    if (url.pathname === '/guest') return this.#acceptGuest(req, socket, room, token)
    return reject(socket, 404, 'unknown endpoint')
  }

  #acceptHost(req, socket, roomId, token) {
    const existing = this.#rooms.get(roomId)

    // A room is claimed by the first host and its token is fixed at that point,
    // so a second host cannot take the room over or probe for the secret.
    if (existing?.host && !existing.host.closed) {
      return reject(socket, 409, 'room already has a host')
    }
    if (existing && !timingSafeEqualString(token, existing.token)) {
      return reject(socket, 401, 'bad token')
    }
    if (!existing && this.#rooms.size >= MAX_ROOMS) {
      return reject(socket, 503, 'too many rooms')
    }

    const ws = handshake(req, socket)
    if (!ws) return

    const room = existing ?? { token, guests: new Map(), host: null }
    room.host = ws
    this.#rooms.set(roomId, room)
    heartbeat(ws, this.heartbeatMs)

    ws.on('text', (raw) => this.#fromHost(room, raw))
    ws.on('binary', (chunk) => {
      for (const guest of room.guests.values()) {
        if (!guest.closed) guest.sendBinary(chunk)
      }
    })
    ws.on('close', () => {
      for (const guest of room.guests.values()) {
        guest.sendJson({ type: 'notice', text: 'host disconnected' })
        guest.close()
      }
      room.guests.clear()
      room.host = null
      this.#rooms.delete(roomId)
    })

    for (const [id, guest] of room.guests) {
      if (!guest.closed) ws.sendJson({ from: id, event: 'join' })
    }
  }

  #acceptGuest(req, socket, roomId, token) {
    const room = this.#rooms.get(roomId)
    if (!room || !room.host || room.host.closed) return reject(socket, 404, 'no host in this room')
    if (!timingSafeEqualString(token, room.token)) return reject(socket, 401, 'bad token')
    if (room.guests.size >= MAX_GUESTS) return reject(socket, 429, 'room full')

    const ws = handshake(req, socket)
    if (!ws) return

    const id = randomBytes(4).toString('hex')
    room.guests.set(id, ws)
    heartbeat(ws, this.heartbeatMs)

    ws.on('text', (raw) => {
      let payload
      try {
        payload = JSON.parse(raw)
      } catch {
        return
      }
      room.host?.sendJson({ from: id, event: 'message', payload })
    })
    ws.on('close', () => {
      room.guests.delete(id)
      room.host?.sendJson({ from: id, event: 'leave' })
    })

    room.host.sendJson({ from: id, event: 'join' })
  }

  #fromHost(room, raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    const targets = msg.to === '*' ? [...room.guests.values()] : [room.guests.get(msg.to)].filter(Boolean)

    for (const guest of targets) {
      if (guest.closed) continue
      if (msg.evict) guest.close()
      else if (msg.bin) guest.sendBinary(Buffer.from(msg.bin, 'base64'))
      else if (msg.payload !== undefined) guest.sendJson(msg.payload)
    }
  }
}

// Stripping "../" prefixes is guesswork. Resolve the path and check it is still
// inside the web root, which is the only version that is actually provable.
export function resolvePublic(file, root = WEB_ROOT) {
  const target = resolve(root, '.' + (file.startsWith('/') ? file : `/${file}`))
  const base = resolve(root)
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}

function reject(socket, code, message) {
  socket.write(`HTTP/1.1 ${code} ${message}\r\n\r\n`)
  socket.destroy()
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`

if (isMain) {
  const args = process.argv.slice(2)
  const get = (flag, fallback) => {
    const index = args.indexOf(flag)
    return index === -1 ? fallback : args[index + 1]
  }

  const port = Number(get('--port', process.env.PORT || 8080))
  const host = get('--bind', process.env.BIND || '0.0.0.0')

  const broker = new Broker()
  const address = await broker.listen(port, host)
  console.log(`c2c broker listening on ${address.address}:${address.port}`)

  const shutdown = () => {
    broker.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
