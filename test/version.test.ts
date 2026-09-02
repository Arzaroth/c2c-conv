import { test } from 'node:test'
import assert from 'node:assert/strict'

import { packageVersion, version, versionReport } from '../src/version.js'

test('the package version is a real semver', () => {
  assert.match(packageVersion(), /^\d+\.\d+\.\d+/)
})

// Installed as a symlink into a checkout, the released version alone does not
// say which code is on disk. The commit does.
test('the version carries the git revision when there is one', () => {
  assert.match(version(), new RegExp(`^${packageVersion().replace(/\./g, '\\.')}( \\([0-9a-f]{7,}(-dirty)?\\))?$`))
})

test('the report names the version, the runtime and where it came from', () => {
  const report = versionReport()
  assert.match(report, /^c2c-conv /m)
  assert.match(report, /^node {5}v\d+/m)
  assert.match(report, /^source /m)
})
