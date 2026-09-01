import { createServer as createUnixServer } from 'node:net'
import { unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

import * as tmux from './tmux.js'
import { PaneStream } from './panestream.js'
import { Policy, SPECTATOR } from './policy.js'
import { LocalTransport } from './transport/local.js'
import { BrokerTransport } from './transport/broker.js'
import { controlSocket, ensureStateDir, metaFile, paneFile } from './paths.js'

export class Relay {
  #session
  #token
  #policy = new Policy()
  #guests = new Map()
  #transports = []
  #pane = null
  #control = null
  #brokerStatus = null

  constructor({ session, port, host = '127.0.0.1', token, broker }) {
    this.#session = session
    this.#token = token || randomBytes(16).toString('hex')

    this.#transports.push(new LocalTransport({ port, host, token: this.#token }))

    if (broker?.url) {
      this.#transports.push(
        new BrokerTransport({ url: broker.url, room: broker.room, token: broker.token || this.#token })
      )
    }
  }

  get token() {
    return this.#token
  }

  get local() {
    return this.#transports.find((t) => t.name === 'local')
  }

  get broker() {
    return this.#transports.find((t) => t.name === 'broker')
  }

  get url() {
    return this.local.url
  }

  get policy() {
    return this.#policy
  }

  async start() {
    await ensureStateDir(this.#session)
    await writeFile(paneFile(this.#session), '')
    await tmux.startPipe(this.#session, paneFile(this.#session))

    this.#pane = new PaneStream(paneFile(this.#session))
    this.#pane.on('data', (chunk) => {
      for (const transport of this.#transports) transport.broadcastBinary(chunk)
    })
    await this.#pane.start()

    this.#policy.onEvent((event) => this.#onPolicyEvent(event))

    for (const transport of this.#transports) {
      transport.on('guest', (channel) => this.#onGuest(channel))
      transport.on('status', (status) => {
        this.#brokerStatus = status
        console.log(`[broker] ${JSON.stringify(status)}`)
      })
      await transport.start()
    }

    await this.#startControl()
    await writeFile(metaFile(this.#session), JSON.stringify(this.#meta(), null, 2))
  }

  async stop() {
    await tmux.stopPipe(this.#session)
    await this.#pane?.stop()
    for (const transport of this.#transports) await transport.stop()
    this.#control?.close()
    for (const path of [controlSocket(this.#session), metaFile(this.#session)]) {
      try {
        await unlink(path)
      } catch {}
    }
  }

  #meta() {
    const local = this.local
    return {
      session: this.#session,
      pid: process.pid,
      port: local.port,
      token: this.#token,
      url: local.url,
      broker: this.broker ? { url: this.broker.guestUrl } : null,
    }
  }

  async #onGuest(channel) {
    const guest = { id: channel.id, name: 'guest', origin: channel.origin, channel }
    this.#guests.set(channel.id, guest)

    channel.on('text', (raw) => this.#onGuestMessage(guest, raw))
    channel.on('close', () => {
      this.#guests.delete(channel.id)
      this.#notifyHost(`c2c: ${guest.name} left (${this.#guests.size} connected)`)
    })

    const { cols, rows } = await tmux.paneSize(this.#session)
    channel.sendJson({ type: 'hello', mode: this.#policy.mode, cols, rows, guestId: guest.id })
    channel.sendJson({ type: 'screen', data: await tmux.capturePane(this.#session) })
    this.#notifyHost(`c2c: a guest connected via ${channel.origin} (${this.#guests.size} connected)`)
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
      guest.channel.sendJson({ type: 'named', name: guest.name })
      return
    }

    if (msg.type === 'submit') {
      const result = this.#policy.submit({ text: msg.text, guest: guest.name })
      if (result.action === 'send') {
        this.#inject(result.text)
        guest.channel.sendJson({ type: 'accepted', text: result.text })
      } else if (result.action === 'queued') {
        guest.channel.sendJson({ type: 'pending', id: result.id, text: msg.text })
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

  #broadcastJson(value) {
    for (const transport of this.#transports) transport.broadcastJson(value)
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
          guests: [...this.#guests.values()].map((g) => ({ id: g.id, name: g.name, via: g.origin })),
          pending: this.#policy.list(),
          url: this.url,
          broker: this.broker
            ? { url: this.broker.guestUrl, connected: this.broker.connected, last: this.#brokerStatus }
            : null,
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
