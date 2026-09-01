import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'

export function stateDir(name) {
  return join(homedir(), '.c2c-conv', name)
}

export async function ensureStateDir(name) {
  const dir = stateDir(name)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function controlSocket(name) {
  return join(stateDir(name), 'control.sock')
}

export function paneFile(name) {
  return join(stateDir(name), 'pane.raw')
}

export function metaFile(name) {
  return join(stateDir(name), 'relay.json')
}

export function statusFile(name) {
  return join(stateDir(name), 'status.txt')
}
