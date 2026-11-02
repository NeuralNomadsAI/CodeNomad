import assert from "node:assert/strict"
import { createServer, type ServerResponse } from "node:http"
import { after, before, test, type TestContext } from "node:test"
import { chromium, type Browser } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { captureConsole, refuseUntaggedConsole } from "./fixture-console"
import { FAKE_INTEGRATION_SENTINELS, findSentinels, assertNoSentinels } from "../../../../scripts/fixtures/fake-integration/index.mjs"

let browser: Browser, origin: string
const streams = new Set<ServerResponse>()
const host = { ...FAKE_INTEGRATION_SENTINELS, port: 49179 }, sentinelOptions = { port: 49179 }
const server = createServer((request, response) => {
  if (request.url === "/events") {
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(": ready\n\n")
    streams.add(response)
    request.once("close", () => streams.delete(response))
    return
  }
  if (request.url === "/network") { response.writeHead(503); response.end("owned network control"); return }
  response.writeHead(200, { "content-type": "text/html" })
  response.end(request.url === "/frame" ? "<title>frame</title>" : request.url === "/cross"
    ? `<iframe src="http://localhost:${(server.address() as any).port}/frame"></iframe>`
    : '<title>owned</title><iframe src="/frame"></iframe>')
})
before(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  origin = "http://127.0.0.1:" + (server.address() as any).port
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => {
  try { await browser?.close() }
  finally {
    for (const stream of streams) stream.end()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
async function open(t: TestContext, options: Parameters<typeof captureConsole>[2] = {}) {
  const context = await browser.newContext()
  t.after(() => context.close())
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  const capture = await captureConsole(page, browser, options)
  t.after(() => capture.abort())
  await page.goto(origin)
  return { page, capture }
}
const category = (kind: string) => (error: any) => error.categories?.includes(kind) === true

test("console copies preserve identical multiframe calls, six levels, mutation, native formatting, network and page errors", async t => {
  const { page, capture } = await open(t)
  const witness = new Map<string, { type: string; text: string; count: number }>()
  const witnessErrors: string[] = []
  let notify: (() => void) | undefined
  page.on("console", message => {
    try { refuseUntaggedConsole(message, capture.token) } catch { witnessErrors.push("uncovered") }
    const offset = message.text().lastIndexOf(capture.token)
    if (offset < 0) return
    const id = message.text().slice(offset + capture.token.length).split("|", 1)[0]
    if (witness.has(id)) witnessErrors.push("duplicate")
    witness.set(id, { type: message.type(), text: offset ? message.text().slice(0, offset - 1) : "", count: message.args().length - 1 })
    notify?.()
  })
  const awaitWitness = async () => {
    const count = capture.snapshots.size
    if (witness.size < count) await new Promise<void>(resolve => { notify = () => { if (witness.size >= count) resolve() } })
    assert.equal(witness.size, count)
    assert.deepEqual(witnessErrors, [])
  }
  await Promise.all(page.frames().map(frame => frame.evaluate(() => {
    for (let i = 0; i < 8; i++) console.debug("identical", { nested: { value: 1 }, error: new Error("retained") })
  })))
  await capture.fence()
  await awaitWitness()
  assert.equal(capture.snapshots.size, 16)
  assert.equal(new Set([...capture.snapshots.values()].map(snapshot => snapshot.context)).size, 2)
  assert.equal(new Set(capture.consoleEntries().map(entry => entry.text)).size, 1)
  await page.evaluate(host => {
    const error = new Error(host.token)
    error.stack += "\n" + JSON.stringify(host)
    const value: any = { nested: host, error }
    for (const level of ["debug", "log", "info", "warn", "error", "trace"] as const) console[level]("private control " + host.scriptHandle, value, error)
    value.nested = {}
    error.message = "mutated"
    error.stack = "mutated"
  }, host)
  await capture.fence()
  await awaitWitness()
  const entries = capture.consoleEntries().filter(entry => String(entry.args[0]).startsWith("private control"))
  for (const type of ["debug", "log", "info", "warning", "error", "trace"]) {
    const entry = entries.find(entry => entry.type === type)!
    assert.ok(entry, `captured ${type}`)
    assert.deepEqual(findSentinels(entry.args, sentinelOptions).sort(), Object.keys(host).sort())
    assert.deepEqual(findSentinels((entry.args[1] as any).error, sentinelOptions).sort(), Object.keys(host).sort())
    assert.ok(capture.native.get(entry.id!).args[1].objectId)
    assert.equal(capture.native.get(entry.id!).args[2].subtype, "error")
  }
  await page.evaluate(`(() => {
    for (const level of ["debug", "log", "info", "warn", "error", "trace"]) {
      console[level]("format %s %o", "word", { a: 1 })
      console[level]("unmatched %s %o %c")
      console[level]()
    }
    console.log(undefined, null, NaN, Infinity, -Infinity, -0, [1, , 3], function named() {}, /re/, new Date(0))
    console.log(document.body)
  })()`)
  await capture.fence()
  await awaitWitness()
  for (const entry of capture.consoleEntries().filter(entry => entry.id)) {
    const native = witness.get(entry.id!)
    assert.ok(native && entry.type === native.type && entry.text === native.text && entry.args.length === native.count,
      "same native call retains installed Playwright text/type/cardinality")
  }
  const pageError = page.waitForEvent("pageerror")
  await page.evaluate(host => {
    const error = new Error(host.token)
    error.stack += "\n" + JSON.stringify(host)
    setTimeout(() => { throw error }, 0)
  }, host)
  await pageError
  await capture.fence()
  assert.deepEqual(findSentinels(capture.pageErrors[0].message, sentinelOptions), ["token"])
  assert.deepEqual(findSentinels(capture.pageErrors[0].stack, sentinelOptions).sort(), Object.keys(host).sort())
  assert.throws(() => assertNoSentinels(capture.consoleEntries(), sentinelOptions, "intentional capture control"), error => {
    assertNoSentinels(String(error), sentinelOptions, "public failure")
    return true
  })
  const network = page.waitForEvent("console", { predicate: message => message.type() === "error" && message.args().length === 0 })
  await page.evaluate(() => fetch("/network"))
  await network
  await capture.fence()
  assert.ok(capture.logs.some(log => log.source === "network" && log.level === "error" && log.text.includes("503")))
  await page.evaluate(() => {
    const source = new EventSource("/events")
    ;(window as any).source = source
    ;(window as any).late = new Promise(resolve => { source.onmessage = event => { console.debug("real SSE late", { data: event.data }); resolve(true) } })
  })
  await page.waitForFunction(() => (window as any).source.readyState === 1)
  await capture.fence()
  const old = [...capture.history.values()].filter(context => !context.retired)
  for (const stream of streams) stream.write("data: owned-late-event\n\n")
  await page.evaluate(() => (window as any).late)
  await page.reload()
  await capture.fence()
  for (const context of old) assert.equal(context.retired, true)
  assert.ok(capture.consoleEntries().some(entry => entry.args[0] === "real SSE late"))
  await page.evaluate(() => {
    console.info("fresh document", { ok: true })
    addEventListener("beforeunload", () => console.warn("closing document", { late: true }))
  })
  await page.close({ runBeforeUnload: true })
  const receipt = await capture.complete()
  assert.ok(capture.consoleEntries().some(entry => entry.args[0] === "fresh document"))
  assert.ok(capture.consoleEntries().some(entry => entry.args[0] === "closing document"))
  assert.equal(receipt.received, receipt.processed)
  assert.equal(receipt.contexts, receipt.retired)
  assert.equal(receipt.observerClosed, true)
})

test("console native delivery held across document death blocks completion until release", async t => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let held = false
  const { page, capture } = await open(t, { beforeDeliver: async packet => {
    if (packet.method !== "Target.receivedMessageFromTarget") return
    const message = JSON.parse(packet.params.message)
    if (!held && message.method === "Runtime.consoleAPICalled" && message.params.args[0]?.value === "held-native-console") {
      held = true
      entered.resolve()
      await release.promise
    }
  } })
  try {
    await capture.fence()
    await page.evaluate(host => {
      const error = new Error(host.token)
      error.stack += "\n" + JSON.stringify(host)
      const value: any = { nested: host, error }
      console.debug("held-native-console", value, error)
      value.nested = {}
      error.message = "mutated"
      error.stack = "mutated"
    }, host)
    await entered.promise
    await page.reload()
    await page.evaluate(() => {
      console.info("new-document", { ok: true })
      addEventListener("beforeunload", () => console.warn("close-boundary", { late: true }))
    })
    let completed = false
    const completion = capture.complete().then(receipt => { completed = true; return receipt })
    await page.close({ runBeforeUnload: true })
    await capture.rawRetired
    assert.equal(completed, false, "raw native target death cannot overtake an earlier held packet")
    release.resolve()
    const receipt = await completion
    const entry = capture.consoleEntries().find(entry => entry.args[0] === "held-native-console")!
    assert.ok(entry)
    assert.deepEqual(findSentinels(entry.args, sentinelOptions).sort(), Object.keys(host).sort())
    assert.deepEqual(findSentinels((entry.args[1] as any).error, sentinelOptions).sort(), Object.keys(host).sort())
    assert.ok(capture.consoleEntries().some(entry => entry.args[0] === "new-document"))
    assert.ok(capture.consoleEntries().some(entry => entry.args[0] === "close-boundary"))
    assert.equal(receipt.received, receipt.processed)
    assert.equal(receipt.contexts, receipt.retired)
    assert.equal(receipt.observerClosed, true)
  } finally { release.resolve() }
})

for (const receipt of ["Target.targetDestroyed", "Target.detachedFromTarget"])
for (const kind of ["missing", "duplicate"] as const) test(`console refuses ${kind} ${receipt} retirement receipt`, async t => {
  let altered = false
  const { page, capture } = await open(t, { fault: (method, params) => {
    if (method === receipt) { altered = true; return kind === "missing" ? [] : [params, params] }
    return [params]
  } })
  await page.evaluate(() => console.debug("terminal control", { owned: true }))
  await page.close()
  await capture.rawRetired
  await assert.rejects(capture.complete, category(kind === "missing" ? "retirement-timeout" : "duplicate-terminal-receipt"))
  assert.equal(altered, true)
})

for (const kind of ["worker", "oopif", "related-page", "untagged-main"] as const) test(`console refuses uncovered ${kind}`, async t => {
  const { page, capture } = await open(t)
  const refused = Promise.withResolvers<boolean>()
  page.on("console", message => { try { refuseUntaggedConsole(message, capture.token) } catch { refused.resolve(true) } })
  if (kind === "worker") await page.evaluate(() => new Promise(resolve => {
    const worker = new Worker(URL.createObjectURL(new Blob(["onmessage=()=>{console.log('worker',{owned:true});postMessage('done')}"], { type: "text/javascript" })))
    ;(window as any).worker = worker
    worker.onmessage = () => resolve(true)
    worker.postMessage("owned")
  }))
  if (kind === "oopif") await page.goto(origin + "/cross")
  if (kind === "related-page") await page.context().newPage()
  if (kind === "untagged-main") await page.evaluate(() => console.dir({ nested: { owned: true } }))
  if (kind === "worker" || kind === "untagged-main") assert.equal(await refused.promise, true)
  await page.close()
  await assert.rejects(capture.complete, category(kind === "untagged-main" ? "untagged-native-console" : "unsupported-child-target"))
})

const corruptions = {
  "loss-snapshot": "malformed-snapshot", "loss-native": "missing-native", duplicate: "duplicate-native", orphan: "orphan-native",
  malformed: "malformed-snapshot", "wrong-context": "console-context-invalid", untagged: "untagged-native-console", serialization: "serialization-failure",
}
for (const [kind, expected] of Object.entries(corruptions)) test(`console refuses ${kind} without treating loss as safe`, async t => {
  let altered = false
  const { page, capture } = await open(t, { fault: kind === "serialization" ? undefined : (method, params) => {
    if (altered || method !== "Runtime.consoleAPICalled") return [params]
    altered = true
    if (kind === "loss-native") return []
    if (kind === "duplicate") return [params, params]
    const copy = structuredClone(params), tag = copy.args.at(-1), separator = tag.value.indexOf("|")
    if (kind === "loss-snapshot") { const body = JSON.parse(tag.value.slice(separator + 1)); delete body.args; tag.value = tag.value.slice(0, separator + 1) + JSON.stringify(body) }
    if (kind === "malformed") tag.value = tag.value.slice(0, separator + 1) + "{"
    if (kind === "wrong-context") copy.executionContextId = 999999
    if (kind === "orphan") tag.value = tag.value.replace(/:[1-9]\d*\|/, ":999|")
    if (kind === "untagged") copy.args.pop()
    return [copy]
  } })
  if (kind === "serialization") await page.evaluate(() => console.debug("copy failure", 1n))
  else await page.evaluate(() => console.debug("negative", { ok: true }))
  await page.close()
  await assert.rejects(capture.complete, category(expected))
  if (kind !== "serialization") assert.equal(altered, true)
})
