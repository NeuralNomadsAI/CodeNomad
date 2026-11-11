const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { setTimeout: delay } = require('node:timers/promises')
const { test, after } = require('node:test')

const root = path.resolve(__dirname, '..')
const load = createRequire(path.join(root, 'package.json'))
const fixture = fs.mkdtempSync(path.join(root, '.runtime-globs-'))
after(() => fs.rmSync(fixture, { recursive: true, force: true }))
function write(name, content = '') {
  const file = path.join(fixture, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}
const posix = value => value.replaceAll('\\', '/')
const sorted = values => values.map(posix).sort()
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')))
const copies = name => Object.entries(lock.packages).filter(([p]) => p.endsWith('/' + name))

test('every locked glob/minimatch copy is outside the two advisory ranges', () => {
  for (const [p, entry] of copies('glob')) {
    const [major, minor, patch] = entry.version.split('.').map(Number)
    assert.ok(major < 9 || major > 14 || major === 14 && (minor > 0 || patch >= 2), p)
  }
  for (const [p, entry] of copies('minimatch')) {
    const [major, minor, patch] = entry.version.split('.').map(Number)
    assert.ok(major < 7 || major > 11 || major === 11 && (minor > 0 || patch >= 1), p)
  }
})

for (const name of ['visible.txt', '.hidden.txt', 'dir/nested.txt', 'dir/.hidden.txt', 'skip/ignored.txt']) write('files/' + name, name)
const cwd = path.join(fixture, 'files')
const expected = ['.hidden.txt', 'dir/.hidden.txt', 'dir/nested.txt', 'visible.txt']
function tree(dir, depth) {
  fs.mkdirSync(dir, { recursive: true })
  if (depth) for (let i = 0; i < 3; i++) tree(path.join(dir, `d${i}`), depth - 1)
}
const deep = path.join(fixture, 'deep')
tree(deep, 4)

for (const [p, entry] of copies('glob').filter(([, v]) => Number(v.version.split('.')[0]) >= 9)) {
  const glob = load(path.join(root, p))
  test(`${p}: Promise, sync, stream, iterator, files, dot and relative ignore`, async () => {
    const options = { cwd, dot: true, nodir: true, ignore: ['skip/**'] }
    assert.deepEqual(sorted(await glob.glob('**/*.txt', options)), expected)
    assert.deepEqual(sorted(glob.globSync('**/*.txt', options)), expected)
    assert.deepEqual(sorted(await Array.fromAsync(glob.globStream('**/*.txt', options))), expected)
    assert.deepEqual(sorted(await Array.fromAsync(glob.globIterate('**/*.txt', options))), expected)
    assert.deepEqual(sorted(await glob.glob('**/*.txt', { ...options, dot: false })), ['dir/nested.txt', 'visible.txt'])
    assert.deepEqual(sorted(await glob.glob('**/*.txt', { ...options, absolute: true })), expected.map(p => posix(path.join(cwd, p))).sort())
    assert.ok((await glob.glob('**', { cwd, nodir: false })).includes('dir'))
    assert.deepEqual(await glob.glob('missing/**', { cwd }), [])
    assert.equal(typeof glob.glob.sync, 'function')
    assert.deepEqual(sorted(await glob.glob('**/*.txt', { ...options, root: cwd, ignore: ['/skip/**'] })), expected)
    assert.deepEqual(sorted(await glob.glob('**/*.txt', { ...options, windowsPathsNoEscape: true, ignore: ['skip\\**'] })), expected)
  })
  for (const mode of ['promise', 'stream', 'iterator']) {
    for (const abort of ['pre', 'manual', 'timeout']) {
      test(`${p}: ${mode} ${abort} abort stops directory traversal`, async t => {
        const controller = new AbortController()
        const signal = abort === 'timeout' ? AbortSignal.timeout(5) : controller.signal
        if (abort === 'pre') controller.abort(new Error('probe-abort'))
        let reads = 0
        let postAbort = 0
        const options = { cwd: deep, signal, fs: {
          readdir(...args) {
            reads++
            if (signal.aborted) postAbort++
            const cb = args.pop()
            if (abort === 'manual' && reads === 1) controller.abort(new Error('probe-abort'))
            fs.readdir(...args, (error, entries) => {
              if (reads === 1) setTimeout(() => cb(error, entries), 20)
              else cb(error, entries)
            })
          },
        } }
        const walk = () => mode === 'promise' ? glob.glob('**/*', options)
          : Array.fromAsync(mode === 'stream' ? glob.globStream('**/*', options) : glob.globIterate('**/*', options))
        await assert.rejects(walk, abort === 'timeout' ? { name: 'TimeoutError' } : /probe-abort/)
        const atReject = reads
        await delay(150)
        t.diagnostic(JSON.stringify({ reads, atReject, postAbort }))
        assert.equal(postAbort, 0, 'no new readdir after cancellation/deadline')
        assert.equal(reads, atReject, 'no background traversal after rejection')
        assert.equal(reads, abort === 'pre' ? 0 : 1)
      })
    }
  }
}

for (const [p, entry] of copies('minimatch').filter(([, v]) => Number(v.version.split('.')[0]) >= 7)) {
  test(`${p}: optimizationLevel 2 bounds globparts amplification`, () => {
    const { Minimatch } = load(path.join(root, p))
    assert.throws(() => new Minimatch(Array(30).fill('**/../a/b').join('/'), {
      optimizationLevel: 2, braceExpandMax: 64,
    }), RangeError)
    const small = new Minimatch('**/../a/b/**/../c/d', { optimizationLevel: 2 })
    assert.equal(small.match('../a/b/../c/d'), true)
    assert.equal(small.match('x/a/b/y/c/d'), true)
    const { minimatch } = load(path.join(root, p))
    assert.equal(minimatch('c:\\fixture\\dir\\a.txt', 'C:/fixture/**/a.txt', { platform: 'win32', windowsPathsNoEscape: true }), true)
    assert.equal(minimatch('//?/UNC/HOST/share/a.txt', '//host/share/*.txt', { platform: 'win32' }), true)
  })
}

test('@opencode/util Glob scan/match uses the real adapter options', async () => {
  const { Glob } = await import(pathToFileURL(path.join(root, 'node_modules/@opencode/util/dist/glob.js')))
  assert.deepEqual(sorted(await Glob.scan('**/*.txt', { cwd, dot: true, ignore: ['skip/**'] })), expected)
  assert.ok((await Glob.scan('**', { cwd, include: 'all' })).includes('dir'))
  assert.equal(Glob.match('**/*.txt', 'dir/.hidden.txt'), true)
  assert.equal(Glob.match('**/*.txt', 'dir/no.js'), false)
  write('links/target/a.txt', 'linked')
  fs.symlinkSync(path.join(fixture, 'links/target'), path.join(fixture, 'links/link'), process.platform === 'win32' ? 'junction' : 'dir')
  const links = { cwd: path.join(fixture, 'links') }
  assert.deepEqual(sorted(await Glob.scan('**/*.txt', links)), ['target/a.txt'])
  assert.deepEqual(sorted(await Glob.scan('**/*.txt', { ...links, symlink: true })), ['link/a.txt', 'target/a.txt'])
})

test('@npmcli/map-workspaces maps directories and ordered negations', async () => {
  for (const n of ['a', 'b', 'skip']) write(`workspaces/packages/${n}/package.json`, JSON.stringify({ name: n, version: '1.0.0' }))
  const map = load('@npmcli/map-workspaces')
  const base = path.join(fixture, 'workspaces')
  const pkg = { workspaces: ['packages/*', '!packages/skip'] }
  assert.deepEqual([...await map({ cwd: base, pkg })].map(([name]) => name), ['a', 'b'])
  assert.deepEqual([...await map({ cwd: base, pkg: { workspaces: ['packages/*', '!packages/b', 'packages/b'] } })].map(([name]) => name), ['a', 'b', 'skip'])
})

test('@npmcli/package-json discovers gyp, readme, manuals and bin files', async () => {
  const base = path.dirname(write('package/package.json', JSON.stringify({ name: 'fixture', version: '1.0.0', directories: { man: 'man', bin: 'bin' } })))
  write('package/binding.gyp')
  write('package/README.md', '# fixture')
  write('package/man/fixture.1', 'manual')
  write('package/bin/fixture', '#!/usr/bin/env node')
  const pkg = await load('@npmcli/package-json').prepare(base)
  assert.equal(pkg.content.scripts.install, 'node-gyp rebuild')
  assert.equal(pkg.content.readme, '# fixture')
  assert.deepEqual(pkg.content.man, ['man/fixture.1'])
  assert.equal(pkg.content.bin.fixture, 'bin/fixture')
})

test('cacache verify exercises its real content glob and preserves content', async () => {
  const cache = path.join(fixture, 'cache')
  const cacache = load('cacache')
  await cacache.put(cache, 'fixture', 'content')
  const stats = await cacache.verify(cache)
  assert.equal(stats.verifiedContent, 1)
  assert.equal((await cacache.get(cache, 'fixture')).data.toString(), 'content')
})

test('ignore-walk honors anchored rules, negation, case, dot files and partial directories', async () => {
  write('ignore/.ignore', '*.txt\n!keep.txt\n/anchored/\n')
  for (const p of ['drop.TXT', 'keep.txt', '.dot.txt', 'a/keep.txt', 'a/drop.txt', 'anchored/drop.js', 'a/anchored/keep.js']) write('ignore/' + p)
  const walk = load('ignore-walk')
  const options = { path: path.join(fixture, 'ignore') }
  const result = ['.ignore', 'a/anchored/keep.js', 'a/keep.txt', 'keep.txt']
  assert.deepEqual((await walk(options)).sort(), result)
  assert.deepEqual(walk.sync(options).sort(), result)
})

test('@tufjs/models preserves delegation boundaries', () => {
  const { DelegatedRole } = load(path.join(path.dirname(load.resolve('@tufjs/models')), 'role.js'))
  const role = new DelegatedRole({ name: 'fixture', keyIDs: [], threshold: 1, terminating: false, paths: ['packages/*.tgz'] })
  assert.equal(role.isDelegatedPath('packages/a.tgz'), true)
  for (const p of ['packages/nested/a.tgz', 'other/a.tgz', 'packages/.hidden.tgz']) assert.equal(role.isDelegatedPath(p), false)
})

test('@npmcli/arborist :path query uses minimatch through the real selector', async () => {
  write('arborist/package.json', JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { a: '1.0.0' } }))
  write('arborist/node_modules/a/package.json', JSON.stringify({ name: 'a', version: '1.0.0' }))
  const Arborist = load('@npmcli/arborist')
  const tree = await new Arborist({ path: path.join(fixture, 'arborist') }).loadActual()
  assert.deepEqual((await tree.querySelectorAll(':path(node_modules/*)')).map(n => n.name), ['a'])
})

test('rimraf glob removes only matched fixture files (async and sync)', async () => {
  const { rimraf, rimrafSync } = load('rimraf')
  write('remove/a.txt'); write('remove/keep.js'); write('remove/.hidden.txt')
  await rimraf(posix(path.join(fixture, 'remove/*.txt')), { glob: true })
  assert.deepEqual(fs.readdirSync(path.join(fixture, 'remove')).sort(), ['.hidden.txt', 'keep.js'])
  rimrafSync(posix(path.join(fixture, 'remove/*.txt')), { glob: { dot: true } })
  assert.deepEqual(fs.readdirSync(path.join(fixture, 'remove')), ['keep.js'])
})

test('rimraf cancellation stops its glob walk before deleting any matches', async t => {
  const controller = new AbortController()
  let reads = 0
  const sentinel = write('deep/sentinel.txt', 'keep')
  const io = { readdir(...args) {
    reads++
    const cb = args.pop()
    controller.abort(new Error('cancel-delete'))
    fs.readdir(...args, (error, entries) => setTimeout(() => cb(error, entries), 20))
  } }
  await assert.rejects(load('rimraf').rimraf(posix(path.join(deep, '**/*')), {
    glob: { signal: controller.signal, fs: io },
  }), /cancel-delete/)
  const atReject = reads
  await delay(150)
  t.diagnostic(JSON.stringify({ reads, atReject }))
  assert.equal(reads, 1)
  assert.equal(reads, atReject)
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep')
})

test('config-file-ts recompilation checks use glob.sync', () => {
  const config = load('config-file-ts')
  const file = write('config/value.ts', 'export default { value: 42 }')
  const out = path.join(fixture, 'compiled')
  const previous = process.cwd()
  try {
    process.chdir(path.dirname(file))
    assert.deepEqual(config.loadTsConfig(file, out), { value: 42 })
    assert.deepEqual(config.loadTsConfig(file, out), { value: 42 })
  } finally { process.chdir(previous) }
})

test('workbox getManifest uses real globSync/hash/ignore behavior', async () => {
  const { getManifest } = load('workbox-build')
  const manifest = await getManifest({ globDirectory: cwd, globPatterns: ['**/*.txt'], globIgnores: ['skip/**'] })
  assert.deepEqual(manifest.manifestEntries.map(e => e.url).sort(), ['dir/nested.txt', 'visible.txt'])
  assert.ok(manifest.manifestEntries.every(e => /^[a-f0-9]{32}$/.test(e.revision)))
  assert.equal(manifest.warnings.length, 0)
})

test('Tailwind loads TypeScript config through the updated sucrase consumer', async () => {
  const file = write('tailwind.config.ts', 'const value: string = "block"; export default { content: [{ raw: value }], corePlugins: { preflight: false } }')
  const tailwind = load('tailwindcss')
  const css = await load('postcss')([tailwind(file)]).process('@tailwind utilities;', { from: undefined })
  assert.match(css.css, /\.block\s*\{\s*display: block/)
})

test('@electron/asar retains glob 7 callbacks and callable minimatch 3', async () => {
  const asar = load('@electron/asar')
  write('asar-source/file with spaces.txt', 'fixture')
  const archive = path.join(fixture, 'app.asar')
  await asar.createPackageWithOptions(path.join(fixture, 'asar-source'), archive, { unpack: '*.txt' })
  assert.deepEqual(asar.listPackage(archive), [path.sep + 'file with spaces.txt'])
  assert.equal(asar.extractFile(archive, 'file with spaces.txt').toString(), 'fixture')
})
