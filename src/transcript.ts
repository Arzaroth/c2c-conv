import { EventEmitter } from 'node:events'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import * as tmux from './tmux.js'
import { PaneStream } from './panestream.js'

interface SessionDescriptor {
  sessionId: string
  cwd: string
}

// One line of a Claude Code transcript. Everything is optional because these
// are somebody else's records: the file carries bookkeeping types this does not
// know about, and a half-written line is a normal thing to read.
interface TranscriptRecord {
  type?: string
  isMeta?: boolean
  isSidechain?: boolean
  timestamp?: string
  message?: { content?: unknown }
}

const CLAUDE_HOME = join(homedir(), '.claude')

// Claude Code writes a descriptor per live session keyed by pid. That is how the
// session id for *our* pane is found rather than guessing at the newest file in
// the project directory, which would pick up any other session in the same cwd.
async function descriptorFor(pid: number): Promise<SessionDescriptor | null> {
  try {
    const raw = await readFile(join(CLAUDE_HOME, 'sessions', `${pid}.json`), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function childPids(pid: number): Promise<number[]> {
  try {
    const raw = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')
    return raw.trim().split(/\s+/).filter(Boolean).map(Number)
  } catch {
    return []
  }
}

// tmux may run the pane command through a shell, so claude can be a child of
// the pane process rather than the pane process itself.
async function locate(session: string): Promise<SessionDescriptor | null> {
  const panePid = await tmux.panePid(session)
  if (!panePid) return null

  const candidates = [panePid, ...(await childPids(panePid))]
  for (const pid of candidates) {
    const descriptor = await descriptorFor(pid)
    if (descriptor?.sessionId && descriptor?.cwd) return descriptor
  }
  return null
}

export function transcriptPath({ cwd, sessionId }: SessionDescriptor): string {
  return join(CLAUDE_HOME, 'projects', cwd.replace(/\//g, '-'), `${sessionId}.jsonl`)
}

export function toEntry(record: TranscriptRecord | null | undefined): TranscriptEntry | null {
  if (record?.isMeta || record?.isSidechain) return null

  if (record?.type === 'user') {
    const text = plainText(record.message?.content)
    return text ? { role: 'user', text, at: record.timestamp } : null
  }

  if (record?.type === 'assistant') {
    const content = record.message?.content
    if (!Array.isArray(content)) return null

    const texts: string[] = []
    const tools: string[] = []
    for (const block of content) {
      if (block.type === 'text' && block.text?.trim()) texts.push(block.text.trim())
      if (block.type === 'tool_use') tools.push(block.name)
    }
    if (!texts.length && !tools.length) return null
    return { role: 'assistant', text: texts.join('\n\n'), tools, at: record.timestamp }
  }

  return null
}

// Tool results carry whole file contents and command output. Bozos can see all
// of it in the mirror anyway, so this is about keeping the history readable, not
// about hiding anything.
function plainText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && block.text?.trim())
    .map((block) => block.text.trim())
    .join('\n\n')
}

export class TranscriptStream extends EventEmitter {
  #session: string
  #stream: PaneStream | null = null
  #buffer = ''
  #timer: NodeJS.Timeout | undefined
  #stopped = false

  constructor(session: string) {
    super()
    this.#session = session
  }

  // Nothing here is a public API, so every failure is non-fatal: the mirror is
  // the product, this is enrichment on top of it.
  async start(): Promise<void> {
    const descriptor = await locate(this.#session)
    if (!descriptor) {
      this.#retry()
      return
    }

    const path = transcriptPath(descriptor)
    try {
      await readdir(join(path, '..'))
      this.#stream = new PaneStream(path)
      this.#stream.on('data', (chunk) => this.#feed(chunk))
      this.#stream.on('error', () => {})
      await this.#stream.start()
      this.emit('located', { path, sessionId: descriptor.sessionId })
    } catch {
      this.#retry()
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true
    clearTimeout(this.#timer)
    await this.#stream?.stop()
    this.#stream = null
  }

  #retry(): void {
    if (this.#stopped) return
    this.#timer = setTimeout(() => this.start(), 2000)
  }

  #feed(chunk: Buffer): void {
    this.#buffer += chunk.toString('utf8')
    let index: number
    while ((index = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, index)
      this.#buffer = this.#buffer.slice(index + 1)
      if (!line.trim()) continue
      try {
        const entry = toEntry(JSON.parse(line))
        if (entry) this.emit('entry', entry)
      } catch {}
    }
  }
}
