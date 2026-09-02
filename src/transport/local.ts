import { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { extname, join, normalize } from 'node:path'
import type { Duplex } from 'node:stream'

import { handshake, WebSocket } from '../ws.js'
import { timingSafeEqualString } from '../secret.js'
import { MAX_BOZOS } from '../policy.js'
import { WEB_ROOT } from '../root.js'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

export class LocalTransport extends EventEmitter implements Transport {
  readonly name = 'local'

  #port: number
  #host: string
  #token: string
  #server: Server | null = null
  #channels = new Set<WebSocket>()

  constructor({ port, host, token }: { port: number; host: string; token: string }) {
    super()
    this.#port = port
    this.#host = host
    this.#token = token
  }

  // A wildcard bind is not an address anyone can open, and browsers refuse
  // 0.0.0.0 outright. Loopback is the one address such a socket always answers on.
  get url(): string {
    const host = this.#host === '0.0.0.0' || this.#host === '::' ? '127.0.0.1' : this.#host
    return `http://${host}:${this.#port}/?t=${this.#token}`
  }

  get port(): number {
    return this.#port
  }

  get loopbackOnly(): boolean {
    return this.#host === '127.0.0.1' || this.#host === '::1' || this.#host === 'localhost'
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => this.#serve(req, res))
    server.on('upgrade', (req, socket) => this.#upgrade(req, socket))
    this.#server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.#port, this.#host, resolve)
    })
  }

  async stop(): Promise<void> {
    for (const channel of this.#channels) channel.close()
    this.#server?.close()
  }

  broadcastBinary(chunk: Uint8Array): void {
    for (const channel of this.#channels) {
      if (!channel.closed) channel.sendBinary(chunk)
    }
  }

  broadcastJson(value: ServerMessage): void {
    for (const channel of this.#channels) {
      if (!channel.closed) channel.sendJson(value)
    }
  }

  async #serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
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

  #upgrade(req: IncomingMessage, socket: Duplex): void {
    const url = new URL(req.url ?? '/', 'http://localhost')
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
