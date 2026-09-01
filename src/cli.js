#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { readFile } from 'node:fs/promises'
import { openSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

import * as tmux from './tmux.js'
import { Relay } from './relay.js'
import { controlSocket, ensureStateDir, metaFile, stateDir } from './paths.js'

const SELF = fileURLToPath(import.meta.url)
const ROOT = join(dirname(SELF), '..')

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

  const claudeArgs = (passthrough ?? []).map(shellQuote).join(' ')
  const command = claudeArgs ? `claude ${claudeArgs}` : 'claude'

  await tmux.newSession({ name: opts.session, cwd: opts.cwd, command })

  const dir = await ensureStateDir(opts.session)
  const token = randomBytes(16).toString('hex')
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
  console.log(`  guest url   ${meta.host}:${meta.port} (token ${meta.token})`)
  console.log(`  local link  http://${meta.host}:${meta.port}/?t=${meta.token}`)
  console.log(`  over ssh    ssh -N -L ${meta.port}:${meta.host}:${meta.port} ${process.env.USER}@<this-host>`)
  console.log(`  mode        spectator (guests need your approval to send)`)
  console.log(`  control     c2c ctl status | c2c ctl mode yolo | c2c ctl approve <id>`)
  console.log('')

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
  const relay = new Relay({
    session,
    port: Number(process.env.C2C_PORT),
    host: process.env.C2C_BIND,
    token: process.env.C2C_TOKEN,
  })
  await relay.start()
  console.log(`[relay] listening on ${relay.url}`)

  const shutdown = async () => {
    await relay.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  setInterval(async () => {
    if (!(await tmux.hasSession(session))) {
      console.log('[relay] tmux session gone, shutting down')
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
  console.log(`guests   ${reply.guests.length ? reply.guests.map((g) => g.name).join(', ') : 'none'}`)
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
  c2c host [-s NAME] [-p PORT] [--bind ADDR] [--cwd DIR] [--no-attach] [-- <claude args>]
  c2c attach [-s NAME]
  c2c ctl <status|list|mode spectator|mode yolo|approve ID|deny ID|approve-all|deny-all>
  c2c stop [-s NAME]

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
