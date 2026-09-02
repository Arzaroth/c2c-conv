import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Compiled output lives under dist/, so nothing can reach package.json or web/
// by counting directories up from its own module. This is the one place that
// knows how deep the build puts things: dist/src/root.js is two levels down.
export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const WEB_ROOT = join(PROJECT_ROOT, 'web')
