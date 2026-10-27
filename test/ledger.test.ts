import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Ledger, readLedger } from '../src/ledger.js'

function fresh(): string {
  return join(mkdtempSync(join(tmpdir(), 'c2c-ledger-')), 'ledger.sqlite')
}

test('what was recorded reads back in order, after the writer has closed', async () => {
  const path = fresh()
  const ledger = (await Ledger.open(path))!
  ledger.record({ kind: 'f2f', who: 'bozo', text: 'wait, do not run that' }, 1)
  ledger.record({ kind: 'held', who: 'bozo', ref: '#1', text: 'rm -rf build' }, 2)
  ledger.record({ kind: 'denied', who: 'bozo', ref: '#1', text: 'rm -rf build' }, 3)
  ledger.close()

  const rows = (await readLedger(path))!
  assert.deepEqual(rows.map((row) => [row.at, row.kind, row.ref]), [[1, 'f2f', null], [2, 'held', '#1'], [3, 'denied', '#1']])
})

test('a reader can ask for the lane alone, or for a phrase', async () => {
  const path = fresh()
  const ledger = (await Ledger.open(path))!
  ledger.record({ kind: 'f2f', who: 'alice', text: 'looks good' })
  ledger.record({ kind: 'sent', who: 'bob', text: 'run the tests' })
  ledger.record({ kind: 'f2f', who: 'bob', text: '100% sure?' })
  ledger.close()

  assert.deepEqual((await readLedger(path, { kinds: ['f2f'] }))!.map((row) => row.who), ['alice', 'bob'])
  assert.deepEqual((await readLedger(path, { grep: '100%' }))!.map((row) => row.text), ['100% sure?'])
  assert.deepEqual((await readLedger(path, { grep: '%' }))!.length, 1)
  assert.deepEqual((await readLedger(path, { limit: 1 }))!.map((row) => row.text), ['100% sure?'])
})

// A bozo can write to the lane as fast as it likes, and the file outlives the
// session, so it is capped like everything else a bozo can grow.
test('the oldest rows go once the cap is passed', async () => {
  const path = fresh()
  const ledger = (await Ledger.open(path, { cap: 10 }))!
  for (let i = 1; i <= 1000; i++) ledger.record({ kind: 'f2f', who: 'bozo', text: `line ${i}` })
  ledger.close()

  const rows = (await readLedger(path, { limit: 1000 }))!
  assert.equal(rows.length, 10)
  assert.equal(rows.at(-1)!.text, 'line 1000')
})

test('there is nothing to read for a session that never had a ledger', async () => {
  await assert.rejects(() => readLedger(join(tmpdir(), 'c2c-no-such-dir', 'ledger.sqlite')))
})
