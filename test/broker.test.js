import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { connect as netConnect } from 'node:net'
import { randomBytes } from 'node:crypto'

import { Broker } from '../broker/server.js'

let broker
let base

before(async () => {
  broker = new Broker()
  const address = await broker.listen(0, '127.0.0.1')
  base = `ws://127.0.0.1:${address.port}`
})

after(() => broker.close())

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

test('a guest cannot join a room with no host', async () => {
  await assert.rejects(() => open(`${base}/guest?room=empty&t=secret`))
})

test('a host claims a room and sees the guest join', async () => {
  const host = await open(`${base}/uplink?room=alpha&t=secret`)
  const guest = await open(`${base}/guest?room=alpha&t=secret`)

  const join = await host.next()
  assert.equal(join.event, 'join')
  assert.match(join.from, /^[0-9a-f]{8}$/)

  host.close()
  guest.close()
})

test('guest messages arrive enveloped, host replies arrive verbatim', async () => {
  const host = await open(`${base}/uplink?room=beta&t=secret`)
  const guest = await open(`${base}/guest?room=beta&t=secret`)

  const join = await host.next()
  assert.equal(join.event, 'join')
  const guestId = join.from

  guest.send({ type: 'submit', text: 'hello' })
  const relayed = await host.next()
  assert.equal(relayed.event, 'message')
  assert.equal(relayed.from, guestId)
  assert.deepEqual(relayed.payload, { type: 'submit', text: 'hello' })

  host.send({ to: guestId, payload: { type: 'pending', id: 1 } })
  assert.deepEqual(await guest.next(), { type: 'pending', id: 1 })

  host.close()
  guest.close()
})

test('a host binary frame fans out to every guest', async () => {
  const host = await open(`${base}/uplink?room=gamma&t=secret`)
  const one = await open(`${base}/guest?room=gamma&t=secret`, { binary: true })
  const two = await open(`${base}/guest?room=gamma&t=secret`, { binary: true })

  await host.next()
  await host.next()

  host.sendRaw(new Uint8Array([0x1b, 0x5b, 0x41]))

  for (const guest of [one, two]) {
    const frame = await guest.next()
    assert.deepEqual(new Uint8Array(frame), new Uint8Array([0x1b, 0x5b, 0x41]))
  }

  host.close()
  one.close()
  two.close()
})

test('a broadcast reaches every guest, a targeted message only one', async () => {
  const host = await open(`${base}/uplink?room=delta&t=secret`)
  const one = await open(`${base}/guest?room=delta&t=secret`)
  const two = await open(`${base}/guest?room=delta&t=secret`)

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

test('a guest with the wrong token is refused', async () => {
  const host = await open(`${base}/uplink?room=epsilon&t=secret`)
  await assert.rejects(() => open(`${base}/guest?room=epsilon&t=wrong`))
  host.close()
})

test('a second host cannot take over a claimed room', async () => {
  const host = await open(`${base}/uplink?room=zeta&t=secret`)
  await assert.rejects(() => open(`${base}/uplink?room=zeta&t=secret`))
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
  const quick = new Broker({ heartbeatMs: 60 })
  const address = await quick.listen(0, '127.0.0.1')

  const socket = await silentPeer(address.port, '/uplink?room=theta&t=secret')
  assert.equal(quick.rooms.size, 1)

  await new Promise((r) => setTimeout(r, 500))
  assert.equal(quick.rooms.size, 0, 'a silent host must not hold the room name')

  socket.destroy()
  quick.close()
})

test('a new host can claim a room once the stale one is reaped', async () => {
  const quick = new Broker({ heartbeatMs: 60 })
  const address = await quick.listen(0, '127.0.0.1')
  const url = `ws://127.0.0.1:${address.port}`

  const stale = await silentPeer(address.port, '/uplink?room=iota&t=old-token')
  await new Promise((r) => setTimeout(r, 500))

  const fresh = await open(`${url}/uplink?room=iota&t=new-token`)
  const guest = await open(`${url}/guest?room=iota&t=new-token`)
  assert.equal((await fresh.next()).event, 'join')

  stale.destroy()
  fresh.close()
  guest.close()
  quick.close()
})

test('guests are dropped when the host disconnects', async () => {
  const host = await open(`${base}/uplink?room=eta&t=secret`)
  const guest = await open(`${base}/guest?room=eta&t=secret`)
  await host.next()

  const closed = new Promise((resolve) => guest.ws.addEventListener('close', resolve))
  host.close()
  assert.deepEqual(await guest.next(), { type: 'notice', text: 'host disconnected' })
  await closed

  await assert.rejects(() => open(`${base}/guest?room=eta&t=secret`))
})
