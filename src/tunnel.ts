import { EventEmitter } from 'node:events'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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

// pid reuse is real after a crash or a reboot, so a recorded pid is only
// adopted if it is still a cloudflared forwarding to this port.
export function isTunnelFor(pid: number, port: number): boolean {
  try {
    process.kill(pid, 0)
    const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 2000 })
    return args.includes('tunnel') && args.includes(`127.0.0.1:${port}`)
  } catch {
    return false
  }
}

// cloudflared is detached and logs to a file, so a ringmaster restarting
// in place can hand the running tunnel, and the URL bozos already have, to
// the next one. A quick tunnel's URL cannot be asked for twice.
export class Tunnel extends EventEmitter {
  #port: number
  #bin: string
  #log: string
  #child: ChildProcess | null = null
  #watch: NodeJS.Timeout | undefined
  #stopped = false

  url: string | null = null
  pid: number | null = null

  constructor({ port, bin, log }: { port: number; bin?: string; log?: string }) {
    super()
    this.#port = port
    this.#bin = bin ?? resolveCloudflared()
    this.#log = log ?? join(tmpdir(), `c2c-cloudflared-${process.pid}-${port}.log`)
  }

  start(timeoutMs = 30000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let child: ChildProcess
      let fd: number
      try {
        fd = openSync(this.#log, 'w', 0o600)
        child = spawn(this.#bin, [
          'tunnel', '--no-autoupdate',
          '--url', `http://127.0.0.1:${this.#port}`,
        ], { detached: true, stdio: ['ignore', fd, fd] })
      } catch (err) {
        reject(err)
        return
      }
      closeSync(fd)
      child.unref()
      this.#child = child
      this.pid = child.pid ?? null

      let offset = 0
      let partial = ''
      const scan = () => {
        if (this.url) return
        let chunk: Buffer
        try {
          chunk = readFileSync(this.#log).subarray(offset)
        } catch {
          return
        }
        offset += chunk.length
        const lines = (partial + chunk.toString('utf8')).split('\n')
        partial = lines.pop() ?? ''
        for (const line of lines) {
          const found = parseTunnelUrl(line)
          if (!found) continue
          this.url = found
          done()
          this.emit('url', found)
          resolve(found)
          return
        }
      }
      const poll = setInterval(scan, 200)
      const timer = setTimeout(() => {
        done()
        reject(new Error('cloudflared did not announce a URL in time'))
      }, timeoutMs)
      const done = () => {
        clearInterval(poll)
        clearTimeout(timer)
      }

      child.on('error', (err: NodeJS.ErrnoException) => {
        done()
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
        this.pid = null
        if (this.#stopped) return
        scan()
        done()
        this.emit('closed', code)
        if (!this.url) reject(new Error(`cloudflared exited with code ${code}`))
      })
    })
  }

  // A tunnel some earlier ringmaster started. It is not a child of this
  // process, so its exit is noticed by asking rather than told.
  adopt({ pid, url }: { pid: number; url: string }): boolean {
    if (!isTunnelFor(pid, this.#port)) return false
    this.pid = pid
    this.url = url
    this.#watch = setInterval(() => {
      if (isTunnelFor(pid, this.#port)) return
      clearInterval(this.#watch)
      this.pid = null
      this.url = null
      if (!this.#stopped) this.emit('closed', null)
    }, 2000)
    this.#watch.unref()
    return true
  }

  // Let go without killing it: the next ringmaster adopts it.
  release(): void {
    this.#stopped = true
    clearInterval(this.#watch)
    this.#child?.removeAllListeners('exit')
    this.#child = null
  }

  stop(): void {
    this.#stopped = true
    clearInterval(this.#watch)
    if (this.pid) {
      try {
        process.kill(this.pid)
      } catch {}
    }
    this.#child = null
    this.pid = null
  }
}
