#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { readFile } from 'node:fs/promises'
import { openSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

import * as tmux from './tmux.js'
import { Ringmaster } from './ringmaster.js'
import { GALLERY, YOLO } from './policy.js'
import { OUTBOX_MODES } from './outbox.js'
import { controlSocket, ensureStateDir, metaFile, stateDir, statusFile } from './paths.js'
import { version, versionReport } from './version.js'

const SELF = fileURLToPath(import.meta.url)

// The old mode names stay valid. "yolo" in particular said "this is dangerous"
// out loud, and anyone who learned it should not be told it is now invalid.
const MODE_ALIASES: Record<string, string> = { spectator: 'gallery', ring: 'yolo' }

const DEFAULTS = { session: 'c2c', port: 7331, host: '127.0.0.1' }

interface Options {
  session: string
  port: number
  host: string
  cwd: string
  attach: boolean
  mode?: string
  tunnel?: boolean
  bigtop?: string
  room?: string
  token?: string
  url?: string
  name?: string
  outbox?: string
}

function parseArgs(argv: string[]): { opts: Options; rest: string[]; passthrough: string[] | null } {
  const opts: Options = { ...DEFAULTS, cwd: process.cwd(), attach: true }
  const rest: string[] = []
  let passthrough: string[] | null = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      passthrough = argv.slice(i + 1)
      break
    }
    if (arg === '--session' || arg === '-s') opts.session = argv[++i]
    else if (arg === '--port' || arg === '-p') opts.port = Number(argv[++i])
    else if (arg === '--bind') opts.host = argv[++i]
    else if (arg === '--cwd') opts.cwd = resolve(argv[++i])
    else if (arg === '--no-attach') opts.attach = false
    else if (arg === '--yolo') opts.mode = YOLO
    else if (arg === '--mode') opts.mode = MODE_ALIASES[argv[++i]] ?? argv[i]
    else if (arg === '--tunnel') opts.tunnel = true
    // --broker kept as an alias: it was the flag before the bigtop rename, and
    // it is also what someone unfamiliar with the theme would reach for.
    else if (arg === '--bigtop' || arg === '--broker') opts.bigtop = argv[++i]
    else if (arg === '--room') opts.room = argv[++i]
    else if (arg === '--token') opts.token = argv[++i]
    else if (arg === '--url') opts.url = argv[++i]
    else if (arg === '--name') opts.name = argv[++i]
    else if (arg === '--outbox') opts.outbox = argv[++i]
    else rest.push(arg)
  }
  return { opts, rest, passthrough }
}

async function readMeta(session: string): Promise<SessionMeta | null> {
  try {
    return JSON.parse(await readFile(metaFile(session), 'utf8'))
  } catch {
    return null
  }
}

function control(session: string, message: ControlRequest): Promise<ControlReply> {
  return new Promise<ControlReply>((resolveReply, reject) => {
    const socket = connect(controlSocket(session))
    let buffer = ''
    socket.on('error', () => reject(new Error(`no ringmaster running for session "${session}"`)))
    socket.on('connect', () => socket.write(JSON.stringify(message) + '\n'))
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      socket.end()
      try {
        resolveReply(JSON.parse(buffer.slice(0, index)))
      } catch (err) {
        reject(err)
      }
    })
  })
}

async function cmdHost({ opts, passthrough }: { opts: Options; passthrough: string[] | null }): Promise<void> {
  if (await tmux.hasSession(opts.session)) {
    console.error(`session "${opts.session}" already exists - c2c attach, or c2c stop first`)
    process.exit(1)
  }

  // A bigtop refuses a short token, and the uplink would just retry forever
  // with nothing on screen explaining why.
  if (opts.token && opts.token.length < 8) {
    console.error('--token must be at least 8 characters: it is the only thing protecting the session')
    process.exit(1)
  }

  // The ringmaster would refuse it too, but only after the tmux session is up
  // and the host has timed out waiting for it.
  if (opts.mode && opts.mode !== GALLERY && opts.mode !== YOLO) {
    console.error(`--mode must be gallery or yolo, not "${opts.mode}"`)
    process.exit(1)
  }

  if (opts.outbox && !OUTBOX_MODES.includes(opts.outbox as OutboxMode)) {
    console.error(`--outbox must be drain or through, not "${opts.outbox}"`)
    process.exit(1)
  }

  // Running a second shared session hits this every time, since the port
  // defaults. Catching it here beats starting a tmux session, failing, killing
  // it again and pointing at a log.
  if (!(await portFree(opts.port, opts.host))) {
    console.error(`port ${opts.port} is already in use - pick another with -p`)
    process.exit(1)
  }

  const claudeArgs = (passthrough ?? []).map(shellQuote).join(' ')
  const command = claudeArgs ? `claude ${claudeArgs}` : 'claude'

  await tmux.newSession({ name: opts.session, cwd: opts.cwd, command })

  const dir = await ensureStateDir(opts.session)
  await tmux.configureHost(opts.session, {
    node: process.execPath,
    cli: SELF,
    status: statusFile(opts.session),
  })
  const token = opts.token || randomBytes(16).toString('hex')
  // Detached sessions have nobody at the prefix keys, so the host needs a way
  // to hold the gate from the browser instead.
  const whiteface = opts.attach ? '' : randomBytes(16).toString('hex')
  const log = openSync(join(dir, 'ringmaster.log'), 'a')

  const child = spawn(process.execPath, [SELF, '__ringmaster'], {
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      C2C_SESSION: opts.session,
      C2C_PORT: String(opts.port),
      C2C_BIND: opts.host,
      C2C_TOKEN: token,
      C2C_BIGTOP_URL: opts.bigtop ?? '',
      C2C_BIGTOP_ROOM: opts.room ?? opts.session,
      C2C_TUNNEL: opts.tunnel ? '1' : '',
      C2C_MODE: opts.mode ?? '',
      C2C_WHITEFACE: whiteface,
      C2C_OUTBOX: opts.outbox ?? '',
    },
  })
  child.unref()

  const meta = await waitForRingmaster(opts.session)
  if (!meta) {
    console.error(`ringmaster failed to start - see ${join(dir, 'ringmaster.log')}`)
    await tmux.killSession(opts.session)
    process.exit(1)
  }

  const ready = (opts.tunnel ? await waitForTunnel(opts.session) : meta) ?? meta

  console.log(`c2c-conv ${version()} - session "${opts.session}" is live`)
  console.log('')
  if (opts.tunnel && !ready.tunnel) {
    console.log('  note: cloudflared has not reported a URL yet.')
    console.log('        run c2c invite in a moment to get the link.')
    console.log('')
  }
  printInvite(ready, opts)
  console.log(
    opts.mode === YOLO
      ? '  mode        YOLO - bozo messages go straight in, with your permissions'
      : '  mode        gallery (bozos need your approval to send)'
  )
  console.log('')
  if (meta.whitefaceUrl) {
    console.log('  your own link, which makes you the whiteface (keep it to yourself):')
    console.log(`    ${meta.whitefaceUrl}`)
    console.log('    it gives you approve, deny and the mode switch in the browser')
    console.log('')
  }

  console.log(
    opts.outbox === 'through'
      ? '  outbox      through - messages are typed into a working session, and claude queues them'
      : '  outbox      drain - one message at a time, each waits for the last turn to finish'
  )
  console.log('')

  console.log('  in the session, without leaving it:')
  console.log('    prefix + a  release the next waiting message')
  console.log('    prefix + d  drop it')
  console.log('    prefix + y  toggle gallery / yolo')
  console.log('  the status bar shows mode, bozos, what is waiting and what is going in.')
  console.log('')
  console.log('  the clowns can talk to each other without claude hearing it:')
  console.log(`    c2c say "..."   post to the f2f lane; theirs arrive as tmux messages`)
  console.log('')

  if (opts.mode === YOLO && !opts.attach) {
    console.log('warning: headless and in yolo. Nobody is watching the pane, and any bozo')
    console.log('         with the link runs commands as you. Keep the link tight.')
    console.log('')
  }

  if (!isLoopback(opts.host)) {
    console.log(`warning: bound to ${opts.host}, so anyone who can reach this port and`)
    console.log('         guess the token can watch. Prefer ssh forwarding or --bigtop.')
    console.log('')
  }

  const state = await waitForReady(opts.session)
  if (state === 'dialog') {
    console.log('note: the session is waiting on a dialog (workspace trust?).')
    console.log('      answer it in the pane - bozo messages are held until it clears.')
    console.log('')
  }

  if (opts.attach) {
    await attach(opts.session)
  } else {
    console.log(`attach with: c2c attach -s ${opts.session}`)
  }
}

function portFree(port: number, host: string): Promise<boolean> {
  return new Promise<boolean>((done) => {
    const probe = createServer()
    probe.once('error', () => done(false))
    probe.once('listening', () => probe.close(() => done(true)))
    probe.listen(port, host)
  })
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

function tailscaleAddress(): string | null {
  try {
    const out = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim().split('\n')[0] || null
  } catch {
    return null
  }
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((nic): nic is NetworkInterfaceInfo => nic?.family === 'IPv4' && !nic.internal)
    .map((nic) => nic.address)
}

// Only advertise addresses that are actually listening. A socket bound to one
// address does not answer on the others, so listing every interface hands the
// bozo URLs that refuse the connection.
function reachableAddresses(host: string): string[] {
  if (host === '0.0.0.0' || host === '::') return ['127.0.0.1', ...lanAddresses()]
  return [host]
}

// Takes only what it prints, so both the metadata file and a live status reply
// can be handed to it.
type InviteInfo = Pick<SessionMeta, 'port' | 'token' | 'tunnel'> & { bigtop: { url: string } | null }

function printInvite(meta: InviteInfo, opts?: Options): void {
  const host = opts?.host ?? '127.0.0.1'
  const reachable = reachableAddresses(host)
  const tailnet = tailscaleAddress()

  console.log('  how your bozo gets in:')

  if (meta.tunnel) {
    console.log(`    tunnel    ${meta.tunnel}`)
    console.log('              a public cloudflared URL: anyone with the link can reach it')
  }

  if (meta.bigtop?.url) {
    console.log(`    bigtop    ${meta.bigtop.url}`)
    console.log('              works through NAT on both sides, nothing to forward')
  }

  // The forward has to target an address the ringmaster is actually bound to.
  const forwardTo = reachable.includes('127.0.0.1') ? '127.0.0.1' : reachable[0]
  console.log(`    ssh       ssh -N -L ${meta.port}:${forwardTo}:${meta.port} ${process.env.USER}@${hostname()}`)
  console.log(`              then open http://127.0.0.1:${meta.port}/?t=${meta.token}`)

  for (const address of reachable) {
    if (address === '127.0.0.1') continue
    const label = address === tailnet ? 'tailscale' : 'lan      '
    console.log(`    ${label} http://${address}:${meta.port}/?t=${meta.token}`)
  }

  if (isLoopback(host) && tailnet) {
    console.log(`    tailscale rebind with --bind ${tailnet} to serve the tailnet directly`)
  }
  console.log('')
}

async function cmdInvite({ opts }: { opts: Options }): Promise<void> {
  const meta = await readMeta(opts.session)
  if (!meta) {
    console.error(`no ringmaster running for session "${opts.session}"`)
    process.exit(1)
  }
  const status = await control(opts.session, { cmd: 'status' })
  printInvite({ ...meta, bigtop: 'bigtop' in status ? status.bigtop : null }, opts)
}

// Joins as a bozo over the ordinary bozo protocol, so an agent is gated exactly
// like a person: the ringmaster does not know or care that this one is a program.
async function cmdZavatta({ opts }: { opts: Options }): Promise<void> {
  const { BozoLink, McpServer } = await import('./zavatta.js')

  let url = opts.url
  if (!url) {
    const meta = await readMeta(opts.session)
    if (!meta) {
      console.error(`no ringmaster running for session "${opts.session}" - start one with c2c host`)
      process.exit(1)
    }
    url = `ws://127.0.0.1:${meta.port}/?t=${meta.token}`
  }

  const link = new BozoLink({ url, name: opts.name ?? 'zavatta' })
  // stdout is the MCP transport, so anything chatty has to go to stderr.
  link.on('closed', () => {
    console.error('[c2c] the session ended')
    process.exit(0)
  })

  try {
    await link.connect()
  } catch (err) {
    console.error(`[c2c] could not join the session: ${(err as Error).message}`)
    process.exit(1)
  }
  console.error(`[c2c] hoinked in as ${opts.name ?? 'zavatta'}, mode is ${link.mode}`)

  new McpServer(link).start()
}

async function cmdBigtop({ opts }: { opts: Options }): Promise<void> {
  const { Bigtop } = await import('../bigtop/server.js')
  const bigtop = new Bigtop()
  const address = await bigtop.listen(opts.port === DEFAULTS.port ? 8080 : opts.port, opts.host)
  console.log(`c2c bigtop listening on ${address.address}:${address.port}`)
  await new Promise(() => {})
}

async function waitForReady(session: string, tries = 40): Promise<PaneState> {
  let state: PaneState = 'unknown'
  for (let i = 0; i < tries; i++) {
    state = await tmux.paneState(session)
    if (state === 'prompt' || state === 'dialog' || state === 'dead') return state
    await new Promise((r) => setTimeout(r, 250))
  }
  return state
}

// cloudflared answers in its own time, so this is waited for separately rather
// than holding up a session that is already usable.
async function waitForTunnel(session: string, tries = 60): Promise<SessionMeta | null> {
  let meta = await readMeta(session)
  for (let i = 0; i < tries; i++) {
    if (meta?.tunnel) return meta
    await new Promise((r) => setTimeout(r, 500))
    meta = (await readMeta(session)) ?? meta
  }
  return meta
}

async function waitForRingmaster(session: string, tries = 60): Promise<SessionMeta | null> {
  for (let i = 0; i < tries; i++) {
    const meta = await readMeta(session)
    if (meta) return meta
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

function shellQuote(value: string): string {
  return /^[\w./:=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

async function cmdRingmaster(): Promise<void> {
  const session = process.env.C2C_SESSION ?? 'c2c'
  const bigtopUrl = process.env.C2C_BIGTOP_URL
  const ringmaster = new Ringmaster({
    session,
    port: Number(process.env.C2C_PORT),
    host: process.env.C2C_BIND,
    token: process.env.C2C_TOKEN,
    bigtop: bigtopUrl ? { url: bigtopUrl, room: process.env.C2C_BIGTOP_ROOM ?? session } : null,
    tunnel: process.env.C2C_TUNNEL === '1',
    mode: process.env.C2C_MODE,
    whiteface: process.env.C2C_WHITEFACE,
    outboxMode: (process.env.C2C_OUTBOX || undefined) as OutboxMode | undefined,
  })
  await ringmaster.start()
  console.log(`[ringmaster] listening on ${ringmaster.url}`)
  if (ringmaster.bigtop) console.log(`[ringmaster] bigtop uplink ${ringmaster.bigtop.bozoUrl}`)

  const shutdown = async () => {
    await ringmaster.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  setInterval(async () => {
    if (!(await tmux.hasSession(session))) {
      console.log('[ringmaster] tmux session gone, shutting down')
      // Otherwise bozos just see the socket drop and reconnect forever.
      ringmaster.announceEnd('the session ended')
      await new Promise((r) => setTimeout(r, 150))
      await shutdown()
    }
  }, 2000)
}

function attach(session: string): Promise<void> {
  return new Promise<void>((resolveDone) => {
    const child = spawn('tmux', tmux.attachArgs(session), { stdio: 'inherit' })
    child.on('exit', () => resolveDone())
  })
}

const CTL_USAGE =
  'usage: c2c ctl <status|list|mode gallery|mode yolo|approve ID|deny ID|approve-all|deny-all' +
  '|outbox|cancel ID|cancel-all|bump ID|say TEXT>'

async function cmdCtl({ opts, rest }: { opts: Options; rest: string[] }): Promise<void> {
  const [sub, ...args] = rest
  const message = buildControlMessage(sub, args)
  if (!message) {
    console.error(CTL_USAGE)
    process.exit(1)
  }
  const reply = await control(opts.session, message)
  if (sub === 'status') printStatus(reply)
  else console.log(JSON.stringify(reply, null, 2))
  if (reply.ok === false) process.exit(1)
}

function buildControlMessage(sub: string | undefined, args: string[]): ControlRequest | null {
  switch (sub) {
    case 'status':
    case 'list':
    case 'approve-all':
    case 'deny-all':
    case 'approve-next':
    case 'deny-next':
    case 'outbox':
    case 'cancel-all':
      return { cmd: sub }
    case 'mode':
      return { cmd: 'mode', mode: MODE_ALIASES[args[0]] ?? args[0] }
    case 'say':
      return { cmd: 'say', text: args.join(' ') }
    case 'approve':
    case 'deny':
    case 'cancel':
    case 'bump':
      return { cmd: sub, id: args[0] }
    default:
      return null
  }
}

function printStatus(reply: ControlReply): void {
  if (!reply.ok) {
    console.error(reply.error)
    return
  }
  if (!('session' in reply)) return
  console.log(`session  ${reply.session}`)
  console.log(`mode     ${reply.mode}`)
  console.log(`url      ${reply.url}`)
  if (reply.tunnel) {
    console.log(`tunnel   ${reply.tunnel}`)
  }
  if (reply.bigtop) {
    console.log(`bigtop   ${reply.bigtop.connected ? 'connected' : 'disconnected'}  ${reply.bigtop.url}`)
  }
  console.log(
    `bozos   ${reply.bozos.length ? reply.bozos.map((g) => `${g.name} (${g.via})`).join(', ') : 'none'}`
  )
  if (reply.pending.length) {
    console.log('pending:')
    for (const entry of reply.pending) {
      console.log(`  #${entry.id}  ${entry.bozo}: ${entry.text}`)
    }
  } else {
    console.log('pending  none')
  }
  if (reply.outbox.length) {
    console.log(`outbox   ${reply.outboxMode}`)
    for (const entry of reply.outbox) {
      const why = entry.state === 'sending' ? 'going in' : entry.reason ? `waiting: ${entry.reason}` : 'waiting'
      console.log(`  o${entry.id}  ${entry.bozo}: ${entry.text}  (${why})`)
    }
  } else {
    console.log(`outbox   empty (${reply.outboxMode})`)
  }
}

// The host's way into the f2f lane. They have no browser panel to type in, and
// a bozo's line arrives in the pane as a tmux message, so this is the reply.
async function cmdSay({ opts, rest }: { opts: Options; rest: string[] }): Promise<void> {
  const text = rest.join(' ').trim()
  if (!text) {
    console.error('usage: c2c say <text>')
    process.exit(1)
  }
  const reply = await control(opts.session, { cmd: 'say', text })
  if (!reply.ok) {
    console.error(reply.error)
    process.exit(1)
  }
  console.log('said')
}

async function cmdStop({ opts }: { opts: Options }): Promise<void> {
  try {
    await control(opts.session, { cmd: 'stop' })
  } catch {}
  await tmux.killSession(opts.session)
  console.log(`stopped "${opts.session}"`)
}

function usage(): void {
  console.log(`c2c-conv ${version()} - share one Claude Code session with a second person

usage:
  c2c host [-s NAME] [-p PORT] [--bind ADDR] [--cwd DIR] [--no-attach] [--tunnel]
           [--yolo | --mode gallery|yolo] [--outbox drain|through]
           [--bigtop wss://HOST] [--room NAME] [--token SECRET] [-- <claude args>]
  c2c attach [-s NAME]
  c2c invite [-s NAME]
  c2c say <text>   post a line to the f2f lane, which claude never sees
  c2c ctl <status|list|mode gallery|mode yolo|approve ID|deny ID|approve-all|deny-all
           |outbox|cancel ID|cancel-all|bump ID|say TEXT>
  c2c stop [-s NAME]
  c2c version | --version
  c2c bigtop [-p PORT] [--bind ADDR]
  c2c zavatta [-s NAME] [--url URL] [--name WHO]  join a session as an AI bozo (MCP)

the outbox:
  drain (default)  one message at a time, each waiting for the last turn to end
  through          type into a working session and let claude queue it itself

transports:
  loopback + ssh   default, nothing to deploy
  --bind ADDR      serve a LAN or tailnet address directly
  --bigtop URL     dial out to a bigtop, works through NAT both ends
  --tunnel         public URL via cloudflared, nothing to deploy or forward

state lives in ${stateDir('<session>')}`)
}

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(versionReport())
  process.exit(0)
}

const { opts, rest, passthrough } = parseArgs(process.argv.slice(2))
const command = rest[0] ?? (process.argv[2] === '__ringmaster' ? '__ringmaster' : 'help')

try {
  switch (command) {
    case 'host':
      await cmdHost({ opts, passthrough })
      break
    case '__ringmaster':
      await cmdRingmaster()
      break
    case 'attach':
      await attach(opts.session)
      break
    case 'ctl':
      await cmdCtl({ opts, rest: rest.slice(1) })
      break
    case 'invite':
      await cmdInvite({ opts })
      break
    case 'say':
      await cmdSay({ opts, rest: rest.slice(1) })
      break
    // mcp stays as an alias: it is the term anyone will actually search for.
    case 'zavatta':
    case 'mcp':
      await cmdZavatta({ opts })
      break
    case 'bigtop':
    case 'broker':
      await cmdBigtop({ opts })
      break
    case 'stop':
      await cmdStop({ opts })
      break
    case 'version':
      console.log(versionReport())
      break
    default:
      usage()
  }
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}
