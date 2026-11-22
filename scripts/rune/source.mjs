import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import path from 'node:path'

export function runeSource(root = path.resolve(import.meta.dirname, '../..')) {
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--offline', '--format-version', '1', '--filter-platform', 'wasm32-unknown-unknown'],
    {cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024}))
  const packages = metadata.packages.filter(pkg => pkg.name === 'rune')
  assert.equal(packages.length, 1, 'Expected one resolved Rune package')
  return path.dirname(packages[0].manifest_path)
}
