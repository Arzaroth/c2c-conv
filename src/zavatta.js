// Zavatta: the MCP server. A human bozo is anonymous; the one that is a program
// gets a proper clown's name, after Achille Zavatta.
import { EventEmitter } from 'node:events'

import { packageVersion } from './version.js'

// Terminal output is for a terminal. An agent gets the screen as plain text.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>]/g

export function stripAnsi(text) {
  return String(text).replace(ANSI, '')
}

// A bozo that is a program rather than a browser. It speaks the same protocol
// and is subject to the same gate: nothing here can approve its own messages.
export class BozoLink extends EventEmitter {
  #url
  #name
  #socket = null

  mode = 'gallery'
  state = 'unknown'
  screen = ''
  history = []
  connected = false

  constructor({ url, name = 'zavatta' }) {
    super()
    this.#url = url
    this.#name = name
  }

  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.#url)
      socket.binaryType = 'arraybuffer'
      this.#socket = socket

      const timer = setTimeout(() => reject(new Error('timed out waiting for a hoink back')), timeoutMs)

      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'hoink', name: this.#name }))
      })

      // The pane byte stream is useless without a terminal emulator, so it is
      // dropped: the screen comes from snapshots instead.
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return
        let msg
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }
        this.#apply(msg)
        if (msg.type === 'hoink') {
          clearTimeout(timer)
          this.connected = true
          resolve(this)
        }
        this.emit('message', msg)
      })

      socket.addEventListener('close', () => {
        this.connected = false
        clearTimeout(timer)
        this.emit('closed')
        reject(new Error('connection closed before the ringmaster hoinked back'))
      })
      socket.addEventListener('error', () => {})
    })
  }

  #apply(msg) {
    if (msg.type === 'hoink') {
      this.mode = msg.mode
      this.state = msg.state ?? 'unknown'
    }
    if (msg.type === 'policy:mode') this.mode = msg.mode
    if (msg.type === 'state') this.state = msg.state
    if (msg.type === 'screen') this.screen = stripAnsi(msg.data).replace(/[ \t]+$/gm, '')
    if (msg.type === 'transcript:history') this.history = msg.entries
    if (msg.type === 'transcript') this.history.push(msg.entry)
  }

  #send(payload) {
    if (this.#socket?.readyState !== WebSocket.OPEN) throw new Error('not connected to the session')
    this.#socket.send(JSON.stringify(payload))
  }

  #await(types, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('message', onMessage)
        reject(new Error('the ringmaster did not answer'))
      }, timeoutMs)

      const onMessage = (msg) => {
        if (!types.includes(msg.type)) return
        clearTimeout(timer)
        this.off('message', onMessage)
        resolve(msg)
      }
      this.on('message', onMessage)
    })
  }

  async refresh() {
    const settled = this.#await(['screen'])
    this.#send({ type: 'refresh' })
    await settled
    return this.screen
  }

  async submit(text) {
    const settled = this.#await(['accepted', 'pending', 'rejected', 'policy:held'])
    this.#send({ type: 'submit', text })
    return settled
  }

  async press(key) {
    const settled = this.#await(['key:refused', 'state', 'screen'], 3000).catch(() => null)
    this.#send({ type: 'key', key })
    const answer = await settled
    return answer?.type === 'key:refused' ? answer : { type: 'sent', key }
  }

  close() {
    this.#socket?.close()
  }
}

const TOOLS = [
  {
    name: 'c2c_screen',
    description:
      'The shared Claude Code session as it looks right now, as plain text. Fetches a fresh snapshot.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'c2c_history',
    description:
      'The conversation in the shared session so far: who said what, and which tools were used. Covers turns from before you joined.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Most recent N turns (default 20)' } },
    },
  },
  {
    name: 'c2c_status',
    description:
      'Whether you are connected, the current mode (gallery or yolo), and what the session is doing.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'c2c_send',
    description:
      'Send a message to the shared session. In gallery mode it waits for the host to release it; in yolo it goes straight in. You cannot release your own messages.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'What to say to the session' } },
      required: ['text'],
    },
  },
  {
    name: 'c2c_press',
    description:
      'Press a key when the session is asking a question (arrow keys, Enter, Escape, digits). Refused in gallery mode, because answering a prompt is a side effect.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'One of Up, Down, Left, Right, Enter, Escape, Tab, BSpace, or 1-9',
        },
      },
      required: ['key'],
    },
  },
]

// Deliberately absent: approve, deny and mode. An agent that could release its
// own messages would not be a bozo, it would be an unlocked door - the whole
// gate rests on those staying with the host.
export class McpServer {
  #link
  #buffer = ''

  constructor(link) {
    this.#link = link
  }

  start(input = process.stdin, output = process.stdout) {
    this.out = output
    input.setEncoding('utf8')
    input.on('data', (chunk) => {
      this.#buffer += chunk
      let index
      while ((index = this.#buffer.indexOf('\n')) !== -1) {
        const line = this.#buffer.slice(0, index).trim()
        this.#buffer = this.#buffer.slice(index + 1)
        if (line) this.#handle(line)
      }
    })
  }

  #write(message) {
    this.out.write(JSON.stringify(message) + '\n')
  }

  #reply(id, result) {
    if (id !== undefined && id !== null) this.#write({ jsonrpc: '2.0', id, result })
  }

  #fail(id, message) {
    if (id !== undefined && id !== null) {
      this.#write({ jsonrpc: '2.0', id, error: { code: -32000, message } })
    }
  }

  async #handle(line) {
    let request
    try {
      request = JSON.parse(line)
    } catch {
      return
    }

    const { id, method, params } = request
    try {
      if (method === 'initialize') {
        this.#reply(id, {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'zavatta', version: packageVersion() },
        })
        return
      }
      if (method === 'notifications/initialized') return
      if (method === 'ping') return this.#reply(id, {})
      if (method === 'tools/list') return this.#reply(id, { tools: TOOLS })
      if (method === 'tools/call') return this.#reply(id, await this.#call(params))
      if (id !== undefined) this.#fail(id, `unknown method: ${method}`)
    } catch (err) {
      this.#fail(id, err.message)
    }
  }

  async #call({ name, arguments: args = {} }) {
    const text = await this.#run(name, args)
    return { content: [{ type: 'text', text }] }
  }

  async #run(name, args) {
    const link = this.#link

    if (name === 'c2c_screen') {
      return (await link.refresh()) || '(the session screen is empty)'
    }

    if (name === 'c2c_history') {
      const limit = Number(args.limit) > 0 ? Number(args.limit) : 20
      const turns = link.history.slice(-limit)
      if (!turns.length) return '(nothing in the conversation yet)'
      return turns
        .map((turn) => {
          const who = turn.role === 'user' ? 'typed' : 'claude'
          const tools = turn.tools?.length ? `\n  [tools: ${turn.tools.join(', ')}]` : ''
          return `${who}: ${turn.text}${tools}`
        })
        .join('\n\n')
    }

    if (name === 'c2c_status') {
      return [
        `connected: ${link.connected}`,
        `mode: ${link.mode}${link.mode === 'gallery' ? ' (your messages wait for the host)' : ' (your messages go straight in)'}`,
        `session: ${link.state}`,
        `turns known: ${link.history.length}`,
      ].join('\n')
    }

    if (name === 'c2c_send') {
      if (!args.text) throw new Error('text is required')
      const answer = await link.submit(args.text)
      if (answer.type === 'accepted') return 'Sent into the session.'
      if (answer.type === 'pending') return `Queued as #${answer.id}. It reaches the session when the host releases it.`
      if (answer.type === 'rejected') return `Not sent: ${answer.reason}.`
      if (answer.type === 'policy:held') {
        return `Held: the session is ${answer.state}. Try again once it is ready.`
      }
      return 'Sent.'
    }

    if (name === 'c2c_press') {
      const answer = await link.press(args.key)
      if (answer.type === 'key:refused') {
        return `Refused: ${answer.reason === 'gallery' ? 'only the host can answer prompts in gallery mode' : answer.reason}.`
      }
      return `Pressed ${args.key}.`
    }

    throw new Error(`unknown tool: ${name}`)
  }
}
