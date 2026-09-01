import { createServer } from 'node:http'
import { createServer as createUnixServer } from 'node:net'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, normalize } from 'node:path'

import * as tmux from './tmux.js'
import { PaneStream } from './panestream.js'
import { Policy, SPECTATOR } from './policy.js'
import { handshake, isUpgrade } from './ws.js'
import { controlSocket, ensureStateDir, metaFile, paneFile } from './paths.js'

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

export class Relay {
  #session
  #port
  #host
  #token
  #policy = new Policy()
  #guests = new Set()
  #pane = null
  #http = null
  #control = null

  constructor({ session, port, host = '127.0.0.1', token }) {
    this.#session = session
    this.#port = port
    this.#host = host
    this.#token = token || randomBytes(16).toString('hex')
  }

  get token() {
    return this.#token
  }

  get url() {
    return `http://${this.#host}:${this.#port}/?t=${this.#token}`
  }

  get policy() {
    return this.#policy
  }

  async start() {
    await ensureStateDir(this.#session)
    await writeFile(paneFile(this.#session), '')
    await tmux.startPipe(this.#session, paneFile(this.#session))

    this.#pane = new PaneStream(paneFile(this.#session))
    this.#pane.on('data', (chunk) => this.#broadcastBinary(chunk))
    await this.#pane.start()

    this.#policy.onEvent((event) => this.#onPolicyEvent(event))

    await this.#startHttp()
    await this.#startControl()

    await writeFile(
      metaFile(this.#session),
      JSON.stringify({ session: this.#session, pid: process.pid, port: this.#port, host: this.#host, token: this.#token }, null, 2)
    )
  }

  async stop() {
    await tmux.stopPipe(this.#session)
    await this.#pane?.stop()
    for (const guest of this.#guests) guest.socket.close()
    this.#http?.close()
    this.#control?.close()
    for (const path of [controlSocket(this.#session), metaFile(this.#session)]) {
      try {
        await unlink(path)
      } catch {}
    }
  }

  async #startHttp() {
    this.#http = createServer((req, res) => this.#serveStatic(req, res))
    this.#http.on('upgrade', (req, socket) => this.#onUpgrade(req, socket))
    await new Promise((resolve, reject) => {
      this.#http.once('error', reject)
      this.#http.listen(this.#port, this.#host, resolve)
    })
  }

  async #serveStatic(req, res) {
    const url = new URL(req.url, 'http://localhost')
    let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    file = normalize(file).replace(/^(\.\.[/\\])+/, '')
    try {
      const body = await readFile(join(WEB_ROOT, file))
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found\n')
    }
  }

  async #onUpgrade(req, socket) {
    const url = new URL(req.url, 'http://localhost')
    if (url.searchParams.get('t') !== this.#token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    const ws = handshake(req, socket)
    if (!ws) return

    const guest = { id: randomBytes(4).toString('hex'), name: 'guest', socket: ws }
    this.#guests.add(guest)

    ws.on('text', (raw) => this.#onGuestMessage(guest, raw))
    ws.on('close', () => {
      this.#guests.delete(guest)
      this.#notifyHost(`c2c: ${guest.name} left (${this.#guests.size} connected)`)
    })

    const { cols, rows } = await tmux.paneSize(this.#session)
    ws.sendJson({ type: 'hello', mode: this.#policy.mode, cols, rows, guestId: guest.id })
    ws.sendJson({ type: 'screen', data: await tmux.capturePane(this.#session) })
    this.#notifyHost(`c2c: a guest connected (${this.#guests.size} connected)`)
  }

  #onGuestMessage(guest, raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    if (msg.type === 'name' && typeof msg.name === 'string') {
      guest.name = msg.name.slice(0, 40).replace(/[^\w .-]/g, '') || 'guest'
      guest.socket.sendJson({ type: 'named', name: guest.name })
      return
    }

    if (msg.type === 'submit') {
      const result = this.#policy.submit({ text: msg.text, guest: guest.name })
      if (result.action === 'send') {
        this.#inject(result.text)
        guest.socket.sendJson({ type: 'accepted', text: result.text })
      } else if (result.action === 'queued') {
        guest.socket.sendJson({ type: 'pending', id: result.id, text: msg.text })
      }
    }
  }

  async #inject(text) {
    const state = await tmux.waitForPrompt(this.#session)
    if (state !== 'prompt') {
      this.#notifyHost(`c2c: HELD a guest message, pane is ${state} - resend once the session is idle`)
      this.#broadcastJson({ type: 'policy:held', state, text })
      return false
    }
    await tmux.submit(this.#session, text)
    return true
  }

  #onPolicyEvent(event) {
    if (event.type === 'approved') {
      this.#inject(event.text)
    }
    if (event.type === 'queued') {
      this.#notifyHost(`c2c: ${event.guest} wants to send #${event.id} - c2c ctl approve ${event.id}`)
    }
    this.#broadcastJson({ ...event, type: `policy:${event.type}` })
  }

  #notifyHost(message) {
    tmux.notify(this.#session, message)
  }

  #broadcastBinary(chunk) {
    for (const guest of this.#guests) {
      if (!guest.socket.closed) guest.socket.sendBinary(chunk)
    }
  }

  #broadcastJson(value) {
    for (const guest of this.#guests) {
      if (!guest.socket.closed) guest.socket.sendJson(value)
    }
  }

  async #startControl() {
    const path = controlSocket(this.#session)
    try {
      await unlink(path)
    } catch {}

    this.#control = createUnixServer((socket) => {
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk
        let index
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          if (!line.trim()) continue
          let reply
          try {
            reply = this.#handleControl(JSON.parse(line))
          } catch (err) {
            reply = { ok: false, error: err.message }
          }
          socket.write(JSON.stringify(reply) + '\n')
        }
      })
      socket.on('error', () => {})
    })

    await new Promise((resolve, reject) => {
      this.#control.once('error', reject)
      this.#control.listen(path, resolve)
    })
  }

  #handleControl(msg) {
    switch (msg.cmd) {
      case 'status':
        return {
          ok: true,
          session: this.#session,
          mode: this.#policy.mode,
          guests: [...this.#guests].map((g) => ({ id: g.id, name: g.name })),
          pending: this.#policy.list(),
          url: this.url,
        }
      case 'mode':
        return { ok: true, mode: this.#policy.setMode(msg.mode) }
      case 'list':
        return { ok: true, pending: this.#policy.list() }
      case 'approve': {
        const entry = this.#policy.approve(Number(msg.id))
        return entry ? { ok: true, approved: entry } : { ok: false, error: `no pending message ${msg.id}` }
      }
      case 'deny': {
        const entry = this.#policy.deny(Number(msg.id))
        return entry ? { ok: true, denied: entry } : { ok: false, error: `no pending message ${msg.id}` }
      }
      case 'approve-all':
        return { ok: true, approved: this.#policy.approveAll() }
      case 'deny-all':
        return { ok: true, denied: this.#policy.denyAll() }
      case 'stop':
        setTimeout(() => process.exit(0), 50)
        return { ok: true, stopping: true }
      default:
        return { ok: false, error: `unknown command: ${msg.cmd}` }
    }
  }
}

export { SPECTATOR }
