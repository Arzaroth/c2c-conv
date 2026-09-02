import { EventEmitter } from 'node:events'
import { open, type FileHandle } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'

const POLL_MS = 40

export class PaneStream extends EventEmitter {
  #file: string
  #handle: FileHandle | null = null
  #position = 0
  #timer: NodeJS.Timeout | undefined
  #watcher: FSWatcher | null = null
  #reading = false
  #stopped = false

  constructor(file: string) {
    super()
    this.#file = file
  }

  async start(): Promise<void> {
    this.#handle = await open(this.#file, 'r')
    this.#timer = setInterval(() => this.#drain(), POLL_MS)
    try {
      this.#watcher = watch(this.#file, () => this.#drain())
    } catch {}
    await this.#drain()
  }

  async stop(): Promise<void> {
    this.#stopped = true
    clearInterval(this.#timer)
    this.#watcher?.close()
    await this.#handle?.close()
    this.#handle = null
  }

  get bytesRead(): number {
    return this.#position
  }

  rewind(): void {
    this.#position = 0
  }

  async #drain(): Promise<void> {
    if (this.#reading || this.#stopped || !this.#handle) return
    this.#reading = true
    try {
      const buf = Buffer.allocUnsafe(64 * 1024)
      for (;;) {
        const { bytesRead } = await this.#handle.read(buf, 0, buf.length, this.#position)
        if (bytesRead <= 0) break
        this.#position += bytesRead
        this.emit('data', Buffer.from(buf.subarray(0, bytesRead)))
        if (bytesRead < buf.length) break
      }
    } catch (err) {
      if (!this.#stopped) this.emit('error', err)
    } finally {
      this.#reading = false
    }
  }
}
