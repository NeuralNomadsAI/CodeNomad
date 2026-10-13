import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { createFixtureCache } from "./fixture-cache"
import { headerBootScript } from "./header-fixture-diagnostics"
import { closeSessionAsideHarness, prepareSessionAsidePage, startSessionAsideFixture } from "./session-aside-harness"

let browser: Browser
before(async () => { browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined }) })
after(() => closeSessionAsideHarness(browser))
async function capture(run: () => Promise<unknown>) {
  try { return { value: await run() } } catch (error) { return { error } }
}

test("aside servers own distinct caches and shutdown preserves a live sibling", async t => {
  const first = await startSessionAsideFixture()
  t.after(() => first.server.close())
  const second = await startSessionAsideFixture()
  t.after(() => second.server.close())
  assert.notEqual(first.server.config.cacheDir, second.server.config.cacheDir)
  await Promise.all([stat(first.server.config.cacheDir), stat(second.server.config.cacheDir)])
  const sentinel = path.join(second.server.config.cacheDir, "live-sibling")
  await writeFile(sentinel, "keep")
  await first.server.close()
  await assert.rejects(stat(first.server.config.cacheDir), { code: "ENOENT" })
  assert.equal(await readFile(sentinel, "utf8"), "keep")
  assert.equal((await fetch(second.url)).status, 200)
  assert.equal(second.server.httpServer?.listening, true)
  await second.server.close()
  await assert.rejects(stat(second.server.config.cacheDir), { code: "ENOENT" })
})

for (const stage of ["clipboard", "API", "goto", "readiness"] as const) {
  test(`aside ${stage} setup rejection closes the real page before preserving its original error`, async t => {
    const page = await browser.newPage(), primary = new Error(`owned ${stage} failure`), stack = primary.stack
    const diagnostics: string[] = []
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args.map(String).join(" ")) })
    if (stage === "clipboard") {
      const add = page.addInitScript.bind(page)
      t.mock.method(page, "addInitScript", async (script: string) => {
        if (script === headerBootScript) return add(script)
        throw primary
      })
    } else if (stage === "API") t.mock.method(page, "route", async () => { throw primary })
    else if (stage === "goto") t.mock.method(page, "goto", async () => { throw primary })
    else t.mock.method(page, "waitForFunction", async () => { throw primary })
    const result = await capture(() => prepareSessionAsidePage(page, async () => {
      await page.addInitScript("window.clipboardFixture = true")
      await page.route("**/api/**", route => route.fulfill({ json: {} }))
      await page.goto("data:text/html,<div id='root'></div>")
      await page.waitForFunction(() => Boolean((window as Window & { fixture?: unknown }).fixture))
      assert.fail("readiness failure must not reach the body")
    }))
    assert.equal(result.error, primary)
    assert.equal(primary.stack, stack)
    assert.equal(page.isClosed(), true)
    assert.ok(diagnostics.some(message => message.includes("header-fixture-diagnostic")))
    assert.ok(diagnostics.every(message => message.length < 40000))
  })
}

test("aside diagnostic and page-close faults cannot replace the primary error or skip actual closure", async t => {
  const page = await browser.newPage(), close = page.close.bind(page)
  const primary = new Error("primary setup"), stack = primary.stack
  t.mock.method(console, "error", () => { throw new Error("diagnostic emission") })
  t.mock.method(page, "close", async () => { await close(); throw new Error("cleanup after closure") })
  const result = await capture(() => prepareSessionAsidePage(page, async () => { throw primary }))
  assert.equal(result.error, primary)
  assert.equal(primary.stack, stack)
  assert.equal(page.isClosed(), true)
})

test("successful aside setup transfers its still-open page to the scenario without diagnosing", async t => {
  const page = await browser.newPage()
  t.mock.method(console, "error", () => { assert.fail("successful setup must not diagnose") })
  try {
    const result = await prepareSessionAsidePage(page, async () => {
      await page.goto("data:text/html,<div id='root'></div>")
      return page
    })
    assert.equal(result, page)
    assert.equal(page.isClosed(), false)
  } finally { await page.close() }
})

test("aside teardown preserves a browser-close primary and still attempts server cleanup", async t => {
  const primary = new Error("browser-close"), stack = primary.stack, order: string[] = []
  t.mock.method(console, "error", () => { throw new Error("secondary logging") })
  const result = await capture(() => closeSessionAsideHarness(
    { close: async () => { order.push("browser"); throw primary } },
    { close: async () => { order.push("server"); throw new Error("server-close") } },
  ))
  assert.equal(result.error, primary)
  assert.equal(primary.stack, stack)
  assert.deepEqual(order, ["browser", "server"])
  const cleanup = new Error("server-only")
  assert.equal((await capture(() => closeSessionAsideHarness(undefined, { close: async () => { throw cleanup } }))).error, cleanup)
})

const uiRoot = fileURLToPath(new URL("../..", import.meta.url))
const harnessURL = new URL("./session-aside-harness.ts", import.meta.url).href
const asideTest = fileURLToPath(new URL("./session-aside.test.ts", import.meta.url))
for (const mode of ["create", "listen", "browser-launch"] as const) {
  test(`actual aside ${mode} startup failure disposes only its cache after native acknowledgements`, async t => {
    const artifacts = await createFixtureCache()
    t.after(() => artifacts.dispose())
    const bootstrap = path.join(artifacts.cacheDir, "failure.mjs"), receipt = path.join(artifacts.cacheDir, "receipt.json")
    await writeFile(bootstrap, `
import { registerHooks, createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const harness = ${JSON.stringify(harnessURL)}, test = ${JSON.stringify(pathToFileURL(asideTest).href)}
const mode = ${JSON.stringify(mode)}, receipt = ${JSON.stringify(receipt)}
const require = createRequire(harness)
const { createServer } = await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')), 'dist/node/index.js')).href)
const { createFixtureCache } = await import(new URL('./fixture-cache.ts', harness).href)
const events = [], caches = []
let server
const primary = new Error('owned-aside-' + mode)
const write = () => writeFileSync(receipt, JSON.stringify({ events, caches }))
globalThis.__asideFailure = {
  async cache() {
    const cache = await createFixtureCache(); caches.push(cache.cacheDir); events.push('cache-created')
    return { cacheDir: cache.cacheDir, async dispose() {
      if (server?.httpServer?.listening || server?._pendingRequests.size) throw new Error('unsafe cache deletion')
      events.push('dispose-start'); await cache.dispose(); events.push('dispose-complete'); write()
    } }
  },
  async create(options) {
    if (mode === 'create') { events.push('create-reject'); throw primary }
    server = await createServer(options); events.push('server-created')
    const close = server.close.bind(server)
    server.close = async () => { events.push('native-close-start'); await close(); events.push('native-close-complete') }
    if (mode === 'listen') server.listen = async () => { events.push('listen-reject'); throw primary }
    return server
  },
  async launch() { events.push('browser-launch-reject'); throw primary },
}
const module = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL === harness && specifier === 'vite') return { url: module('export const createServer = (...args) => globalThis.__asideFailure.create(...args)'), shortCircuit: true }
  if (context.parentURL === harness && specifier === './fixture-cache') return { url: module('export const createFixtureCache = () => globalThis.__asideFailure.cache()'), shortCircuit: true }
  if (context.parentURL === test && specifier === 'playwright') return { url: module('export const chromium = { launch: () => globalThis.__asideFailure.launch() }'), shortCircuit: true }
  return nextResolve(specifier, context)
} })
process.once('exit', () => { if (caches.length) write() })
`)
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const child = spawnSync(process.execPath, ["--import", "tsx", "--import", pathToFileURL(bootstrap).href,
      "--test", "--test-name-pattern=switch fences pending results without interrupting the main session", asideTest,
    ], { cwd: uiRoot, env, encoding: "utf8", timeout: 30_000 })
    assert.equal(child.error, undefined, child.error?.message)
    assert.equal(child.status, 1, child.stdout + child.stderr)
    assert.match(child.stdout + child.stderr, new RegExp(`owned-aside-${mode}`))
    const trace = JSON.parse(await readFile(receipt, "utf8")) as { events: string[]; caches: string[] }
    console.info(`Expected ${mode} failure receipt: ${JSON.stringify(trace)}`)
    assert.equal(trace.caches.length, 1)
    await assert.rejects(stat(trace.caches[0]), { code: "ENOENT" })
    assert.equal(trace.events.filter(event => event === "dispose-complete").length, 1)
    if (mode === "create") assert.deepEqual(trace.events, ["cache-created", "create-reject", "dispose-start", "dispose-complete"])
    else {
      assert.equal(trace.events.filter(event => event === "native-close-complete").length, 2)
      assert.ok(trace.events.lastIndexOf("native-close-complete") < trace.events.indexOf("dispose-start"))
      const line = child.stdout.split(/\r?\n/).find(line => line.startsWith('{"kind":"fixture-shutdown"'))
      assert.ok(line, child.stdout)
      const shutdown = JSON.parse(line) as { createdContexts: number; disposedContexts: number; activeContexts: number; pending: number }
      assert.equal(shutdown.createdContexts, shutdown.disposedContexts)
      assert.equal(shutdown.activeContexts, 0)
      assert.equal(shutdown.pending, 0)
    }
  })
}
