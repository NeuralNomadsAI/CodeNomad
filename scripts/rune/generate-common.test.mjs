import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {copyFile, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import test from 'node:test'

test('generated checks accept checkout line endings and reject changed values', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const outputs = path.join(root, 'target/rune-codegen-tests')
  await mkdir(outputs, {recursive: true})
  const fixture = await mkdtemp(path.join(outputs, 'eol-'))
  const script = path.join(fixture, 'scripts/rune/generate-common.mjs')
  const artifact = path.join(fixture, 'crates/rune-theme-codenomad/assets/example.json')
  await mkdir(path.dirname(script), {recursive: true})
  await mkdir(path.dirname(artifact), {recursive: true})
  await copyFile(new URL('./generate-common.mjs', import.meta.url), script)
  const invoke = `import {generated} from ${JSON.stringify(pathToFileURL(script).href)}; await generated('assets/example.json', {value: 'été 🦀'});`
  const run = () => spawnSync(process.execPath, ['--input-type=module', '--eval', invoke, '--', '--check'],
    {cwd: fixture, encoding: 'utf8', windowsHide: true})
  const expected = '{\n  "value": "été 🦀"\n}\n'
  for (const text of [expected, expected.replaceAll('\n', '\r\n')]) {
    await writeFile(artifact, text)
    const result = run()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(await readFile(artifact, 'utf8'), text, '--check preserves checkout bytes')
  }
  await writeFile(artifact, expected.replace('été', 'changed'))
  const changed = run()
  assert.notEqual(changed.status, 0)
  assert.match(changed.stderr, /is stale/)
})
