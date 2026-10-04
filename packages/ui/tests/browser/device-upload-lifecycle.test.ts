import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"
import { createFixtureCache } from "./fixture-cache"
import { startDeviceUploadFixture } from "./fixtures/device-upload-server.mjs"

const uiRoot = fileURLToPath(new URL("../..", import.meta.url))
const helperURL = new URL("./fixtures/device-upload-server.mjs", import.meta.url).href
const uploadTest = fileURLToPath(new URL("./device-upload.test.ts", import.meta.url))
const sharedMetadata = path.join(uiRoot, "node_modules/.vite/deps/_metadata.json")

async function optionalBytes(file: string) {
  try { return await readFile(file) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error }
}

test("device fixture close removes only its cache and preserves another live server and shared cache", async t => {
  const sharedBefore = await optionalBytes(sharedMetadata)
  // This pre-existing private sentinel also proves unrelated cache ownership
  // when a checkout has no default optimizer metadata yet.
  const sentinel = await createFixtureCache()
  const sentinelPath = path.join(sentinel.cacheDir, "existing-cache-sentinel")
  await writeFile(sentinelPath, "keep-existing-cache")
  t.after(() => sentinel.dispose())
  const first = await startDeviceUploadFixture()
  t.after(() => first.server.close())
  const second = await startDeviceUploadFixture()
  t.after(() => second.server.close())
  const firstCache = first.server.config.cacheDir, secondCache = second.server.config.cacheDir
  assert.notEqual(firstCache, secondCache)
  assert.notEqual(firstCache, path.dirname(path.dirname(sharedMetadata)))
  assert.notEqual(secondCache, path.dirname(path.dirname(sharedMetadata)))
  await Promise.all([stat(firstCache), stat(secondCache)])
  await writeFile(path.join(secondCache, "live-server-sentinel"), "keep-live-cache")
  await first.server.close()
  assert.equal(first.server.httpServer?.listening, false)
  await assert.rejects(stat(firstCache), { code: "ENOENT" })
  assert.equal(await readFile(path.join(secondCache, "live-server-sentinel"), "utf8"), "keep-live-cache")
  assert.equal((await fetch(second.url)).status, 200)
  assert.equal(second.server.httpServer?.listening, true)
  await first.server.close() // Existing close consumers can repeat teardown.
  assert.equal(await readFile(sentinelPath, "utf8"), "keep-existing-cache")
  assert.deepEqual(await optionalBytes(sharedMetadata), sharedBefore)
  await second.server.close()
  await assert.rejects(stat(secondCache), { code: "ENOENT" })
})

for (const failure of ["create", "listen", "browser-launch"] as const) {
  test(`device fixture ${failure} failure cleans its owned cache in lifecycle order`, async t => {
    const artifacts = await createFixtureCache()
    t.after(() => artifacts.dispose())
    const tracePath = path.join(artifacts.cacheDir, "trace.json")
    const bootstrapPath = path.join(artifacts.cacheDir, "failure-bootstrap.mjs")
    // Execute the actual test's before/after hooks through the official tsx
    // runner. Only the failure boundary is injected; no browser is launched.
    await writeFile(bootstrapPath, `
import { registerHooks, createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const helperURL = ${JSON.stringify(helperURL)}
const uploadTestURL = ${JSON.stringify(pathToFileURL(uploadTest).href)}
const tracePath = ${JSON.stringify(tracePath)}
const mode = ${JSON.stringify(failure)}
const require = createRequire(helperURL)
const { createServer } = await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')), 'dist/node/index.js')).href)
const { createFixtureCache } = await import(new URL('../fixture-cache.ts', helperURL).href)
const events = [], caches = []
let server
const write = () => writeFileSync(tracePath, JSON.stringify({ mode, events, caches }))
globalThis.__deviceFixtureFailure = {
  async cache() {
    const cache = await createFixtureCache()
    caches.push(cache.cacheDir); events.push('cache-created')
    return { cacheDir: cache.cacheDir, async dispose() {
      if (server?.httpServer?.listening) throw new Error('Refusing to dispose a live server cache')
      events.push('cache-dispose-start'); await cache.dispose(); events.push('cache-dispose-complete'); write()
    } }
  },
  async create(options) {
    if (mode === 'create') { events.push('create-reject'); throw new Error('injected-device-create-failure') }
    server = await createServer(options); events.push('server-created')
    const close = server.close.bind(server)
    server.close = async () => { events.push('server-close-start'); await close(); events.push('server-close-complete') }
    if (mode === 'listen') server.listen = async () => { events.push('listen-reject'); throw new Error('injected-device-listen-failure') }
    return server
  },
  async launch() { events.push('browser-launch-reject'); throw new Error('injected-device-browser-launch-failure') },
}
const moduleURL = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL === helperURL && specifier === 'vite') return { url: moduleURL('export const createServer = (...args) => globalThis.__deviceFixtureFailure.create(...args)'), shortCircuit: true }
  if (context.parentURL === helperURL && specifier === '../fixture-cache.ts') return { url: moduleURL('export const createFixtureCache = () => globalThis.__deviceFixtureFailure.cache()'), shortCircuit: true }
  if (context.parentURL === uploadTestURL && specifier === 'playwright') return { url: moduleURL('export const chromium = { launch: (...args) => globalThis.__deviceFixtureFailure.launch(...args) }'), shortCircuit: true }
  return nextResolve(specifier, context)
} })
process.once('exit', () => { if (caches.length) write() })
`)
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT // This is a new runner, not the parent's test worker.
    const child = spawnSync(process.execPath, [
      "--import", "tsx", "--import", pathToFileURL(bootstrapPath).href, "--test",
      "--test-name-pattern=device files use native selection and arrive as ordered bytes in the prompt", uploadTest,
    ], { cwd: uiRoot, env, encoding: "utf8", timeout: 30_000 })
    assert.equal(child.error, undefined, child.error?.message)
    assert.equal(child.status, 1, child.stdout + child.stderr)
    assert.match(child.stdout + child.stderr, new RegExp(`injected-device-${failure}-failure`))
    const trace = JSON.parse(await readFile(tracePath, "utf8")) as { events: string[]; caches: string[] }
    console.info(`Injected ${failure} lifecycle: ${JSON.stringify(trace)}; ${child.stdout.match(/ℹ (?:tests|pass|fail|cancelled|skipped).*$/gm)?.join(", ")}`)
    assert.equal(trace.caches.length, 1)
    for (const cache of trace.caches) await assert.rejects(stat(cache), { code: "ENOENT" }, JSON.stringify(trace))
    assert.equal(trace.events.filter(event => event === "cache-dispose-complete").length, 1)
    if (failure === "create") {
      assert.deepEqual(trace.events, ["cache-created", "create-reject", "cache-dispose-start", "cache-dispose-complete"])
    } else {
      assert.equal(trace.events.filter(event => event === "server-close-complete").length, 2)
      assert.ok(trace.events.lastIndexOf("server-close-complete") < trace.events.indexOf("cache-dispose-start"))
    }
  })
}
