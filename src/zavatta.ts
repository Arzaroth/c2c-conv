// Zavatta: the MCP server. A human bozo is anonymous; the one that is a program
// gets a proper clown's name, after Achille Zavatta.
import { EventEmitter } from 'node:events'

import { packageVersion } from './version.js'

// Terminal output is for a terminal. An agent gets the screen as plain text.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>]/g

export function stripAnsi(text: unknown): string {
  return String(text).replace(ANSI, '')
}

// What a wait is watching for. idle is the one an agent wants after sending:
// the session is at a prompt and nothing of its own is still on the way in.
export const WAIT_FOR = ['idle', 'dialog', 'reply', 'lane', 'anything'] as const
export type WaitFor = (typeof WAIT_FOR)[number]
export type WaitWhy = Exclude<WaitFor, 'anything'>

export interface WaitResult {
  done: boolean
  why: WaitWhy | null
  state: PaneState
}

// An MCP client cuts a tool call that never returns, so a wait is bounded and
// comes back saying nothing happened rather than erroring.
export const WAIT_MS = 60_000
export const MAX_WAIT_MS = 300_000

export const RETRY_MIN_MS = 500
export const RETRY_MAX_MS = 8000

export const HISTORY_PAGE = 20
export const SCROLLBACK_LINES = 500

// Turns are numbered from the oldest the ringmaster still holds, so before=N
// pages back from a page that has already been read.
export function historyPage(
  turns: TranscriptEntry[],
  { limit, before }: { limit?: unknown; before?: unknown } = {},
): string {
  if (!turns.length) return '(nothing in the conversation yet)'
  const size = Number(limit) > 0 ? Math.trunc(Number(limit)) : HISTORY_PAGE
  const end = Number(before) > 0 ? Math.min(Math.trunc(Number(before)) - 1, turns.length) : turns.length
  if (end <= 0) return `(nothing before turn 1: ${turns.length} turns in all)`
  const start = Math.max(0, end - size)

  const page = turns.slice(start, end).map((turn, index) => {
    const who = turn.role === 'user' ? 'typed' : 'claude'
    const tools = turn.tools?.length ? `\n  [tools: ${turn.tools.join(', ')}]` : ''
    return `#${start + index + 1} ${who}: ${turn.text}${tools}`
  })
  const older = start > 0 ? ` Older turns: before=${start + 1}.` : ''
  return [`turns ${start + 1}-${end} of ${turns.length}.${older}`, ...page].join('\n\n')
}

// The two halves of a wait in one place: what the link already looks like, and
// what a message did to it. A null message is the check made before anything
// has arrived, so a session that is already free answers at once rather than
// waiting for a change that has been and gone.
export function wakes(
  what: WaitFor,
  msg: ServerMessage | null,
  link: { state: PaneState; outbox: OutboxEntry[]; pending: PendingEntry[] },
): WaitWhy | null {
  const any = what === 'anything'
  // Free means free for this agent: a message of its own still held by the
  // host, or still queued to go in, means the turn it is waiting on has not
  // been asked for yet.
  if (any || what === 'idle') {
    if (link.state === 'prompt' && !link.outbox.length && !link.pending.length) return 'idle'
  }
  if ((any || what === 'dialog') && link.state === 'dialog') return 'dialog'
  if (!msg) return null
  if ((any || what === 'reply') && msg.type === 'transcript' && msg.entry.role === 'assistant') {
    return 'reply'
  }
  if ((any || what === 'lane') && msg.type === 'f2f') return 'lane'
  return null
}

// A bozo that is a program rather than a browser. It speaks the same protocol
// and is subject to the same gate: nothing here can approve its own messages.
export class BozoLink extends EventEmitter {
  #url: string
  #name: string
  #socket: WebSocket | null = null

  mode: Mode = 'gallery'
  state: PaneState = 'unknown'
  screen = ''
  history: TranscriptEntry[] = []
  // This agent's own submissions still held by the host. policy:queued goes to
  // the whiteface alone, so what lands here is what it was told about itself.
  pending: PendingEntry[] = []
  outbox: OutboxEntry[] = []
  outboxMode: OutboxMode = 'drain'
  lane: F2fMessage[] = []
  // Who else is in the circus. mode on this link is this agent's own, which is
  // the room default until the host trusts it personally.
  circus: RosterEntry[] = []
  roomMode: Mode = 'gallery'
  connected = false
  // A dropped socket is a ringmaster restarting as often as a session ending,
  // and only a bye says which. An MCP server that exited on the first would
  // take the agent's tools away for good.
  #joined = false
  #ended = false
  #retryMs = RETRY_MIN_MS

  constructor({ url, name = 'zavatta' }: { url: string; name?: string }) {
    super()
    this.#url = url
    this.#name = name
  }

  connect(timeoutMs = 10000): Promise<this> {
    return new Promise<this>((resolve, reject) => {
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
        let msg: ServerMessage
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }
        this.#apply(msg)
        if (msg.type === 'hoink') {
          clearTimeout(timer)
          this.connected = true
          this.#joined = true
          this.#retryMs = RETRY_MIN_MS
          resolve(this)
        }
        if (msg.type === 'bye') {
          this.#ended = true
          this.emit('ended', msg.text)
        }
        this.emit('message', msg)
      })

      socket.addEventListener('close', () => {
        this.connected = false
        clearTimeout(timer)
        this.emit('closed')
        reject(new Error('connection closed before the ringmaster hoinked back'))
        if (this.#joined && !this.#ended) this.#reconnect()
      })
      socket.addEventListener('error', () => {})
    })
  }

  #reconnect(): void {
    const delay = this.#retryMs
    this.#retryMs = Math.min(this.#retryMs * 2, RETRY_MAX_MS)
    setTimeout(() => {
      if (this.#ended) return
      this.connect().then(
        () => this.emit('reconnected'),
        () => {},
      )
    }, delay)
  }

  #apply(msg: ServerMessage): void {
    if (msg.type === 'hoink') {
      this.mode = msg.mode
      this.state = msg.state ?? 'unknown'
      this.outbox = msg.outbox ?? []
      this.outboxMode = msg.outboxMode ?? 'drain'
      this.lane = msg.f2f ?? []
    }
    if (msg.type === 'outbox') {
      this.outbox = msg.entries
      this.outboxMode = msg.mode
    }
    if (msg.type === 'f2f') this.lane.push(msg.msg)
    if (msg.type === 'pending') {
      this.pending.push({ id: msg.id, text: msg.text, bozo: msg.bozo, at: Date.now() })
    }
    if (msg.type === 'policy:approved' || msg.type === 'policy:denied') {
      this.pending = this.pending.filter((entry) => entry.id !== msg.id)
    }
    if (msg.type === 'policy:mode') this.mode = msg.mode
    if (msg.type === 'roster') {
      this.circus = msg.bozos
      this.roomMode = msg.mode
    }
    if (msg.type === 'state') this.state = msg.state
    if (msg.type === 'screen') this.screen = stripAnsi(msg.data).replace(/[ \t]+$/gm, '')
    if (msg.type === 'transcript:history') this.history = msg.entries
    if (msg.type === 'transcript') this.history.push(msg.entry)
  }

  #send(payload: BozoMessage): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) {
      throw new Error(this.#joined && !this.#ended
        ? 'not connected to the session right now - reconnecting, try again in a moment'
        : 'not connected to the session')
    }
    this.#socket.send(JSON.stringify(payload))
  }

  #await(types: ServerMessage['type'][], timeoutMs = 8000): Promise<ServerMessage> {
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('message', onMessage)
        reject(new Error('the ringmaster did not answer'))
      }, timeoutMs)

      const onMessage = (msg: ServerMessage) => {
        if (!types.includes(msg.type)) return
        clearTimeout(timer)
        this.off('message', onMessage)
        resolve(msg)
      }
      this.on('message', onMessage)
    })
  }

  async scrollback(lines: number): Promise<string> {
    const settled = this.#await(['scrollback'])
    this.#send({ type: 'scrollback', lines })
    const answer = await settled
    return answer.type === 'scrollback' ? stripAnsi(answer.data).replace(/[ \t]+$/gm, '') : ''
  }

  async refresh(): Promise<string> {
    const settled = this.#await(['screen'])
    this.#send({ type: 'refresh' })
    await settled
    return this.screen
  }

  // Sit on the socket instead of asking for the screen in a loop. Every change
  // an agent could care about already arrives here; without this the only way
  // to notice one is to poll, and a poll costs a whole screen every time.
  wait(
    { for: what = 'idle', timeoutMs = WAIT_MS }: { for?: WaitFor; timeoutMs?: number } = {},
  ): Promise<WaitResult> {
    const already = wakes(what, null, this)
    if (already) return Promise.resolve({ done: true, why: already, state: this.state })

    return new Promise<WaitResult>((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer)
        this.off('message', onMessage)
        this.off('closed', onClosed)
      }
      const timer = setTimeout(() => {
        stop()
        resolve({ done: false, why: null, state: this.state })
      }, timeoutMs)

      const onMessage = (msg: ServerMessage) => {
        const why = wakes(what, msg, this)
        if (!why) return
        stop()
        resolve({ done: true, why, state: this.state })
      }
      const onClosed = () => {
        stop()
        reject(new Error('the connection to the session closed while waiting'))
      }

      this.on('message', onMessage)
      this.on('closed', onClosed)
    })
  }

  async submit(text: string): Promise<ServerMessage> {
    const settled = this.#await(['accepted', 'pending', 'rejected', 'policy:held'])
    this.#send({ type: 'submit', text })
    return settled
  }

  // Nothing here reaches the session, so there is no gate to pass and nothing
  // to wait for.
  say(text: string): void {
    this.#send({ type: 'f2f', text })
  }

  async press(key: string): Promise<ServerMessage | { type: 'sent'; key: string }> {
    const settled = this.#await(['key:refused', 'state', 'screen'], 3000).catch(() => null)
    this.#send({ type: 'key', key })
    const answer = await settled
    return answer?.type === 'key:refused' ? answer : { type: 'sent', key }
  }

  close(): void {
    this.#ended = true
    this.#socket?.close()
  }
}

const TOOLS = [
  {
    name: 'c2c_screen',
    description:
      'The shared Claude Code session as it looks right now, as plain text: only what fits on screen. c2c_scrollback has what scrolled off it.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'c2c_scrollback',
    description:
      'The session screen plus what scrolled off the top of it, as plain text: tool output, diffs, errors. The terminal-side view; c2c_history is the readable conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: { type: 'number', description: `Lines above the screen to include (default ${SCROLLBACK_LINES}, max 10000)` },
      },
    },
  },
  {
    name: 'c2c_history',
    description:
      'The conversation in the shared session so far: who said what, and which tools were used. Covers turns from before you joined. Turns are numbered; pass before to page further back.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: `How many turns (default ${HISTORY_PAGE})` },
        before: { type: 'number', description: 'Only turns numbered below this one (default: up to the latest)' },
      },
    },
  },
  {
    name: 'c2c_status',
    description:
      'Whether you are connected, what you yourself may do (gallery or yolo), who else is in the circus, and what the session is doing.',
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
    name: 'c2c_say',
    description:
      'Say something to the other clowns in the f2f lane. This never reaches the shared session: it is the side channel humans use to talk about the session while it runs. Use it to flag something rather than typing into the session itself.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'What to say to the other clowns' } },
      required: ['text'],
    },
  },
  {
    name: 'c2c_f2f',
    description:
      'What the clowns have said to each other in the f2f lane. None of it was seen by the shared session, so it is the only place a "wait, do not run that" can be.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Most recent N lines (default 20)' } },
    },
  },
  {
    name: 'c2c_wait',
    description:
      'Block until the shared session does something, rather than asking for the screen in a loop. Comes back as soon as it happens, or says nothing did when the wait runs out.',
    inputSchema: {
      type: 'object',
      properties: {
        for: {
          type: 'string',
          enum: [...WAIT_FOR],
          description:
            'idle (default): the session is at a prompt and nothing of yours is still waiting to go in. dialog: the session is asking a question. reply: claude answered. lane: somebody said something in the f2f lane. anything: whichever of those comes first, which returns at once if the session is already free or already asking.',
        },
        seconds: {
          type: 'number',
          description: 'How long to wait before giving up (default 60, max 300)',
        },
      },
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
// What a tool call can carry. Parsed from the MCP client, so still checked
// before use.
interface ToolArgs {
  text?: string
  limit?: number
  before?: number
  lines?: number
  key?: string
  for?: string
  seconds?: number
}

export class McpServer {
  #link: BozoLink
  #buffer = ''

  out: NodeJS.WritableStream = process.stdout

  constructor(link: BozoLink) {
    this.#link = link
  }

  start(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): void {
    this.out = output
    input.setEncoding('utf8')
    input.on('data', (chunk: string) => {
      this.#buffer += chunk
      let index: number
      while ((index = this.#buffer.indexOf('\n')) !== -1) {
        const line = this.#buffer.slice(0, index).trim()
        this.#buffer = this.#buffer.slice(index + 1)
        if (line) this.#handle(line)
      }
    })
  }

  #write(message: unknown): void {
    this.out.write(JSON.stringify(message) + '\n')
  }

  #reply(id: unknown, result: unknown): void {
    if (id !== undefined && id !== null) this.#write({ jsonrpc: '2.0', id, result })
  }

  #fail(id: unknown, message: string): void {
    if (id !== undefined && id !== null) {
      this.#write({ jsonrpc: '2.0', id, error: { code: -32000, message } })
    }
  }

  async #handle(line: string): Promise<void> {
    let request: { id?: unknown; method?: string; params?: any }
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
      this.#fail(id, (err as Error).message)
    }
  }

  async #call({ name, arguments: args = {} }: { name: string; arguments?: ToolArgs }) {
    const text = await this.#run(name, args)
    return { content: [{ type: 'text', text }] }
  }

  async #run(name: string, args: ToolArgs): Promise<string> {
    const link = this.#link

    if (name === 'c2c_screen') {
      return (await link.refresh()) || '(the session screen is empty)'
    }

    if (name === 'c2c_scrollback') {
      const lines = Number(args.lines) > 0 ? Number(args.lines) : SCROLLBACK_LINES
      return (await link.scrollback(lines)) || '(the session screen is empty)'
    }

    if (name === 'c2c_history') return historyPage(link.history, args)

    if (name === 'c2c_status') {
      const waiting = link.outbox.length
      const yours = link.mode === 'gallery'
        ? ' (your messages wait for the host)'
        : ' (your messages go straight in)'
      const room = link.mode === link.roomMode ? '' : `, the room default is ${link.roomMode}`
      const circus = link.circus.length
        ? link.circus
            .map((bozo) => {
              const marks = [bozo.mode, bozo.whiteface ? 'whiteface' : '', bozo.idle ? 'idle' : '']
              return `  ${bozo.name} (${marks.filter(Boolean).join(', ')})`
            })
            .join('\n')
        : '  (nobody)'
      return [
        `connected: ${link.connected}`,
        `mode: ${link.mode}${yours}${room}`,
        `session: ${link.state}`,
        `yours held by the host: ${link.pending.length}`,
        `outbox: ${waiting ? `${waiting} message${waiting === 1 ? '' : 's'} waiting to go in` : 'empty'} (${link.outboxMode})`,
        `turns known: ${link.history.length}`,
        `in the circus:\n${circus}`,
      ].join('\n')
    }

    if (name === 'c2c_say') {
      if (!args.text) throw new Error('text is required')
      link.say(args.text)
      return 'Said to the other clowns. The session did not see it.'
    }

    if (name === 'c2c_f2f') {
      const limit = Number(args.limit) > 0 ? Number(args.limit) : 20
      const said = link.lane.slice(-limit)
      if (!said.length) return '(nobody has said anything in the f2f lane)'
      return said.map((msg) => `${msg.from}${msg.host ? ' (host)' : ''}: ${msg.text}`).join('\n')
    }

    if (name === 'c2c_send') {
      if (!args.text) throw new Error('text is required')
      const answer = await link.submit(args.text)
      if (answer.type === 'accepted') {
        return link.outboxMode === 'through'
          ? 'Sent. If the session is mid-turn, claude queues it there.'
          : 'In the outbox. It goes into the session as soon as it is free, and nothing goes in ahead of it.'
      }
      if (answer.type === 'pending') return `Queued as #${answer.id}. It reaches the session when the host releases it.`
      if (answer.type === 'rejected') return `Not sent: ${answer.reason}.`
      if (answer.type === 'policy:held') {
        return `Not delivered: the session is ${answer.state}.`
      }
      return 'Sent.'
    }

    if (name === 'c2c_wait') {
      const what = (WAIT_FOR as readonly string[]).includes(args.for ?? '')
        ? (args.for as WaitFor)
        : 'idle'
      const asked = Number(args.seconds)
      const timeoutMs = asked > 0 ? Math.min(asked * 1000, MAX_WAIT_MS) : WAIT_MS
      const result = await link.wait({ for: what, timeoutMs })

      if (!result.done) {
        const held = [
          link.pending.length ? `${link.pending.length} of yours waiting on the host` : '',
          link.outbox.length ? `${link.outbox.length} in the outbox` : '',
        ].filter(Boolean)
        const holding = held.length ? ` (${held.join(', ')})` : ''
        return `Nothing happened in ${Math.round(timeoutMs / 1000)}s. The session is ${result.state}${holding}.`
      }

      if (result.why === 'idle') return 'The session is free: at a prompt, with nothing of yours left to go in.'
      if (result.why === 'dialog') {
        return 'The session is asking a question. c2c_screen shows it, c2c_press answers it.'
      }
      if (result.why === 'reply') return 'Claude answered. c2c_history has the turn.'
      return 'Somebody said something in the f2f lane. c2c_f2f has it.'
    }

    if (name === 'c2c_press') {
      const answer = await link.press(args.key ?? '')
      if (answer.type === 'key:refused') {
        return `Refused: ${answer.reason === 'gallery' ? 'only the host can answer prompts in gallery mode' : answer.reason}.`
      }
      return `Pressed ${args.key}.`
    }

    throw new Error(`unknown tool: ${name}`)
  }
}
