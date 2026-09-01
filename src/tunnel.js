import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'

// cloudflared announces a quick tunnel in a banner on stderr:
//
//   INF |  Your quick Tunnel has been created! Visit it at ...  |
//   INF |  https://some-random-words.trycloudflare.com          |
//
// Named tunnels print their own hostname instead, so a generic https URL is
// accepted as a fallback rather than only matching trycloudflare.com.
const QUICK = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i
const ANY_HTTPS = /https:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?/i

export function parseTunnelUrl(line) {
  const quick = line.match(QUICK)
  if (quick) return quick[0]
  // Only trust a bare URL from the announcement banner, or ordinary log lines
  // mentioning cloudflare's own endpoints would be mistaken for the tunnel.
  if (!/quick tunnel|visit it at/i.test(line)) return null
  return line.match(ANY_HTTPS)?.[0] ?? null
}

export class Tunnel extends EventEmitter {
  #port
  #bin
  #child = null
  #stopped = false

  url = null

  constructor({ port, bin = process.env.C2C_CLOUDFLARED || 'cloudflared' }) {
    super()
    this.#port = port
    this.#bin = bin
  }

  start(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      let child
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

      const onLine = (line) => {
        if (this.url) return
        const found = parseTunnelUrl(line)
        if (!found) return
        this.url = found
        clearTimeout(timer)
        this.emit('url', found)
        resolve(found)
      }

      for (const stream of [child.stdout, child.stderr]) {
        let buffer = ''
        stream.setEncoding('utf8')
        stream.on('data', (chunk) => {
          buffer += chunk
          let index
          while ((index = buffer.indexOf('\n')) !== -1) {
            onLine(buffer.slice(0, index))
            buffer = buffer.slice(index + 1)
          }
        })
      }

      child.on('error', (err) => {
        clearTimeout(timer)
        // The npm packages that "provide" cloudflared only download this same
        // Go binary, and Cloudflare publishes no checksums to verify it against,
        // so a signed distro package is the better way to get it.
        reject(
          err.code === 'ENOENT'
            ? new Error(
                'cloudflared is not on PATH. Install it with your package manager ' +
                '(pacman -S cloudflared, brew install cloudflared, or the .deb/.rpm ' +
                'from github.com/cloudflare/cloudflared/releases), then retry.'
              )
            : err
        )
      })

      child.on('exit', (code) => {
        this.#child = null
        if (!this.#stopped) {
          clearTimeout(timer)
          this.emit('closed', code)
          if (!this.url) reject(new Error(`cloudflared exited with code ${code}`))
        }
      })
    })
  }

  stop() {
    this.#stopped = true
    this.#child?.kill()
    this.#child = null
  }
}
