// Compile the shared app separately, then package the exact wasm artifact without Cargo.
import assert from 'node:assert/strict'
import {createHash, randomUUID} from 'node:crypto'
import {spawnFixtureChild as spawn} from '../native-fixture-guards.mjs'
import {createReadStream} from 'node:fs'
import {access, copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises'
import {Writable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import path from 'node:path'
import {constants, createBrotliCompress, createGzip} from 'node:zlib'
import {pairShell, shell, themeCss} from './web-shell.mjs'
import {runeSource} from './source.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const {values} = parseArgs({options: {wasm: {type: 'string'}, bindgen: {type: 'string'}, out: {type: 'string', default: 'target/rune-web'}, 'test-support': {type:'boolean',default:false}}})
const target = process.env.CARGO_TARGET_DIR
assert(target && path.isAbsolute(target), 'Set CARGO_TARGET_DIR to the absolute existing Cargo cache')
const within = (base, file) => {const relative = path.relative(base, file); return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)}
assert(values.wasm && path.isAbsolute(values.wasm) && within(target, values.wasm), 'Pass --wasm with the compiled app artifact inside CARGO_TARGET_DIR')
assert.equal(path.basename(values.wasm), 'codenomad-rune.wasm', 'Package the shared codenomad-rune application binary')
const out = path.resolve(root, values.out)
const outputs = path.join(root, 'target')
assert(within(outputs, out), 'Bundle output must stay inside this checkout target directory')
const lock = await readFile(path.join(root, 'Cargo.lock'), 'utf8')
const versions = lock.split('[[package]]').filter(block => /^\s*name = "wasm-bindgen"\s*$/m.test(block))
  .map(block => block.match(/^version = "([^"]+)"/m)?.[1])
assert.equal(versions.length, 1, 'Expected one wasm-bindgen version in Cargo.lock')
const version = versions[0]
const bindgen = values.bindgen ?? process.env.RUNE_WASM_BINDGEN ?? 'wasm-bindgen'
async function run(binary, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']})
    let stdout = '', output = ''
    child.stdout.on('data', chunk => {stdout += chunk; output += chunk; if (output.length > 1024 * 1024) child.kill()})
    child.stderr.on('data', chunk => {output += chunk; if (output.length > 1024 * 1024) child.kill()})
    child.once('error', () => reject(Error(`Cannot run ${binary}. Install wasm-bindgen-cli ${version} outside this task or set RUNE_WASM_BINDGEN to the matching executable.`)))
    child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(Error(`${path.basename(binary)} failed (${code}): ${output.slice(-4000)}`)))
  })
}
assert.equal(await run(bindgen, ['--version']), `wasm-bindgen ${version}`, `Use wasm-bindgen-cli ${version} matching Cargo.lock`)
const rune = runeSource(root)
const descriptor = await open(values.wasm, 'r')
try {const bytes = Buffer.alloc(8); await descriptor.read(bytes, 0, 8, 0); assert(bytes.equals(Buffer.from([0,97,115,109,1,0,0,0])), 'Expected a WebAssembly module')} finally {await descriptor.close()}
const hasSyntheticScene=(await readFile(values.wasm)).includes(Buffer.from('Synthetic message '))
assert.equal(hasSyntheticScene,values['test-support'],'Use a default product WASM, or build --features test-support and package explicitly with --test-support')
await mkdir(path.dirname(out), {recursive: true})
const staging = `${out}.next-${randomUUID()}`, backup = `${out}.old-${randomUUID()}`
const safeRemove = async directory => {assert(within(outputs, directory)); await rm(directory, {recursive: true, force: true})}
await mkdir(staging)
async function hash(file) {const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex')}
async function files(directory, relative = '') {
  const result = []
  for (const entry of (await readdir(path.join(directory, relative), {withFileTypes: true})).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
    assert(!entry.isSymbolicLink(), 'Bundle must contain ordinary generated files')
    const name = path.join(relative, entry.name)
    if (entry.isDirectory()) result.push(...await files(directory, name)); else result.push(name)
  }
  return result
}
async function compressedSize(file, transform) {let count = 0; await pipeline(createReadStream(file), transform, new Writable({write(chunk, _encoding, done) {count += chunk.length; done()}})); return count}
async function compressBuffer(file, transform) {const chunks = []; await pipeline(createReadStream(file), transform, new Writable({write(chunk, _encoding, done) {chunks.push(chunk); done()}})); return Buffer.concat(chunks)}
try {
  await run(bindgen, ['--target', 'web', '--out-dir', staging, '--out-name', 'app', '--remove-name-section', values.wasm])
  for (const font of ['Inter-Regular.ttf', 'Inter-Medium.ttf', 'Inter-SemiBold.ttf']) {
    await copyFile(path.join(rune, 'assets/web', font), path.join(staging, font))
  }
  const themeFile = path.join(root, 'crates/rune-theme-codenomad/assets/theme.json')
  const theme = JSON.parse(await readFile(themeFile, 'utf8'))
  const catalogueRoot = path.join(root, 'crates/rune-theme-codenomad/assets/catalogues')
  const index = JSON.parse(await readFile(`${catalogueRoot}.json`, 'utf8'))
  assert.equal(index.locales.length, 10, 'Bundle must preserve all supported catalogues')
  const messages = {}, pairing = {}
  for (const locale of index.locales) {
    const catalogue = JSON.parse(await readFile(path.join(catalogueRoot, `${locale}.json`), 'utf8'))
    messages[locale] = {direction: index.directions[locale]}
    pairing[locale] = {direction: index.directions[locale]}
    for (const [target, keys] of [[messages, {title: 'window.title.main', loading: 'rune.loading', failed: 'rune.failed', retry: 'sessionList.loadError.retry'}],
      [pairing, {title: 'window.title.main', heading: 'authRecovery.pairingTitle', guidance: 'rune.pairing_guide',
        loading: 'rune.loading', failed: 'rune.failed', expired: 'remoteBrowse.pairingExpired', limited: 'remoteBrowse.pairingRateLimited'}]]) {
      for (const [name, key] of Object.entries(keys)) {
        assert.equal(typeof catalogue[key], 'string', `Missing ${locale} web message ${key}`)
        target[locale][name] = catalogue[key]
      }
    }
  }
  const bootstrap = await readFile(new URL('./web-bootstrap.mjs', import.meta.url), 'utf8')
  assert.equal(bootstrap.split('__RUNE_WEB_MESSAGES__').length, 2)
  await writeFile(path.join(staging, 'boot.js'), bootstrap.replace('__RUNE_WEB_MESSAGES__', JSON.stringify(messages)))
  const css = themeCss(theme)
  const pageStyle = await readFile(path.join(root, 'crates/rune-theme-codenomad/assets/web-shell.css'), 'utf8')
  await writeFile(path.join(staging, 'theme.css'), css)
  await writeFile(path.join(staging, 'shell.css'), pageStyle)
  await writeFile(path.join(staging, 'index.html'), shell(messages.fr, index.directions.fr))
  const pair = await readFile(new URL('./web-pair.mjs', import.meta.url), 'utf8')
  assert.equal(pair.split('__RUNE_WEB_PAIR_MESSAGES__').length, 2)
  await writeFile(path.join(staging, 'remote-pair.html'), pairShell(pairing.en, css + pageStyle,
    pair.replace('__RUNE_WEB_PAIR_MESSAGES__', JSON.stringify(pairing).replaceAll('<', '\\u003c'))))
  const entries = [], compressed = []
  for (const relative of await files(staging)) {
    const file = path.join(staging, relative)
    const logical = relative.replaceAll(path.sep, '/')
    const [raw, gzip, brotli] = await Promise.all([
      stat(file).then(info => info.size),
      compressedSize(file, createGzip({level: 9})),
      compressBuffer(file, createBrotliCompress({params: {[constants.BROTLI_PARAM_QUALITY]: 5}})),
    ])
    if (brotli.length < raw) {
      await writeFile(`${file}.br`, brotli)
      compressed.push({
        file: `${logical}.br`,
        encoding: 'br',
        for: logical,
        sha256: createHash('sha256').update(brotli).digest('hex'),
        bytes: brotli.length,
      })
    }
    entries.push({file: logical, sha256: await hash(file), raw, gzip, brotli: brotli.length})
  }
  const manifest = {generator: 'scripts/rune/bundle-web.mjs', testSupport:values['test-support'], wasmBindgen: version, tools: {node: process.versions.node, zlib: process.versions.zlib, brotli: process.versions.brotli}, inputWasm: {sha256: await hash(values.wasm), bytes: (await stat(values.wasm)).size}, cargoLockSha256: await hash(path.join(root, 'Cargo.lock')), themeSha256: await hash(themeFile), locales: index.locales, compression: {gzipLevel: 9, brotliQuality: 5}, files: entries, compressed,
    totals: Object.fromEntries(['raw', 'gzip', 'brotli'].map(key => [key, entries.reduce((sum, entry) => sum + entry[key], 0)])),
    compressedTotals: {brotli: compressed.reduce((sum, entry) => sum + entry.bytes, 0)}}
  await writeFile(path.join(staging, 'bundle-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  let existing = false
  try {await access(out); existing = true} catch (error) {if (error.code !== 'ENOENT') throw error}
  if (existing) {
    const previous = JSON.parse(await readFile(path.join(out, 'bundle-manifest.json'), 'utf8'))
    assert.equal(previous.generator, manifest.generator, 'Refusing to replace an unowned output directory')
    await rename(out, backup)
  }
  try {await rename(staging, out)} catch (error) {if (existing) await rename(backup, out); throw error}
  if (existing) await safeRemove(backup)
  console.log(JSON.stringify({directory: out, ...manifest.totals, files: entries.length, wasmBindgen: version}))
} finally {await safeRemove(staging)}
