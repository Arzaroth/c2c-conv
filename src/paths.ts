import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'

export function stateDir(name: string): string {
  return join(homedir(), '.c2c-conv', name)
}

export async function ensureStateDir(name: string): Promise<string> {
  const dir = stateDir(name)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function controlSocket(name: string): string {
  return join(stateDir(name), 'control.sock')
}

export function paneFile(name: string): string {
  return join(stateDir(name), 'pane.raw')
}

export function metaFile(name: string): string {
  return join(stateDir(name), 'ringmaster.json')
}

export function statusFile(name: string): string {
  return join(stateDir(name), 'status.txt')
}

export function snapshotFile(name: string): string {
  return join(stateDir(name), 'snapshot.json')
}

export function tunnelLog(name: string): string {
  return join(stateDir(name), 'cloudflared.log')
}

export function ledgerFile(name: string): string {
  return join(stateDir(name), 'ledger.sqlite')
}
