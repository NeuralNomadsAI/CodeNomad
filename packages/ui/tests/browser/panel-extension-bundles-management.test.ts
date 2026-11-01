import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { readFile, writeFile } from "node:fs/promises"
import { parse } from "jsonc-parser"
import { fileURLToPath } from "node:url"
import { chromium, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { bundlesManagementServer } from "./fixtures/bundles-management-server"

let backend: Awaited<ReturnType<typeof bundlesManagementServer>>, server: ViteDevServer
let browser: Awaited<ReturnType<typeof chromium.launch>>, url: string
before(async () => {
  backend = await bundlesManagementServer()
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)),
    logLevel: "error", cacheDir: cache.cacheDir, plugins: [shutdown.plugin, solid(), {
      name: "bundles-management-fixture", configureServer(vite) {
        vite.middlewares.use("/fixture", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await vite.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/panel-extension-api4.tsx"></script></body></html>'))
        })
      },
    }], resolve: { dedupe: ["solid-js"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null,
      proxy: { "/api": backend.address } } })
  shutdown.own(server); await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await server?.close(); await backend?.close() })
const frame = (page: Page) => page.frameLocator('iframe[title="Bundles fixture"]')
async function open(installed = true, authenticated = true, options: { holdMount?: boolean; captureDetach?: boolean } = {}) {
  await backend.reset(installed)
  if (options.holdMount) backend.hold("mount")
  const page = await browser.newPage(), errors: string[] = [], consoles: unknown[] = [], http: unknown[] = [], reads: Promise<void>[] = []
  if (authenticated) await page.context().addCookies([{ name: "human", value: "fixture", url }])
  page.on("pageerror", error => errors.push(`${error.message}\n${error.stack ?? ""}`))
  page.on("console", message => { reads.push(Promise.all(message.args().map(arg => arg.evaluate(value =>
    JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Error ? { ...item, name: item.name, message: item.message, stack: item.stack } : item) ?? "null")).catch(() => null)))
    .then(args => { consoles.push({ type: message.type(), text: message.text(), args }) })) })
  page.on("response", response => {
    if (/\/bundles\//.test(response.url())) {
      const record = { status: response.status(), body: undefined as unknown }; http.push(record)
      reads.push(response.json().then(body => { record.body = body }).catch(() => {}))
    }
  })
  await page.addInitScript(() => {
    ;(window as any).transportOrder = []
    ;(window as any).mountResponses = 0
    const post = MessagePort.prototype.postMessage
    MessagePort.prototype.postMessage = function (...args: any[]) {
      if (args[0]?.type === "api4:result" && args[0]?.result?.outcome === "confirming") (window as any).transportOrder.push("ack-posted")
      return (post as any).apply(this, args)
    }
    const fetch = window.fetch
    window.fetch = function (...args) {
      const body = args[1]?.body
      if (typeof body === "string" && JSON.parse(body || "{}")?.command === "start") (window as any).transportOrder.push("start-http")
      const result = fetch.apply(this, args)
      if (String(args[0]).endsWith("/bundles/mount")) return result.then(async response => {
        if (response.ok) {
          await response.clone().json()
          setTimeout(() => { (window as any).mountResponses++ }, 0)
        }
        return response
      })
      return result
    }
  })
  if (options.captureDetach) await page.addInitScript(() => {
    if (window !== window.top) return
    ;(window as any).detachPortMessages = []
    const descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage")
    if (!descriptor?.set) throw new Error("Native MessagePort onmessage setter unavailable")
    Object.defineProperty(MessagePort.prototype, "onmessage", { ...descriptor, set(callback) {
      if (typeof callback !== "function") return descriptor.set!.call(this, callback)
      descriptor.set!.call(this, function (this: MessagePort, event: MessageEvent) {
        const value = event.data
        if (value?.type === "api4:request" && value.capability === "bundles" && value.method === "detach") {
          // Observe the original browser event, then forward it unchanged. Capture
          // only this public request, never the private ownership/confirmation lane.
          ;(window as any).detachPortMessages.push({ isTrusted: event.isTrusted, type: value.type,
            method: value.method, input: structuredClone(value.input) })
        }
        return callback.call(this, event)
      })
    } })
  })
  await page.route("**/api/**", route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname.startsWith("/api/panel-extensions") || pathname === "/api/events") return route.continue()
    return route.fulfill({ json: { entries: [], files: [], records: [], messages: [], data: [] } })
  })
  await page.goto(url); await page.waitForFunction(() => Boolean((window as any).fixture))
  await page.getByRole("tab", { name: "Bundles fixture", exact: true }).click()
  await frame(page).locator("#ready").filter({ hasText: "ses_work" }).waitFor()
  if (authenticated && !options.holdMount) {
    await page.waitForFunction(() => (window as any).mountResponses > 0)
  }
  const clean = async () => {
    await Promise.all(reads)
    const surfaces = await frame(page).locator("body").evaluate(() => ({ dom: document.body.textContent, messages: (window as any).messages,
      keys: Object.keys((window as any).codenomad.bundles), changes: (window as any).changes })).catch(() => null)
    const text = JSON.stringify({ surfaces, errors, consoles })
    for (const sentinel of ["PRIVATE_", "planID", "mountID", "documentDigest", backend.file]) assert.ok(!text.includes(sentinel), sentinel)
     for (const request of backend.requests) if (request.body.owner) assert.ok(!text.includes(request.body.owner))
     assert.ok(!text.includes(backend.project), "private Location stays parent-side")
     for (const response of http as Array<{ body?: any }>) {
       for (const source of response.body?.tracking?.sources ?? []) assert.ok(!text.includes(source.target), "private installation target stays parent-side")
     }
    for (const sentinel of ["PRIVATE_", backend.file, "documentDigest", "FOREIGN_TOKEN_96aa", "FOREIGN_SESSION_7ce0",
      '"attachedSessions":6137', "attachedSessions", "registryGeneration", "serviceGeneration"]) {
      assert.ok(!JSON.stringify(http).includes(sentinel), `HTTP: ${sentinel}`)
      assert.ok(!backend.streamFrames.join("").includes(sentinel), `SSE: ${sentinel}`)
      assert.ok(!text.includes(sentinel), `frame/diagnostics: ${sentinel}`)
    }
    assert.deepEqual(errors, [])
    assert.deepEqual(await page.evaluate(() => { const s = (window as any).fixture.snapshot(); return [s.prompts, s.commands, s.attachments] }), [0, 0, 0])
  }
  return { page, clean, http }
}
async function wait(check: () => boolean) {
  const deadline = Date.now() + 10_000
  while (!check()) { if (Date.now() >= deadline) assert.fail("backend observation timed out"); await new Promise(resolve => setTimeout(resolve, 20)) }
}
async function ask(page: Page, method = "attach", input: unknown = { integration: "fixture", offerID: "offer_fixture" }) {
  await frame(page).locator("body").evaluate((_body, value) => { (window as any).input = value }, { method, input })
  await frame(page).locator("#trigger").click()
  await page.getByRole("dialog").waitFor()
  return frame(page).locator("body").evaluate(() => (window as any).results.at(-1))
}
async function confirm(page: Page) {
  const requestID = await frame(page).locator("body").evaluate(() => (window as any).results.at(-1).requestID)
  await page.getByRole("button", { name: /^(Confirm|Remove from Global|Remove from Project)$/ }).click()
  await page.getByRole("dialog").waitFor({ state: "detached" })
  await terminal(page, requestID)
}
async function terminal(page: Page, requestID: string) {
  return frame(page).locator("body").evaluate((_body, id) => new Promise<any>(resolve => {
    const known = (window as any).changes.find((event: any) => event.kind === "request" && event.requestID === id)
    if (known) return resolve(known)
    const stop = (window as any).codenomad.bundles.onChanged((event: any) => {
      if (event.kind === "request" && event.requestID === id) { stop(); resolve(event) }
    })
  }), requestID)
}
async function reload(page: Page) {
  const mounts = await page.evaluate(() => (window as any).mountResponses)
  const previous = await page.locator('iframe[title="Bundles fixture"]').elementHandle()
  await page.getByRole("button", { name: "Reload extension", exact: true }).click()
  await page.waitForFunction(element => !element?.isConnected, previous)
  await frame(page).locator("#ready").filter({ hasText: "ses_work" }).waitFor()
  await page.waitForFunction(count => (window as any).mountResponses >= count + 2, mounts)
}

test("production ExtensionPanel posts ACK before start; backend Cancel and expiry restore the exact iframe button", async () => {
  const { page, clean } = await open()
  try {
    const ack = await ask(page)
    assert.equal(ack.outcome, "confirming")
    assert.ok(await frame(page).locator("body").evaluate(() => (window as any).ackDurations.at(-1).ms < 1_000))
    assert.deepEqual(await page.evaluate(() => (window as any).transportOrder), ["ack-posted", "start-http"])
    const cancel = page.getByRole("button", { name: "Cancel", exact: true })
    assert.equal(await cancel.evaluate(el => el === document.activeElement), true)
    assert.equal(await page.getByRole("button", { name: "Confirm", exact: true }).isDisabled(), true)
    await page.keyboard.press("Shift+Tab")
    assert.equal(await page.getByRole("dialog").evaluate(el => el.contains(document.activeElement)), true)
    await cancel.focus(); await page.keyboard.press("Enter")
    await page.getByRole("dialog").waitFor({ state: "detached" })
    await page.waitForTimeout(100)
    assert.equal(await frame(page).locator("#trigger").evaluate(el => el === document.activeElement), true)
    assert.equal(backend.state.rpc.includes("attachHost"), false)
    await ask(page); await wait(() => backend.requests.filter(r => r.body.command === "displayed").length === 2)
    backend.advance(120_001)
    await page.getByRole("dialog").waitFor({ state: "detached" }); await page.waitForTimeout(100)
    assert.equal(await frame(page).locator("#trigger").evaluate(el => el === document.activeElement), true)
    assert.equal(backend.state.rpc.includes("attachHost"), false)
    await clean()
  } finally { await page.close() }
})

const safeCalls = [
  ["request", { action: "install", integration: "fixture", scope: "global" }, false],
  ["setActive", { integration: "fixture", scope: "global", enabled: false }, true],
  ["request", { action: "update", integration: "fixture", scope: "global" }, true],
  ["request", { action: "remove", integration: "fixture", scope: "global" }, true],
  ["installHost", { integration: "fixture" }, true],
  ["attach", { integration: "fixture", offerID: "offer_fixture" }, true],
] as const

test("installation progress uses actual declaration and private submission, consumes runtime and reload hints", async () => {
  const { page, clean } = await open(false)
  const read = () => frame(page).locator("body").evaluate(() => (window as any).readState())
  try {
    assert.deepEqual((await read()).integrations[0].plugin, { declared: false, runtime: "unloaded" })
    backend.state.holdTerminal = true
    const ack = await ask(page, "request", { action: "install", integration: "fixture", scope: "global" })
    await page.getByRole("button", { name: "Confirm", exact: true }).click()
    await page.getByRole("dialog").waitFor({ state: "detached" })
    await wait(() => backend.streamFrames.some(value => value.includes('"outcome":"confirmed"')))
    assert.deepEqual((await read()).integrations[0].plugin, { declared: true, runtime: "unloaded", progress: "unconfirmed" }, "ACK/admission/declaration without receipt never means pending")
    backend.flushTerminals(); await terminal(page, ack.requestID)
    assert.deepEqual((await read()).integrations[0].plugin, { declared: true, runtime: "unloaded", progress: "pending" })
    backend.state.runtime = [{ id: backend.entry.plugin, source: { type: "package", target: backend.spec }, features: {}, state: { status: "active" } }]
    backend.state.fail = true
    const active = (await read()).integrations[0]
    assert.equal(active.state, "unknown", "RPC failure is separate from native loading")
    assert.deepEqual(active.plugin, { declared: true, runtime: "active" })
    assert.equal(active.version, undefined, "missing version is not absence")
    backend.state.runtime = []; backend.state.fail = false
    assert.equal((await read()).integrations[0].plugin.progress, "unconfirmed", "runtime disappearance never revives the old hint")
    await reload(page)
    assert.equal((await read()).integrations[0].plugin.progress, "unconfirmed")
    await clean()
  } finally { await page.close() }
})

test("late installation receipt keeps the conservative pre-confirm deadline and explicit external declarations stay unconfirmed", async () => {
  const { page, clean } = await open(false)
  const read = () => frame(page).locator("body").evaluate(() => (window as any).readState())
  try {
    await writeFile(backend.file, JSON.stringify({ plugins: [backend.spec] }))
    assert.equal((await read()).integrations[0].plugin.progress, "unconfirmed")
    await writeFile(backend.file, JSON.stringify({ plugins: [] }))
    backend.state.holdTerminal = true
    const ack = await ask(page, "request", { action: "install", integration: "fixture", scope: "global" })
    await page.getByRole("button", { name: "Confirm", exact: true }).click()
    await page.getByRole("dialog").waitFor({ state: "detached" })
    await wait(() => backend.streamFrames.some(value => value.includes('"outcome":"confirmed"')))
    await page.evaluate(() => { const now = Date.now; Date.now = () => now() + 120_001 })
    backend.flushTerminals(); await terminal(page, ack.requestID)
    assert.equal((await read()).integrations[0].plugin.progress, "unconfirmed", "a delayed receipt cannot start another two-minute window")
    await clean()
  } finally { await page.close() }
})

test("real native emoji offers reach the trusted confirmation intact and reconcile the exact binding", async () => {
  for (const document of ["Scene", "🧩".repeat(120)]) {
    const { page, clean } = await open()
    try {
      const label = "😀".repeat(120), conversation = "🧭".repeat(120)
      const integration = "OpenCode for " + "🎨".repeat(60 - [..."OpenCode for "].length)
      backend.state.offerLabel = label; backend.state.offerDocument = document; backend.state.conversation = conversation
      backend.entry.displayName = integration
      const hosts = await frame(page).locator("body").evaluate(() => (window as any).call("hosts", { integration: "fixture" }))
      assert.equal(hosts.offers[0].label, label)
      assert.equal(hosts.offers[0].document, document)
      const ack = await ask(page), text = await page.getByRole("dialog").innerText()
      assert.ok(text.includes(`${label} — ${document}`), "the joined document is preserved beyond 243 UTF-16 units")
      assert.ok(text.includes(conversation)); assert.ok(text.includes(integration))
      await confirm(page)
      assert.equal((await terminal(page, ack.requestID)).outcome, "confirmed")
      await frame(page).locator("#reconciled").filter({ hasText: '"state":"attached"' }).waitFor()
      assert.deepEqual(await frame(page).locator("body").evaluate(() => (window as any).reconciliations.at(-1).integrations[0].attachment),
        { state: "attached", label })
      await clean()
    } finally { await page.close() }
  }
})

test("every safe call ACKs busy under one second during delayed mount, with no deferred author action", async () => {
  for (const [method, input, installed] of safeCalls) {
    const { page, clean } = await open(installed, true, { holdMount: true })
    try {
      const start = Date.now()
      assert.deepEqual(await frame(page).locator("body").evaluate((_body, args) => (window as any).call(...args), [method, input]), { outcome: "busy" })
      assert.ok(Date.now() - start < 1_000, method)
      assert.equal(backend.requests.filter(request => request.method === "manage").length, 0)
      backend.release("mount"); await page.waitForFunction(() => (window as any).mountResponses > 0)
      assert.equal(backend.state.prepares, 0, "acquisition completion never replays the busy call")
      const ack = await ask(page, method, input)
      assert.equal(ack.outcome, "confirming")
      await confirm(page)
      assert.equal((await terminal(page, ack.requestID)).outcome, "confirmed")
      assert.equal(backend.requests.filter(request => request.method === "manage").length, 1)
      assert.equal(backend.state.prepares, 1)
      await clean()
    } finally { backend.release("mount"); await page.close() }
  }
})

test("every safe call shares the four-call bridge/host cap with reads and the backend confirmation arbiter", async () => {
  for (const [method, input, installed] of safeCalls) {
    const { page, clean } = await open(installed)
    try {
      backend.hold("manage")
      await frame(page).locator("body").evaluate((_body, args) => {
        (window as any).held = Promise.all(Array.from({ length: 4 }, () => (window as any).call(...args)))
      }, [method, input])
      await wait(() => backend.requests.filter(request => request.method === "manage").length === 4)
      assert.deepEqual(await frame(page).locator("body").evaluate(() => (window as any).codenomad.bundles.state().catch((error: Error) => ({ error: error.message }))), { error: "busy" })
      await frame(page).locator("body").evaluate((_body, value) => (window as any).rawPort.postMessage({
        type: "api4:request", id: 900, capability: "bundles", ...value,
      }), { method, input })
      await page.waitForTimeout(50)
      assert.deepEqual(await frame(page).locator("body").evaluate(() => (window as any).messages.filter((message: any) => message.id === 900)),
        [{ type: "api4:result", id: 900, error: "busy" }])
      assert.equal(backend.state.prepares, 0)
      backend.release("manage")
      const acks = await frame(page).locator("body").evaluate(() => (window as any).held)
      assert.equal(acks.filter((ack: any) => ack.outcome === "confirming").length, 1)
      assert.equal(acks.filter((ack: any) => ack.outcome === "busy").length, 3)
      await page.getByRole("dialog").waitFor()
      await page.getByRole("button", { name: "Cancel", exact: true }).click()
      await terminal(page, acks.find((ack: any) => ack.outcome === "confirming").requestID)
      assert.equal(backend.state.prepares, 1)
      await clean()
    } finally { backend.release("manage"); await page.close() }
  }
})

test("HTTP 409 retains the captured private lane until a delayed failed terminal arrives", async () => {
  const { page, clean, http } = await open()
  try {
    const ack = await ask(page, "setActive", { integration: "fixture", scope: "global", enabled: false })
    const disposals = backend.requests.filter(request => request.body.command === "dispose").length
    backend.state.holdTerminal = true
    await writeFile(backend.file, (await readFile(backend.file, "utf8")) + "// changed before confirmation\n")
    await page.getByRole("button", { name: "Confirm", exact: true }).click()
    await wait(() => http.some(response => (response as any).status === 409)).catch(() => assert.fail(JSON.stringify({
      statuses: http.map(response => (response as any).status), commands: backend.requests.map(request => request.body.command ?? request.method),
      privateKinds: backend.streamFrames.filter(value => value.startsWith("event: codenomad.bundles.event")).map(value => value.includes('"view":null') ? "closed" : value.includes('"view":') ? "view" : "terminal"),
      rpc: backend.state.rpc,
    })))
    await page.getByRole("dialog").waitFor({ state: "detached" })
    await page.waitForTimeout(100)
    assert.equal(backend.requests.filter(request => request.body.command === "dispose").length, disposals)
    assert.deepEqual(await frame(page).locator("body").evaluate(() => (window as any).changes), [])
    backend.flushTerminals()
    assert.deepEqual(await terminal(page, ack.requestID), { kind: "request", requestID: ack.requestID, outcome: "failed" })
    assert.ok(!(await readFile(backend.file, "utf8")).includes("-neuralnomads.fixture"))
    await clean()
  } finally { backend.flushTerminals(); await page.close() }
})

test("actual modal guards early keyboard/double activation and admits one transmission", async () => {
  const { page, clean } = await open()
  try {
    const cancelled = await ask(page)
    await page.keyboard.press("Enter")
    assert.equal((await terminal(page, cancelled.requestID)).outcome, "cancelled")
    await page.clock.install()
    const ack = await ask(page), confirmButton = page.getByRole("button", { name: "Confirm", exact: true })
    assert.equal(await confirmButton.isDisabled(), true)
    await confirmButton.evaluate(el => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true })); el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    })
    assert.equal(backend.requests.filter(request => request.body.command === "confirm").length, 0)
    assert.equal(backend.state.rpc.includes("attachHost"), false)
    await page.clock.fastForward(600); await page.waitForTimeout(650)
    await confirmButton.focus()
    await confirmButton.evaluate(el => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click() })
    await terminal(page, ack.requestID)
    assert.equal(backend.state.rpc.filter(method => method === "attachHost").length, 1)
    assert.equal(await frame(page).locator("body").evaluate((_body, id) => (window as any).changes.filter((value: any) => value.requestID === id).length, ack.requestID), 1)
    await clean()
  } finally { await page.close() }
})

test("uncertain submitted native transport is reconciled only by actual state/bindingRead, without optimistic completion or replay", async () => {
  const { page, clean } = await open()
  try {
    const before = await frame(page).locator("body").evaluate(() => (window as any).readState())
    assert.deepEqual(before.integrations[0].attachment, { state: "none" })
    backend.state.uncertain = true; backend.hold("state")
    await ask(page); await confirm(page)
    assert.equal(backend.state.rpc.filter(method => method === "attachHost").length, 1)
    assert.equal(backend.state.binding.get("ses_work"), true)
    assert.deepEqual(await frame(page).locator("body").evaluate(() => (window as any).reconciliations.at(-1).integrations[0].attachment), { state: "none" })
    assert.equal(backend.state.updates.length, 0, "lost native response prevents metadata hint write")
    backend.release("state")
    await frame(page).locator("#reconciled").filter({ hasText: '"state":"attached"' }).waitFor()
    assert.deepEqual(await frame(page).locator("body").evaluate(() => (window as any).reconciliations.at(-1).integrations[0].attachment), { state: "attached", label: "Fixture window" })
    assert.ok(backend.state.rpcInputs.filter(call => call.method === "bindingRead").every(call => call.input.sessionID === "ses_work"))
    assert.equal(backend.state.rpc.filter(method => method === "attachHost").length, 1)
    await clean()
  } finally { backend.release("state"); await page.close() }
})

test("all safe methods use actual native service adapters; install/activation write the captured temp config", async () => {
  for (const [method, input, effect] of [
    ["request", { action: "install", integration: "fixture", scope: "global" }, "install"],
    ["setActive", { integration: "fixture", scope: "global", enabled: false }, "disable"],
    ["request", { action: "update", integration: "fixture", scope: "global" }, "update"],
    ["installHost", { integration: "fixture" }, "installHost"],
    ["attach", { integration: "fixture", offerID: "offer_fixture" }, "attachHost"],
  ] as const) {
    const { page, clean } = await open(effect !== "install")
    try {
      const ack = await ask(page, method, input)
      assert.ok(await frame(page).locator("body").evaluate(() => (window as any).ackDurations.at(-1).ms < 1_000), `${effect}: ready-mount ACK`)
      await confirm(page)
      await wait(() => backend.streamFrames.some(value => value.includes('"outcome":"confirmed"')))
      if (effect === "install") assert.ok((await readFile(backend.file, "utf8")).includes(backend.spec))
      else if (effect === "disable") assert.ok((await readFile(backend.file, "utf8")).includes("-neuralnomads.fixture"))
      else if (effect === "update") assert.equal(backend.state.packages.length, 1)
      else assert.equal(backend.state.rpc.filter(method => method === effect).length, 1)
      assert.deepEqual(await frame(page).locator("body").evaluate(() => (window as any).changes.filter((v: any) => v.kind === "request")),
        [{ kind: "request", requestID: ack.requestID, outcome: "confirmed" }])
      await page.waitForTimeout(100)
      assert.equal(await frame(page).locator("#trigger").evaluate(el => el === document.activeElement), true, `${effect}: exact Confirm return focus`)
      await frame(page).locator("#reconciled").filter({ hasText: "integrations" }).waitFor()
      const reconciled = await frame(page).locator("body").evaluate(() => (window as any).reconciliations.at(-1).integrations[0])
      if (effect === "install") assert.equal(reconciled.configured, true)
      else if (effect === "disable") assert.equal(reconciled.activation.effective, "disabled")
      else if (effect === "update") assert.equal(reconciled.version, "0.2.0")
      else if (effect === "installHost") assert.equal(reconciled.status.host.state, "ok")
      else assert.deepEqual(reconciled.attachment, { state: "attached", label: "Fixture window" })
      assert.ok(backend.state.rpc.includes("bindingRead") || effect === "install")
      await clean()
    } finally { await page.close() }
  }
})

test("removal public port needs trusted Global warning and confirmation; exact source only, no bindings/Q8 cleanup or optimistic stop", async () => {
  const { page, clean } = await open()
  try {
    const original = JSON.stringify({ plugins: [{ package: backend.spec, options: { secret: "PRIVATE_OPTIONS" } }, "-neuralnomads.fixture", "ordinary-plugin"], preserved: true })
    await writeFile(backend.file, original)
    const metadata = structuredClone(backend.state.metadata), bindings = [...backend.state.binding.entries()]
    const input = { action: "remove", integration: "fixture", scope: "global" }
    await ask(page, "request", input)
    const dialog = page.getByRole("dialog"), text = await dialog.innerText()
    assert.equal(await page.getByRole("button", { name: "Remove from Global", exact: true }).isDisabled(), true)
    assert.ok(text.includes("Remove: OpenCode for fixture")); assert.ok(text.includes("Global"))
    assert.ok(text.includes("may interrupt its availability and connections"))
    assert.ok(text.includes("conversations in other projects")); assert.ok(text.includes("Reinstalling may restore"))
    const accessibleDescription = await dialog.evaluate(element => (element.getAttribute("aria-describedby") ?? "").split(/\s+/)
      .map(id => document.getElementById(id)?.textContent ?? "").join(" "))
    for (const essential of ["OpenCode for fixture", "Global", "may interrupt its availability and connections",
      "conversations in other projects", "Reinstalling may restore"]) assert.ok(accessibleDescription.includes(essential), essential)
    assert.ok(!text.includes("PRIVATE_")); assert.ok(!text.includes(backend.spec))
    assert.equal(await page.getByRole("button", { name: "Cancel", exact: true }).evaluate(el => el === document.activeElement), true)
    await page.setViewportSize({ width: 360, height: 380 })
    const bounds = await dialog.boundingBox(), actionBounds = await page.getByRole("button", { name: "Remove from Global", exact: true }).boundingBox()
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 380)
    assert.ok(actionBounds && actionBounds.y >= 0 && actionBounds.y + actionBounds.height <= 380)
    await page.keyboard.press("Enter"); await dialog.waitFor({ state: "detached" })
    assert.equal(await readFile(backend.file, "utf8"), original)
    assert.deepEqual(backend.state.rpc, [])
    const ack = await ask(page, "request", input)
    await confirm(page)
    assert.equal((await terminal(page, ack.requestID)).outcome, "confirmed")
    assert.deepEqual(parse(await readFile(backend.file, "utf8")), { plugins: ["-neuralnomads.fixture", "ordinary-plugin"], preserved: true })
    assert.equal(backend.state.runtime.length, 1, "source removal never claims runtime stop")
    assert.deepEqual(backend.state.metadata, metadata); assert.deepEqual([...backend.state.binding.entries()], bindings)
    assert.deepEqual(backend.state.updates, []); assert.deepEqual(backend.state.packages, [])
    assert.ok(!backend.state.rpc.some(method => ["attachHost", "detachHost", "installHost"].includes(method)))
    await page.waitForTimeout(100)
    assert.equal(await frame(page).locator("#trigger").evaluate(el => el === document.activeElement), true)
    await clean()
  } finally { await page.close() }
})

test("removal source/options/range drift and ambiguous or missing candidates have no effects through the public port", async () => {
  for (const change of ["options", "range", "index", "multiple", "missing", "ambiguous"] as const) {
    const { page, clean } = await open()
    try {
      const original = JSON.stringify({ plugins: [{ package: backend.spec, options: { secret: "PRIVATE_BEFORE" } }] })
      await writeFile(backend.file, original)
      if (change === "multiple") await writeFile(backend.file, JSON.stringify({ plugins: [backend.spec, backend.spec + "0"] }))
      else if (change === "missing") await writeFile(backend.file, '{"plugins":[]}')
      else if (change === "ambiguous") backend.state.runtime[0].id = "foreign.plugin"
      const input = { action: "remove", integration: "fixture", scope: "global" }
      if (["multiple", "missing", "ambiguous"].includes(change)) {
        const ack = await frame(page).locator("body").evaluate((_body, input) => (window as any).call("request", input), input)
        assert.equal((await terminal(page, ack.requestID)).outcome, "failed")
        assert.equal(await page.getByRole("dialog").count(), 0)
      } else {
        const ack = await ask(page, "request", input)
        if (change === "options") await writeFile(backend.file, JSON.stringify({ plugins: [{ package: backend.spec, options: { secret: "PRIVATE_AFTER" } }] }))
        else if (change === "index") await writeFile(backend.file, JSON.stringify({ plugins: ["ordinary", backend.spec] }))
        else backend.entry.range = "^0.2"
        await confirm(page)
        assert.equal((await terminal(page, ack.requestID)).outcome, "failed")
      }
      assert.ok(parse(await readFile(backend.file, "utf8")).plugins.length || change === "missing")
      assert.deepEqual(backend.state.rpc, []); assert.deepEqual(backend.state.updates, []); assert.deepEqual(backend.state.packages, [])
      await clean()
    } finally { await page.close() }
  }
})

test("removal waiting in real native config queue cannot outlive revocation or navigation", async () => {
  for (const change of ["revoke", "navigate"] as const) {
    const { page, clean } = await open()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let queued: Promise<void> | undefined
    try {
      await ask(page, "request", { action: "remove", integration: "fixture", scope: "global" })
      let entered!: () => void
      const ready = new Promise<void>(resolve => { entered = resolve })
      queued = backend.controls.editConfigDocument("api4-instance", { directory: backend.project }, "global", async document => { entered(); await gate; return document.text })
      await ready
      await page.getByRole("button", { name: "Remove from Global", exact: true }).click()
      await page.getByRole("dialog").waitFor({ state: "detached" })
      if (change === "revoke") await backend.revoke()
      else await page.evaluate(() => (window as any).fixture.show("ses_other"))
      release(); await queued; await page.waitForTimeout(100)
      assert.deepEqual(parse(await readFile(backend.file, "utf8")).plugins, [backend.spec])
      assert.deepEqual(backend.state.rpc, []); assert.deepEqual(backend.state.updates, [])
      await clean()
    } finally { release(); await queued; await page.close() }
  }
})

test("removal lost response stays failed and unreplayed although real source removal is observed", async () => {
  const { page, clean } = await open(), remove = backend.sources.remove.bind(backend.sources)
  let calls = 0
  backend.sources.remove = async (...args) => { calls++; await remove(...args); throw new Error("PRIVATE_LOST_REMOVAL_RESPONSE") }
  try {
    const metadata = structuredClone(backend.state.metadata)
    const ack = await ask(page, "request", { action: "remove", integration: "fixture", scope: "global" })
    await confirm(page)
    assert.equal((await terminal(page, ack.requestID)).outcome, "failed")
    assert.deepEqual(parse(await readFile(backend.file, "utf8")).plugins, [])
    await page.waitForTimeout(150)
    assert.equal(calls, 1)
    assert.deepEqual(await frame(page).locator("body").evaluate(() => (window as any).changes.filter((value: any) => value.kind === "request")),
      [{ kind: "request", requestID: ack.requestID, outcome: "failed" }])
    assert.deepEqual(backend.state.metadata, metadata); assert.deepEqual(backend.state.updates, [])
    await clean()
  } finally { backend.sources.remove = remove; await page.close() }
})

test("script/background detach refuses; raw authority/inherited/control attacks dispatch nothing", async () => {
  const { page, clean } = await open()
  try {
    const before = await readFile(backend.file, "utf8")
    assert.deepEqual(await frame(page).locator("body").evaluate(async () => Promise.all([
      (window as any).call("detach", { integration: "fixture" }),
    ])), [{ outcome: "invalid" }])
    await frame(page).locator("body").evaluate(() => {
      ["constructor", "__proto__", "confirm", "userRemount", "dispose", "attach", "request"].forEach((method, index) => (window as any).rawPort.postMessage({
        type: "api4:request", id: 900 + index, capability: "bundles", method, input: { action: "remove", scope: "global", integration: "fixture",
          owner: "forged", userActivation: true, spec: "PRIVATE_SPEC", path: "PRIVATE_PATH", sessionID: "ses_foreign", rpcID: "arbitrary", confirm: true } }))
    })
    await page.waitForTimeout(100)
    assert.equal(backend.state.prepares, 0); assert.deepEqual(backend.state.rpc, [])
    assert.deepEqual(await frame(page).locator("body").evaluate(() => (window as any).messages.filter((message: any) => message.id >= 900)
      .map((message: any) => message.error)), Array(7).fill(true))
    assert.equal(await page.getByRole("dialog").count(), 0); assert.equal(await readFile(backend.file, "utf8"), before)
    await clean()
  } finally { await page.close() }
})

test("AC-C16 limitation: real iframe click and author script produce indistinguishable browser-trusted detach messages; both refuse", async () => {
  const { page, clean } = await open(true, true, { captureDetach: true })
  try {
    const beforeFile = await readFile(backend.file, "utf8"), beforeMetadata = structuredClone(backend.state.metadata)
    const beforeBindings = [...backend.state.binding.entries()]
    assert.equal(await page.locator('iframe[title="Bundles fixture"]').getAttribute("sandbox"), "allow-scripts")
    assert.equal(await frame(page).locator("body").evaluate(() => self.origin), "null")
    assert.equal(await page.evaluate(() => {
      const iframe = document.querySelector('iframe[title="Bundles fixture"]') as HTMLIFrameElement
      try { void iframe.contentWindow!.document; return false }
      catch (error) { return error instanceof DOMException && error.name === "SecurityError" }
    }), true, "the parent cannot inspect the opaque frame's specific button DOM")

    await frame(page).locator("body").evaluate(() => {
      ;(window as any).input = { method: "detach", input: { integration: "fixture" } }
    })
    // Real pointer hit testing invokes the actual author's button and bridge.
    await frame(page).locator("#trigger").click()
    await frame(page).locator("#answer").filter({ hasText: '"outcome":"invalid"' }).waitFor()
    assert.deepEqual(await frame(page).locator("body").evaluate(() => (window as any).results), [{ outcome: "invalid" }])
    // A later author task invokes the same public method without clicking a button.
    assert.deepEqual(await frame(page).locator("body").evaluate(() => new Promise(resolve => {
      setTimeout(() => (window as any).call("detach", { integration: "fixture" }).then(resolve), 0)
    })), { outcome: "invalid" })

    const observed = await page.evaluate(() => (window as any).detachPortMessages)
    const expected = { isTrusted: true, type: "api4:request", method: "detach", input: { integration: "fixture" } }
    assert.deepEqual(observed, [expected, expected], "MessageEvent.isTrusted attests browser delivery, not an exact originating button")
    const answers = await frame(page).locator("body").evaluate(() => (window as any).messages.filter((message: any) => message.type === "api4:result"))
    assert.equal(answers.length, 2); assert.notEqual(answers[0].id, answers[1].id)
    assert.deepEqual(answers.map(({ id: _id, ...answer }: any) => answer), [
      { type: "api4:result", result: { outcome: "invalid" } }, { type: "api4:result", result: { outcome: "invalid" } },
    ])
    assert.deepEqual(backend.requests.filter(request => request.method === "manage").map(request => ({ method: request.body.method, input: request.body.input })),
      [{ method: "detach", input: { integration: "fixture" } }, { method: "detach", input: { integration: "fixture" } }])
    assert.equal(await page.getByRole("dialog").count(), 0)
    assert.equal(backend.state.prepares, 0); assert.deepEqual(backend.state.rpc, [])
    assert.deepEqual(backend.state.updates, [], "no Q8 metadata write")
    assert.deepEqual(backend.state.metadata, beforeMetadata); assert.deepEqual([...backend.state.binding.entries()], beforeBindings)
    assert.equal(await readFile(backend.file, "utf8"), beforeFile)
    await clean()
  } finally { await page.close() }
})

test("every safe method cancels, refuses changed catalogue targets and revokes before native submission", async () => {
  for (const [method, input, installed] of [
    ["request", { action: "install", integration: "fixture", scope: "global" }, false],
    ["setActive", { integration: "fixture", scope: "global", enabled: false }, true],
    ["request", { action: "update", integration: "fixture", scope: "global" }, true],
    ["installHost", { integration: "fixture" }, true],
    ["attach", { integration: "fixture", offerID: "offer_fixture" }, true],
  ] as const) for (const refusal of ["cancel", "stale", "revoke", "replace", "uninstall", "session"] as const) {
    const { page, clean } = await open(installed)
    try {
      const original = await readFile(backend.file, "utf8"), ack = await ask(page, method, input)
      if (refusal === "cancel") await page.getByRole("button", { name: "Cancel", exact: true }).click()
      else if (refusal === "revoke") await backend.revoke()
      else if (refusal === "replace") await backend.replace()
      else if (refusal === "uninstall") await backend.uninstall()
      else if (refusal === "session") await page.evaluate(() => (window as any).fixture.show("ses_other"))
      else { backend.entry.range = "^0.2"; await confirm(page) }
      await page.getByRole("dialog").waitFor({ state: "detached" })
      await wait(() => backend.streamFrames.some(value => value.includes(`"requestID":"${ack.requestID}","outcome"`)))
      assert.equal(await readFile(backend.file, "utf8"), original, `${method}/${refusal}`)
      assert.deepEqual(backend.state.packages, []); assert.deepEqual(backend.state.updates, [])
      assert.ok(!backend.state.rpc.some(method => ["attachHost", "installHost", "detachHost"].includes(method)))
      await clean()
    } finally { await page.close() }
  }
})

test("auth-disabled stream grants no owner; management returns busy without a fabricated mount", async () => {
  const { page, clean } = await open(true, false)
  try {
    const start = Date.now()
    assert.deepEqual(await frame(page).locator("body").evaluate(() => (window as any).call("attach", { integration: "fixture", offerID: "offer_fixture" })), { outcome: "busy" })
    assert.ok(Date.now() - start < 1_000)
    assert.equal(backend.requests.length, 0); assert.equal(backend.state.prepares, 0)
    assert.equal(await page.getByRole("dialog").count(), 0)
    await clean()
  } finally { await page.close() }
})

test("stale document/native refusal/revocation/navigation/disconnect cancel backend lifecycle without replay", async () => {
  for (const transition of ["document", "native", "revoke", "navigation", "disconnect", "nativeDisconnect"] as const) {
    const { page, clean } = await open()
    try {
      await ask(page, "setActive", { integration: "fixture", scope: "global", enabled: false })
      if (transition === "document") { await writeFile(backend.file, (await readFile(backend.file, "utf8")) + "// external edit\n"); await confirm(page) }
      else if (transition === "native") { backend.state.current = false; await page.getByRole("button", { name: "Confirm", exact: true }).click() }
      else if (transition === "revoke") await backend.revoke()
      else if (transition === "navigation") await frame(page).locator("body").evaluate(() => { location.href = "about:blank" })
      else if (transition === "disconnect") backend.disconnect()
      else backend.nativeDisconnect()
      await page.getByRole("dialog").waitFor({ state: "detached" }); await page.waitForTimeout(150)
      assert.ok(!(await readFile(backend.file, "utf8")).includes("-neuralnomads.fixture"), transition)
      assert.equal(backend.state.rpc.includes("attachHost"), false)
      assert.equal(backend.requests.filter(r => r.body.command === "start").length, 1)
      if (transition !== "navigation") await clean()
    } finally { await page.close() }
  }
})

test("human wait outlives method deadline; only explicit trusted toolbar reload resets cutoff", async () => {
  const { page, clean } = await open()
  try {
    await ask(page); await page.waitForTimeout(30_000)
    assert.equal(await page.getByRole("dialog").count(), 1)
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    for (let i = 0; i < 2; i++) { await ask(page); await page.getByRole("button", { name: "Cancel", exact: true }).click(); await page.getByRole("dialog").waitFor({ state: "detached" }) }
    assert.deepEqual(await frame(page).locator("body").evaluate(() => (window as any).call("attach", { integration: "fixture", offerID: "offer_fixture" })), { outcome: "busy" })
    await reload(page)
    await ask(page); await page.getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(backend.requests.filter(r => r.body.command === "userRemount").length, 1)
    await clean()
  } finally { await page.close() }
})

test("reconnected automatic mounts preserve cutoff; trusted reload on a disposed object uses the new owner and preserves rate history", async () => {
  for (const firstDisconnect of ["native", "sse"] as const) {
    const { page, clean } = await open()
    page.setDefaultTimeout(10_000)
    const busy = () => frame(page).locator("body").evaluate(() => (window as any).call("attach", { integration: "fixture", offerID: "offer_fixture" }))
    const reconnectSse = async () => {
      const count = backend.streamFrames.filter(value => value.startsWith("event: codenomad.bundles.owner")).length
      backend.disconnect()
      await wait(() => backend.streamFrames.filter(value => value.startsWith("event: codenomad.bundles.owner")).length > count)
      await page.waitForTimeout(100)
    }
    try {
      for (let i = 0; i < 3; i++) {
        await ask(page)
        await page.getByRole("button", { name: "Cancel", exact: true }).click()
        await page.getByRole("dialog").waitFor({ state: "detached" })
      }
      const originalOwner = backend.requests.find(request => request.method === "mount")!.body.owner
      const mounts = backend.requests.filter(request => request.method === "mount").length
      if (firstDisconnect === "native") {
        backend.nativeDisconnect(); await page.waitForTimeout(150)
        await page.getByRole("button", { name: "Reload extension", exact: true }).click()
        await page.getByRole("status").filter({ hasText: "Extension unavailable" }).waitFor()
        assert.equal(backend.requests.filter(request => request.method === "mount").length, mounts, "disconnected reload starts no authority read")
        assert.equal(backend.requests.filter(request => request.body.command === "userRemount").length, 0)
        backend.nativeReconnect(); await page.waitForTimeout(150)
      } else await reconnectSse()
      // Ordinary tab lifecycle mounts must retain the cancellation cutoff.
      const autoMounts = await page.evaluate(() => (window as any).mountResponses)
      await page.getByRole("tab", { name: "Status", exact: true }).click()
      await page.getByRole("tab", { name: "Bundles fixture", exact: true }).click()
      await frame(page).locator("#ready").filter({ hasText: "ses_work" }).waitFor()
      await page.waitForFunction(count => (window as any).mountResponses > count, autoMounts)
      assert.deepEqual(await busy(), { outcome: "busy" })
      assert.equal(backend.requests.filter(request => request.body.command === "userRemount").length, 0)
      const attempts = backend.requests.filter(request => request.method === "manage").length
      // This mounting is now disposed and its captured owner removed. The trusted
      // reload must acquire the replacement stream, not reuse that closed object.
      await reconnectSse()
      assert.equal(backend.requests.filter(request => request.method === "manage").length, attempts, "reconnect replays nothing")
      await reload(page)
      const reset = backend.requests.find(request => request.body.command === "userRemount")!
      assert.notEqual(reset.body.owner, originalOwner)
      assert.ok(backend.requests.some(request => request.method === "mount" && request.body.owner === reset.body.owner))
      await frame(page).locator("#ready").filter({ hasText: "ses_work" }).waitFor()
      await ask(page)
      await page.getByRole("button", { name: "Cancel", exact: true }).click()
      await page.getByRole("dialog").waitFor({ state: "detached" })
      assert.equal(backend.requests.filter(request => request.body.command === "userRemount").length, 1)
      // Five attempts already count: three cancellations, one cutoff refusal and
      // one request after trusted reset. Spend the rest on fixed catalogue refusals.
      for (let i = 0; i < 5; i++) {
        const ack = await frame(page).locator("body").evaluate(() => (window as any).call("attach", { integration: "missing", offerID: "offer_fixture" }))
        assert.equal(ack.outcome, "invalid")
      }
      assert.deepEqual(await busy(), { outcome: "busy" })
      await reload(page)
      await wait(() => backend.requests.filter(request => request.body.command === "userRemount").length === 2)
      await frame(page).locator("#ready").filter({ hasText: "ses_work" }).waitFor()
      assert.deepEqual(await busy(), { outcome: "busy" }, "trusted reset preserves the ten-attempt rate budget")
      await clean()
    } finally { await page.close() }
  }
})
