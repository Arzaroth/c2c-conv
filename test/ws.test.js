import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { WebSocket } from '../src/ws.js'

class FakeSocket extends EventEmitter {
  written = []
  destroyed = false
  setNoDelay() {}
  write(chunk) {
    this.written.push(chunk)
  }
  end() {
    this.destroyed = true
  }
}

function clientFrame(payload, opcode = 0x1) {
  const data = Buffer.from(payload)
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
  const masked = Buffer.allocUnsafe(data.length)
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i & 3]

  let header
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | data.length])
  } else {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(data.length, 2)
  }
  return Buffer.concat([header, mask, masked])
}

test('decodes a masked text frame', () => {
  const socket = new FakeSocket()
  const ws = new WebSocket(socket)
  const seen = []
  ws.on('text', (value) => seen.push(value))

  socket.emit('data', clientFrame('{"type":"submit"}'))
  assert.deepEqual(seen, ['{"type":"submit"}'])
})

test('reassembles a frame split across chunks', () => {
  const socket = new FakeSocket()
  const ws = new WebSocket(socket)
  const seen = []
  ws.on('text', (value) => seen.push(value))

  const frame = clientFrame('hello world')
  socket.emit('data', frame.subarray(0, 4))
  socket.emit('data', frame.subarray(4))
  assert.deepEqual(seen, ['hello world'])
})

test('handles two frames arriving in one chunk', () => {
  const socket = new FakeSocket()
  const ws = new WebSocket(socket)
  const seen = []
  ws.on('text', (value) => seen.push(value))

  socket.emit('data', Buffer.concat([clientFrame('one'), clientFrame('two')]))
  assert.deepEqual(seen, ['one', 'two'])
})

test('decodes a payload needing the 16-bit length field', () => {
  const socket = new FakeSocket()
  const ws = new WebSocket(socket)
  const seen = []
  ws.on('text', (value) => seen.push(value))

  const big = 'x'.repeat(400)
  socket.emit('data', clientFrame(big))
  assert.deepEqual(seen, [big])
})

test('rejects an unmasked client frame', () => {
  const socket = new FakeSocket()
  const ws = new WebSocket(socket)
  let closed = false
  ws.on('close', () => {
    closed = true
  })

  socket.emit('data', Buffer.from([0x81, 0x02, 0x68, 0x69]))
  assert.equal(closed, true)
})

test('server frames go out unmasked with the right header', () => {
  const socket = new FakeSocket()
  const ws = new WebSocket(socket)

  ws.sendText('hi')
  const frame = socket.written[0]
  assert.equal(frame[0], 0x81)
  assert.equal(frame[1], 2)
  assert.equal(frame.subarray(2).toString(), 'hi')
})

test('binary frames carry opcode 2', () => {
  const socket = new FakeSocket()
  const ws = new WebSocket(socket)

  ws.sendBinary(Buffer.from([1, 2, 3]))
  assert.equal(socket.written[0][0], 0x82)
})
