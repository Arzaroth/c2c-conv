import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { connect as netConnect } from 'node:net'
import { randomBytes } from 'node:crypto'

import { Bigtop, resolvePublic } from '../bigtop/server.js'

let bigtop
let base

before(async () => {
  bigtop = new Bigtop()
  const address = await bigtop.listen(0, '127.0.0.1')
  base = `ws://127.0.0.1:${address.port}`
})

after(() => bigtop.close())

function open(url, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    if (binary) ws.binaryType = 'arraybuffer'
    const messages = []
    const waiters = []

    ws.addEventListener('message', (event) => {
      const value = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
      const waiter = waiters.shift()
      if (waiter) waiter(value)
      else messages.push(value)
    })
    ws.addEventListener('open', () =>
      resolve({
        ws,
        send: (value) => ws.send(typeof value === 'string' ? value : JSON.stringify(value)),
        sendRaw: (value) => ws.send(value),
        next: () =>
          new Promise((res, rej) => {
            if (messages.length) return res(messages.shift())
            const timer = setTimeout(() => rej(new Error('timed out waiting for a message')), 2000)
            waiters.push((value) => {
              clearTimeout(timer)
              res(value)
            })
          }),
        close: () => ws.close(),
      })
    )
    ws.addEventListener('error', () => reject(new Error('connection refused')))
  })
}

test('a bozo cannot join a room with no host', async () => {
  await assert.rejects(() => open(`${base}/bozo?room=empty&t=secret-token`))
})

test('a host claims a room and sees the bozo join', async () => {
  const host = await open(`${base}/uplink?room=alpha&t=secret-token`)
  const bozo = await open(`${base}/bozo?room=alpha&t=secret-token`)

  const join = await host.next()
  assert.equal(join.event, 'join')
  assert.match(join.from, /^[0-9a-f]{8}$/)

  host.close()
  bozo.close()
})

test('bozo messages arrive enveloped, host replies arrive verbatim', async () => {
  const host = await open(`${base}/uplink?room=beta&t=secret-token`)
  const bozo = await open(`${base}/bozo?room=beta&t=secret-token`)

  const join = await host.next()
  assert.equal(join.event, 'join')
  const bozoId = join.from

  bozo.send({ type: 'submit', text: 'hello' })
  const forwarded = await host.next()
  assert.equal(forwarded.event, 'message')
  assert.equal(forwarded.from, bozoId)
  assert.deepEqual(forwarded.payload, { type: 'submit', text: 'hello' })

  host.send({ to: bozoId, payload: { type: 'pending', id: 1 } })
  assert.deepEqual(await bozo.next(), { type: 'pending', id: 1 })

  host.close()
  bozo.close()
})

test('a host binary frame fans out to every bozo', async () => {
  const host = await open(`${base}/uplink?room=gamma&t=secret-token`)
  const one = await open(`${base}/bozo?room=gamma&t=secret-token`, { binary: true })
  const two = await open(`${base}/bozo?room=gamma&t=secret-token`, { binary: true })

  await host.next()
  await host.next()

  host.sendRaw(new Uint8Array([0x1b, 0x5b, 0x41]))

  for (const bozo of [one, two]) {
    const frame = await bozo.next()
    assert.deepEqual(new Uint8Array(frame), new Uint8Array([0x1b, 0x5b, 0x41]))
  }

  host.close()
  one.close()
  two.close()
})

test('a broadcast reaches every bozo, a targeted message only one', async () => {
  const host = await open(`${base}/uplink?room=delta&t=secret-token`)
  const one = await open(`${base}/bozo?room=delta&t=secret-token`)
  const two = await open(`${base}/bozo?room=delta&t=secret-token`)

  const first = (await host.next()).from
  await host.next()

  host.send({ to: '*', payload: { type: 'policy:mode', mode: 'yolo' } })
  assert.deepEqual(await one.next(), { type: 'policy:mode', mode: 'yolo' })
  assert.deepEqual(await two.next(), { type: 'policy:mode', mode: 'yolo' })

  host.send({ to: first, payload: { type: 'named', name: 'bozo' } })
  assert.deepEqual(await one.next(), { type: 'named', name: 'bozo' })

  host.close()
  one.close()
  two.close()
})

test('a bozo with the wrong token is refused', async () => {
  const host = await open(`${base}/uplink?room=epsilon&t=secret-token`)
  await assert.rejects(() => open(`${base}/bozo?room=epsilon&t=wrong-token`))
  host.close()
})

test('a second host cannot take over a claimed room', async () => {
  const host = await open(`${base}/uplink?room=zeta&t=secret-token`)
  await assert.rejects(() => open(`${base}/uplink?room=zeta&t=secret-token`))
  host.close()
})

// A real client answers pings automatically, so a silent peer has to be built
// from a raw socket that completes the handshake and then never replies.
function silentPeer(port, path) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    const socket = netConnect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      )
    })
    socket.once('data', (chunk) => {
      const status = chunk.toString().split('\r\n')[0]
      if (status.includes('101')) resolve(socket)
      else reject(new Error(status))
    })
    socket.once('error', reject)
  })
}

test('a room is released when its host stops answering heartbeats', async () => {
  const quick = new Bigtop({ heartbeatMs: 60 })
  const address = await quick.listen(0, '127.0.0.1')

  const socket = await silentPeer(address.port, '/uplink?room=theta&t=secret-token')
  assert.equal(quick.rooms.size, 1)

  await new Promise((r) => setTimeout(r, 500))
  assert.equal(quick.rooms.size, 0, 'a silent host must not hold the room name')

  socket.destroy()
  quick.close()
})

test('a new host can claim a room once the stale one is reaped', async () => {
  const quick = new Bigtop({ heartbeatMs: 60 })
  const address = await quick.listen(0, '127.0.0.1')
  const url = `ws://127.0.0.1:${address.port}`

  const stale = await silentPeer(address.port, '/uplink?room=iota&t=old-token')
  await new Promise((r) => setTimeout(r, 500))

  const fresh = await open(`${url}/uplink?room=iota&t=new-token`)
  const bozo = await open(`${url}/bozo?room=iota&t=new-token`)
  assert.equal((await fresh.next()).event, 'join')

  stale.destroy()
  fresh.close()
  bozo.close()
  quick.close()
})

test('bozos are dropped when the host disconnects', async () => {
  const host = await open(`${base}/uplink?room=eta&t=secret-token`)
  const bozo = await open(`${base}/bozo?room=eta&t=secret-token`)
  await host.next()

  const closed = new Promise((resolve) => bozo.ws.addEventListener('close', resolve))
  host.close()
  assert.deepEqual(await bozo.next(), { type: 'notice', text: 'host disconnected' })
  await closed

  await assert.rejects(() => open(`${base}/bozo?room=eta&t=secret-token`))
})

test('static paths cannot escape the web root', () => {
  const root = '/srv/web'
  for (const attempt of ['../../etc/passwd', '..', '../web/../../../etc/shadow', '../']) {
    assert.equal(resolvePublic(attempt, root), null, attempt)
  }
})

test('ordinary asset paths resolve inside the web root', () => {
  const root = '/srv/web'
  assert.equal(resolvePublic('client.js', root), '/srv/web/client.js')
  assert.equal(resolvePublic('/index.html', root), '/srv/web/index.html')
  assert.equal(resolvePublic('a/../client.js', root), '/srv/web/client.js')
})

test('a room name with path characters is refused', async () => {
  await assert.rejects(() => open(`${base}/uplink?room=${encodeURIComponent('../etc')}&t=secret-token`))
  await assert.rejects(() => open(`${base}/uplink?room=${encodeURIComponent('a b')}&t=secret-token`))
})

test('an over-long room name is refused', async () => {
  await assert.rejects(() => open(`${base}/uplink?room=${'r'.repeat(65)}&t=secret-token`))
})

// The room is only as private as its token, and the bigtop is the one place
// that can insist the host picked a real one.
test('a short token is refused outright', async () => {
  await assert.rejects(() => open(`${base}/uplink?room=shorty&t=abc`))
})

test('claiming rooms is capped', async () => {
  const capped = new Bigtop()
  const address = await capped.listen(0, '127.0.0.1')
  const url = `ws://127.0.0.1:${address.port}`

  const hosts = []
  for (let i = 0; i < 64; i++) {
    hosts.push(await open(`${url}/uplink?room=room${i}&t=secret-token`))
  }
  assert.equal(capped.rooms.size, 64)

  await assert.rejects(() => open(`${url}/uplink?room=one-too-many&t=secret-token`))

  for (const host of hosts) host.close()
  capped.close()
})
