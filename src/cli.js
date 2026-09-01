#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { hostname, networkInterfaces } from 'node:os'
import { readFile } from 'node:fs/promises'
import { openSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

import * as tmux from './tmux.js'
import { Relay } from './relay.js'
import { controlSocket, ensureStateDir, metaFile, stateDir, statusFile } from './paths.js'

const SELF = fileURLToPath(import.meta.url)

const DEFAULTS = { session: 'c2c', port: 7331, host: '127.0.0.1' }

function parseArgs(argv) {
  const opts = { ...DEFAULTS, cwd: process.cwd(), attach: true }
  const rest = []
  let passthrough = null

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
    else if (arg === '--broker') opts.broker = argv[++i]
    else if (arg === '--room') opts.room = argv[++i]
    else if (arg === '--token') opts.token = argv[++i]
    else rest.push(arg)
  }
  return { opts, rest, passthrough }
}

async function readMeta(session) {
  try {
    return JSON.parse(await readFile(metaFile(session), 'utf8'))
  } catch {
    return null
  }
}

function control(session, message) {
  return new Promise((resolveReply, reject) => {
    const socket = connect(controlSocket(session))
    let buffer = ''
    socket.on('error', () => reject(new Error(`no relay running for session "${session}"`)))
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

async function cmdHost({ opts, passthrough }) {
  if (await tmux.hasSession(opts.session)) {
    console.error(`session "${opts.session}" already exists - c2c attach, or c2c stop first`)
    process.exit(1)
  }

  // A broker refuses a short token, and the uplink would just retry forever
  // with nothing on screen explaining why.
  if (opts.token && opts.token.length < 8) {
    console.error('--token must be at least 8 characters: it is the only thing protecting the session')
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
  const log = openSync(join(dir, 'relay.log'), 'a')

  const child = spawn(process.execPath, [SELF, '__relay'], {
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      C2C_SESSION: opts.session,
      C2C_PORT: String(opts.port),
      C2C_BIND: opts.host,
      C2C_TOKEN: token,
      C2C_BROKER_URL: opts.broker ?? '',
      C2C_BROKER_ROOM: opts.room ?? opts.session,
    },
  })
  child.unref()

  const meta = await waitForRelay(opts.session)
  if (!meta) {
    console.error(`relay failed to start - see ${join(dir, 'relay.log')}`)
    await tmux.killSession(opts.session)
    process.exit(1)
  }

  console.log(`c2c-conv session "${opts.session}" is live`)
  console.log('')
  printInvite(meta, opts)
  console.log(`  mode        spectator (guests need your approval to send)`)
  console.log('')
  console.log('  in the session, without leaving it:')
  console.log('    prefix + a  release the next waiting message')
  console.log('    prefix + d  drop it')
  console.log('    prefix + y  toggle spectator / yolo')
  console.log('  the status bar shows mode, guests, and what is waiting.')
  console.log('')

  if (!isLoopback(opts.host)) {
    console.log(`warning: bound to ${opts.host}, so anyone who can reach this port and`)
    console.log('         guess the token can watch. Prefer ssh forwarding or --broker.')
    console.log('')
  }

  const state = await waitForReady(opts.session)
  if (state === 'dialog') {
    console.log('note: the session is waiting on a dialog (workspace trust?).')
    console.log('      answer it in the pane - guest messages are held until it clears.')
    console.log('')
  }

  if (opts.attach) {
    await attach(opts.session)
  } else {
    console.log(`attach with: c2c attach -s ${opts.session}`)
  }
}

function portFree(port, host) {
  return new Promise((done) => {
    const probe = createServer()
    probe.once('error', () => done(false))
    probe.once('listening', () => probe.close(() => done(true)))
    probe.listen(port, host)
  })
}

function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

function tailscaleAddress() {
  try {
    const out = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim().split('\n')[0] || null
  } catch {
    return null
  }
}

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((nic) => nic && nic.family === 'IPv4' && !nic.internal)
    .map((nic) => nic.address)
}

// Only advertise addresses that are actually listening. A socket bound to one
// address does not answer on the others, so listing every interface hands the
// guest URLs that refuse the connection.
function reachableAddresses(host) {
  if (host === '0.0.0.0' || host === '::') return ['127.0.0.1', ...lanAddresses()]
  return [host]
}

function printInvite(meta, opts) {
  const host = opts?.host ?? '127.0.0.1'
  const reachable = reachableAddresses(host)
  const tailnet = tailscaleAddress()

  console.log('  how your guest gets in:')

  if (meta.broker?.url) {
    console.log(`    broker    ${meta.broker.url}`)
    console.log('              works through NAT on both sides, nothing to forward')
  }

  // The forward has to target an address the relay is actually bound to.
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

async function cmdInvite({ opts }) {
  const meta = await readMeta(opts.session)
  if (!meta) {
    console.error(`no relay running for session "${opts.session}"`)
    process.exit(1)
  }
  const status = await control(opts.session, { cmd: 'status' })
  printInvite({ ...meta, broker: status.broker }, opts)
}

async function cmdBroker({ opts }) {
  const { Broker } = await import('../broker/server.js')
  const broker = new Broker()
  const address = await broker.listen(opts.port === DEFAULTS.port ? 8080 : opts.port, opts.host)
  console.log(`c2c broker listening on ${address.address}:${address.port}`)
  await new Promise(() => {})
}

async function waitForReady(session, tries = 40) {
  let state = 'unknown'
  for (let i = 0; i < tries; i++) {
    state = await tmux.paneState(session)
    if (state === 'prompt' || state === 'dialog' || state === 'dead') return state
    await new Promise((r) => setTimeout(r, 250))
  }
  return state
}

async function waitForRelay(session, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const meta = await readMeta(session)
    if (meta) return meta
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

function shellQuote(value) {
  return /^[\w./:=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

async function cmdRelay() {
  const session = process.env.C2C_SESSION
  const brokerUrl = process.env.C2C_BROKER_URL
  const relay = new Relay({
    session,
    port: Number(process.env.C2C_PORT),
    host: process.env.C2C_BIND,
    token: process.env.C2C_TOKEN,
    broker: brokerUrl ? { url: brokerUrl, room: process.env.C2C_BROKER_ROOM } : null,
  })
  await relay.start()
  console.log(`[relay] listening on ${relay.url}`)
  if (brokerUrl) console.log(`[relay] broker uplink ${relay.broker.guestUrl}`)

  const shutdown = async () => {
    await relay.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  setInterval(async () => {
    if (!(await tmux.hasSession(session))) {
      console.log('[relay] tmux session gone, shutting down')
      // Otherwise guests just see the socket drop and reconnect forever.
      relay.announceEnd('the session ended')
      await new Promise((r) => setTimeout(r, 150))
      await shutdown()
    }
  }, 2000)
}

function attach(session) {
  return new Promise((resolveDone) => {
    const child = spawn('tmux', tmux.attachArgs(session), { stdio: 'inherit' })
    child.on('exit', () => resolveDone())
  })
}

async function cmdCtl({ opts, rest }) {
  const [sub, ...args] = rest
  const message = buildControlMessage(sub, args)
  if (!message) {
    console.error('usage: c2c ctl <status|list|mode spectator|mode yolo|approve ID|deny ID|approve-all|deny-all>')
    process.exit(1)
  }
  const reply = await control(opts.session, message)
  if (sub === 'status') printStatus(reply)
  else console.log(JSON.stringify(reply, null, 2))
  if (reply.ok === false) process.exit(1)
}

function buildControlMessage(sub, args) {
  switch (sub) {
    case 'status':
    case 'list':
    case 'approve-all':
    case 'deny-all':
    case 'approve-next':
    case 'deny-next':
      return { cmd: sub }
    case 'mode':
      return { cmd: 'mode', mode: args[0] }
    case 'approve':
    case 'deny':
      return { cmd: sub, id: args[0] }
    default:
      return null
  }
}

function printStatus(reply) {
  if (!reply.ok) {
    console.error(reply.error)
    return
  }
  console.log(`session  ${reply.session}`)
  console.log(`mode     ${reply.mode}`)
  console.log(`url      ${reply.url}`)
  if (reply.broker) {
    console.log(`broker   ${reply.broker.connected ? 'connected' : 'disconnected'}  ${reply.broker.url}`)
  }
  console.log(
    `guests   ${reply.guests.length ? reply.guests.map((g) => `${g.name} (${g.via})`).join(', ') : 'none'}`
  )
  if (reply.pending.length) {
    console.log('pending:')
    for (const entry of reply.pending) {
      console.log(`  #${entry.id}  ${entry.guest}: ${entry.text}`)
    }
  } else {
    console.log('pending  none')
  }
}

async function cmdStop({ opts }) {
  try {
    await control(opts.session, { cmd: 'stop' })
  } catch {}
  await tmux.killSession(opts.session)
  console.log(`stopped "${opts.session}"`)
}

function usage() {
  console.log(`c2c-conv - share one Claude Code session with a second person

usage:
  c2c host [-s NAME] [-p PORT] [--bind ADDR] [--cwd DIR] [--no-attach]
           [--broker wss://HOST] [--room NAME] [--token SECRET] [-- <claude args>]
  c2c attach [-s NAME]
  c2c invite [-s NAME]
  c2c ctl <status|list|mode spectator|mode yolo|approve ID|deny ID|approve-all|deny-all>
  c2c stop [-s NAME]
  c2c broker [-p PORT] [--bind ADDR]

transports:
  loopback + ssh   default, nothing to deploy
  --bind ADDR      serve a LAN or tailnet address directly
  --broker URL     dial out to a rendezvous broker, works through NAT both ends

state lives in ${stateDir('<session>')}`)
}

const { opts, rest, passthrough } = parseArgs(process.argv.slice(2))
const command = rest[0] ?? (process.argv[2] === '__relay' ? '__relay' : 'help')

try {
  switch (command) {
    case 'host':
      await cmdHost({ opts, passthrough })
      break
    case '__relay':
      await cmdRelay()
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
    case 'broker':
      await cmdBroker({ opts })
      break
    case 'stop':
      await cmdStop({ opts })
      break
    default:
      usage()
  }
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
