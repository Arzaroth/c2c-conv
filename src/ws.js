import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// A peer can declare a payload length far larger than it ever intends to send.
// Without a cap the receive buffer grows until the process dies, so an oversized
// frame ends the connection instead.
export const MAX_MESSAGE = 1024 * 1024

const TEXT = 0x1
const BINARY = 0x2
const CLOSE = 0x8
const PING = 0x9
const PONG = 0xa

export function isUpgrade(req) {
  return (req.headers.upgrade || '').toLowerCase() === 'websocket'
}

export function handshake(req, socket) {
  const key = req.headers['sec-websocket-key']
  if (!key) {
    socket.destroy()
    return null
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  )
  return new WebSocket(socket)
}

export class WebSocket extends EventEmitter {
  #socket
  #buffer = Buffer.alloc(0)
  #fragments = []
  #fragmentOpcode = null
  #closed = false

  constructor(socket) {
    super()
    this.#socket = socket
    socket.setNoDelay(true)
    socket.on('data', (chunk) => this.#feed(chunk))
    socket.on('close', () => this.#finish())
    socket.on('error', () => this.#finish())
  }

  get closed() {
    return this.#closed
  }

  sendText(data) {
    this.#send(Buffer.from(data, 'utf8'), TEXT)
  }

  sendJson(value) {
    this.sendText(JSON.stringify(value))
  }

  sendBinary(data) {
    this.#send(Buffer.isBuffer(data) ? data : Buffer.from(data), BINARY)
  }

  ping() {
    this.#send(Buffer.alloc(0), PING)
  }

  close() {
    if (this.#closed) return
    this.#send(Buffer.alloc(0), CLOSE)
    this.#socket.end()
    this.#finish()
  }

  #send(payload, opcode) {
    if (this.#closed || this.#socket.destroyed) return
    const len = payload.length
    let header
    if (len < 126) {
      header = Buffer.alloc(2)
      header[1] = len
    } else if (len < 65536) {
      header = Buffer.alloc(4)
      header[1] = 126
      header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.alloc(10)
      header[1] = 127
      header.writeBigUInt64BE(BigInt(len), 2)
    }
    header[0] = 0x80 | opcode
    this.#socket.write(Buffer.concat([header, payload]))
  }

  #finish() {
    if (this.#closed) return
    this.#closed = true
    this.emit('close')
  }

  #feed(chunk) {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk
    // Covers a peer that dribbles bytes towards an oversized frame it declared.
    if (this.#buffer.length > MAX_MESSAGE + 1024) {
      this.close()
      return
    }
    while (this.#step()) {}
  }

  #step() {
    const buf = this.#buffer
    if (buf.length < 2) return false

    const fin = (buf[0] & 0x80) !== 0
    const opcode = buf[0] & 0x0f
    const masked = (buf[1] & 0x80) !== 0
    let len = buf[1] & 0x7f
    let offset = 2

    if (len === 126) {
      if (buf.length < offset + 2) return false
      len = buf.readUInt16BE(offset)
      offset += 2
    } else if (len === 127) {
      if (buf.length < offset + 8) return false
      const big = buf.readBigUInt64BE(offset)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.close()
        return false
      }
      len = Number(big)
      offset += 8
    }

    if (len > MAX_MESSAGE) {
      this.close()
      return false
    }

    // RFC 6455 requires every client-to-server frame to be masked.
    if (!masked) {
      this.close()
      return false
    }
    if (buf.length < offset + 4 + len) return false

    const mask = buf.subarray(offset, offset + 4)
    offset += 4
    const payload = Buffer.allocUnsafe(len)
    for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i & 3]
    this.#buffer = buf.subarray(offset + len)

    if (opcode === CLOSE) {
      this.close()
      return false
    }
    if (opcode === PING) {
      this.#send(payload, PONG)
      return true
    }
    if (opcode === PONG) {
      this.emit('pong')
      return true
    }

    if (opcode === 0) {
      this.#fragments.push(payload)
    } else {
      this.#fragments = [payload]
      this.#fragmentOpcode = opcode
    }

    // Each fragment can be under the cap while the reassembled message is not.
    if (this.#fragments.reduce((total, part) => total + part.length, 0) > MAX_MESSAGE) {
      this.close()
      return false
    }

    if (fin) {
      const full = Buffer.concat(this.#fragments)
      const kind = this.#fragmentOpcode
      this.#fragments = []
      this.#fragmentOpcode = null
      if (kind === TEXT) this.emit('text', full.toString('utf8'))
      else if (kind === BINARY) this.emit('binary', full)
    }
    return true
  }
}
