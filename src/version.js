import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
}

// c2c is normally installed as a symlink into a git checkout rather than from a
// registry, so the released version alone does not say which code is on disk.
// The commit does, and a dirty marker says whether it even matches the commit.
export function gitRevision() {
  try {
    const sha = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const dirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return null
  }
}

export function version() {
  const revision = gitRevision()
  return revision ? `${packageVersion()} (${revision})` : packageVersion()
}

export function versionReport() {
  return [
    `c2c-conv ${version()}`,
    `node     ${process.version}`,
    `source   ${ROOT}`,
  ].join('\n')
}
