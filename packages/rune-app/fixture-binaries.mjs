// Resolve migrated workspace artifacts before a fixture changes its child cwd.
import assert from 'node:assert/strict'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const suffix = process.platform === 'win32' ? '.exe' : ''
function explicit(value, fallback) {
  if (value !== undefined) assert(path.isAbsolute(value), 'Fixture binary override must be absolute')
  return value ?? fallback
}
export const clientBinary = explicit(process.env.RUNE_CLIENT_EXE,
  path.join(path.resolve(root, process.env.CARGO_TARGET_DIR ?? 'target'), 'debug', `codenomad-rune${suffix}`))
export const serverBinary = explicit(process.env.RUNE_SERVER_EXE,
  path.join(root, 'packages/server-rs/target/debug', `codenomad-rs${suffix}`))
