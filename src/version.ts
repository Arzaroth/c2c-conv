import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PROJECT_ROOT } from './root.js'

export function packageVersion(): string {
  try {
    return JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
}

// c2c is normally installed as a symlink into a git checkout rather than from a
// registry, so the released version alone does not say which code is on disk.
// The commit does, and a dirty marker says whether it even matches the commit.
export function gitRevision(): string | null {
  try {
    const sha = execFileSync('git', ['-C', PROJECT_ROOT, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const dirty = execFileSync('git', ['-C', PROJECT_ROOT, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return null
  }
}

export function version(): string {
  const revision = gitRevision()
  return revision ? `${packageVersion()} (${revision})` : packageVersion()
}

export function versionReport(): string {
  return [
    `c2c-conv ${version()}`,
    `node     ${process.version}`,
    `source   ${PROJECT_ROOT}`,
  ].join('\n')
}
