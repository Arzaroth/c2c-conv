import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// cloudflared announces a quick tunnel in a banner on stderr:
//
//   INF |  Your quick Tunnel has been created! Visit it at ...  |
//   INF |  https://some-random-words.trycloudflare.com          |
//
// Named tunnels print their own hostname instead, so a generic https URL is
// accepted as a fallback rather than only matching trycloudflare.com.
const QUICK = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i
const ANY_HTTPS = /https:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?/i

export function parseTunnelUrl(line: string): string | null {
  const quick = line.match(QUICK)
  if (quick) return quick[0]
  // Only trust a bare URL from the announcement banner, or ordinary log lines
  // mentioning cloudflare's own endpoints would be mistaken for the tunnel.
  if (!/quick tunnel|visit it at/i.test(line)) return null
  return line.match(ANY_HTTPS)?.[0] ?? null
}

// The npm `cloudflared` package is a wrapper: its installer downloads the same
// Go binary from GitHub releases and chmods it 755, with no checksum and no
// signature. So c2c does not depend on it - but if you have installed it, its
// binary is perfectly good and there is no reason to make you install a second
// copy. Anything on PATH wins, since that came from a signed package.
export function resolveCloudflared(cwd: string = process.cwd()): string {
  if (process.env.C2C_CLOUDFLARED) return process.env.C2C_CLOUDFLARED

  const candidates = [
    join(cwd, 'node_modules', '.bin', 'cloudflared'),
    join(homedir(), '.cloudflared', 'bin', 'cloudflared'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'cloudflared'
}

export class Tunnel extends EventEmitter {
  #port: number
  #bin: string
  #child: ChildProcess | null = null
  #stopped = false

  url: string | null = null

  constructor({ port, bin }: { port: number; bin?: string }) {
    super()
    this.#port = port
    this.#bin = bin ?? resolveCloudflared()
  }

  start(timeoutMs = 30000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(this.#bin, [
          'tunnel', '--no-autoupdate',
          '--url', `http://127.0.0.1:${this.#port}`,
        ], { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        reject(err)
        return
      }
      this.#child = child

      const timer = setTimeout(() => {
        reject(new Error('cloudflared did not announce a URL in time'))
      }, timeoutMs)

      const onLine = (line: string) => {
        if (this.url) return
        const found = parseTunnelUrl(line)
        if (!found) return
        this.url = found
        clearTimeout(timer)
        this.emit('url', found)
        resolve(found)
      }

      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue
        let buffer = ''
        stream.setEncoding('utf8')
        stream.on('data', (chunk: string) => {
          buffer += chunk
          let index: number
          while ((index = buffer.indexOf('\n')) !== -1) {
            onLine(buffer.slice(0, index))
            buffer = buffer.slice(index + 1)
          }
        })
      }

      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        // The npm packages that "provide" cloudflared only download this same
        // Go binary, and Cloudflare publishes no checksums to verify it against,
        // so a signed distro package is the better way to get it.
        reject(
          err.code === 'ENOENT'
            ? new Error(
                'cloudflared not found. Install it with your package manager ' +
                '(pacman -S cloudflared, brew install cloudflared), or run ' +
                '"npm i cloudflared" here and c2c will use that copy. Note the npm ' +
                'one downloads the binary unverified; a signed package is safer.'
              )
            : err
        )
      })

      child.on('exit', (code: number | null) => {
        this.#child = null
        if (!this.#stopped) {
          clearTimeout(timer)
          this.emit('closed', code)
          if (!this.url) reject(new Error(`cloudflared exited with code ${code}`))
        }
      })
    })
  }

  stop(): void {
    this.#stopped = true
    this.#child?.kill()
    this.#child = null
  }
}
