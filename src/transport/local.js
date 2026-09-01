import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, normalize } from 'node:path'

import { handshake } from '../ws.js'
import { timingSafeEqualString } from '../secret.js'
import { MAX_BOZOS } from '../policy.js'

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

export class LocalTransport extends EventEmitter {
  name = 'local'

  #port
  #host
  #token
  #server = null
  #channels = new Set()

  constructor({ port, host, token }) {
    super()
    this.#port = port
    this.#host = host
    this.#token = token
  }

  // A wildcard bind is not an address anyone can open, and browsers refuse
  // 0.0.0.0 outright. Loopback is the one address such a socket always answers on.
  get url() {
    const host = this.#host === '0.0.0.0' || this.#host === '::' ? '127.0.0.1' : this.#host
    return `http://${host}:${this.#port}/?t=${this.#token}`
  }

  get port() {
    return this.#port
  }

  get loopbackOnly() {
    return this.#host === '127.0.0.1' || this.#host === '::1' || this.#host === 'localhost'
  }

  async start() {
    this.#server = createServer((req, res) => this.#serve(req, res))
    this.#server.on('upgrade', (req, socket) => this.#upgrade(req, socket))
    await new Promise((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(this.#port, this.#host, resolve)
    })
  }

  async stop() {
    for (const channel of this.#channels) channel.close()
    this.#server?.close()
  }

  broadcastBinary(chunk) {
    for (const channel of this.#channels) {
      if (!channel.closed) channel.sendBinary(chunk)
    }
  }

  broadcastJson(value) {
    for (const channel of this.#channels) {
      if (!channel.closed) channel.sendJson(value)
    }
  }

  async #serve(req, res) {
    const url = new URL(req.url, 'http://localhost')
    let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    file = normalize(file).replace(/^(\.\.[/\\])+/, '')
    try {
      const body = await readFile(join(WEB_ROOT, file))
      res.writeHead(200, {
        'content-type': MIME[extname(file)] || 'application/octet-stream',
        // A bozo holding a cached client against an updated ringmaster is a
        // confusing failure that looks like a broken feature.
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
    if (!timingSafeEqualString(url.searchParams.get('t'), this.#token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    // The bigtop capped this from the start; the local transport did not, and
    // it is the one everybody actually uses.
    if (this.#channels.size >= MAX_BOZOS) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
      socket.destroy()
      return
    }

    const ws = handshake(req, socket)
    if (!ws) return

    ws.id = randomBytes(4).toString('hex')
    ws.origin = 'local'
    this.#channels.add(ws)
    ws.on('close', () => this.#channels.delete(ws))
    this.emit('bozo', ws)
  }
}
