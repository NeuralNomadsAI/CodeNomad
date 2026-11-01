import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { chromium, type Browser, type Page, type Route } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { assertNoSentinels, FAKE_INTEGRATION_SENTINELS, findSentinels } from "../../../../scripts/fixtures/fake-integration/index.mjs"

let browser: Browser, url: string
const screenshots = process.env.CODENOMAD_ATTACHMENT_SCREENSHOTS
before(async () => {
  const fixture = await borrowFixture({ name: "integration-attachment", routes: [{ path: "/fixture", html:
    '<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/integration-attachment.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  if (screenshots) mkdirSync(screenshots, { recursive: true })
})
after(async () => { await browser?.close() })
const label = "Attach an open application…"
const call = (page: Page, method: string, ...args: unknown[]) => page.evaluate(([name, values]) => (window as any).integrationFixture[name as string](...(values as unknown[])), [method, args] as const)
const shell = (page: Page, method: string, ...args: unknown[]) => page.evaluate(([name, values]) => (window as any).fixture[name as string](...(values as unknown[])), [method, args] as const)
const sentinelPort = 49179
const privateHost = { ...FAKE_INTEGRATION_SENTINELS, port: sentinelPort }
const sentinelOptions = { port: sentinelPort }
const failureKinds = ["malformed-json", "raw-http-error", "json-http-error", "network-error"] as const
type FailureKind = typeof failureKinds[number]

function captureDiagnostics(page: Page) {
  const consoleEntries: Array<{ type: string; text: string; args: unknown[] }> = []
  const pageErrors: Array<{ message: string; stack?: string }> = []
  const pending: Promise<void>[] = []
  let serializationFailures = 0
  // Register before navigation, and keep every level, including debug/trace and browser network errors.
  page.on("console", message => {
    const entry = { type: message.type(), text: message.text(), args: [] as unknown[] }
    consoleEntries.push(entry)
    pending.push(Promise.all(message.args().map(argument => argument.evaluate(value =>
      JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Error
        ? { ...item, name: item.name, message: item.message, stack: item.stack } : item) ?? "null"),
    ))).then(args => { entry.args = args }, () => { serializationFailures++ }))
  })
  page.on("pageerror", error => pageErrors.push({ message: error.message, stack: error.stack }))
  const drain = async () => {
    for (let offset = 0; offset < pending.length;) {
      const batch = pending.slice(offset)
      offset += batch.length
      await Promise.all(batch)
    }
    assert.equal(serializationFailures, 0, "every console argument was serialized before teardown")
  }
  return { consoleEntries, pageErrors, drain, async check() {
    await drain()
    // The helper reports sentinel names only, never the secret-bearing diagnostic or Error.
    assertNoSentinels({ consoleEntries, pageErrors }, sentinelOptions, "renderer diagnostics")
    assert.equal(pageErrors.length, 0, "the real renderer raised no uncaught exceptions")
    assert.ok(consoleEntries.some(entry => entry.text.includes("session.messages")), "enabled renderer loggers emitted real HTTP/session diagnostics")
    assert.ok(consoleEntries.some(entry => entry.args.some(value => value && typeof value === "object")), "structured renderer diagnostics were observed")
  } }
}

async function failResponse(route: Route, kind: FailureKind) {
  if (kind === "network-error") return route.abort("connectionfailed")
  const body = JSON.stringify(privateHost)
  if (kind === "malformed-json") return route.fulfill({ contentType: "application/json", body: `{invalid:${body}` })
  if (kind === "raw-http-error") return route.fulfill({ status: 503, contentType: "text/plain", body })
  return route.fulfill({ status: 503, json: { code: FAKE_INTEGRATION_SENTINELS.bindingKey, error: privateHost } })
}
async function open(width = 1500) {
  const page = await browser.newPage({ viewport: { width, height: 850 } })
  page.setDefaultTimeout(20_000)
  const diagnostics = captureDiagnostics(page)
  // lib/logger has namespace switches rather than a separate severity threshold: enable all of them at boot.
  await page.addInitScript(() => localStorage.setItem("opencode:logger:namespaces", JSON.stringify(["sse", "api", "session", "actions", "foreground-refresh", "scroll"])))
  const calls: Array<{ action: string; directory: string | null; body: any }> = []
  const model = { state: "ok", offers: 1, family: "native", host: "ok", catalog: "fresh", association: 4, outcome: "attached", detachOutcome: "detached", removeCode: "", hold: undefined as Route | undefined, holdHosts: false, holdAttach: false, holdDetach: false,
    failure: undefined as { action: "read" | "hosts" | "attach" | "detach"; kind: FailureKind } | undefined }
  await page.route("**/api/**", async route => {
    const request = route.request(), parsed = new URL(request.url())
    if (parsed.pathname.endsWith("/plugin-sources") && request.method() === "DELETE" && model.removeCode) {
      return route.fulfill({ status: 409, json: { code: model.removeCode, error: "Removal refused" } })
    }
    const match = parsed.pathname.match(/\/integrations(?:\/blender\/(hosts|attach|detach))?$/)
    if (!match) return route.fulfill({ json: {} })
    const action = match[1] ?? "read"
    calls.push({ action, directory: parsed.searchParams.get("directory"), body: request.postDataJSON() })
    if (model.failure?.action === action) return failResponse(route, model.failure.kind)
    if (action === "hosts") {
      if (model.holdHosts) { model.hold = route; return }
      return route.fulfill({ json: { offers: [{ offerID: "offer-1", label: "Scene", document: "Scene.blend", protocol: "ok" }] } })
    }
    if (action === "attach" && model.holdAttach) { model.hold = route; return }
    if (action === "detach" && model.holdDetach) { model.hold = route; return }
    if (action === "attach" || action === "detach") return route.fulfill({ json: { outcome: action === "detach" ? model.detachOutcome : model.outcome } })
    return route.fulfill({ json: { location: { directory: "/repo" }, catalog: { state: model.catalog, fetchedAt: "2026-11-01T12:00:00Z" }, integrations: [{
      id: "blender", displayName: "OpenCode for Blender", app: { name: "Blender", versions: ">=5.2" }, family: model.family,
      configured: true, configuredSources: [{ scope: "global", entryIndex: model.association }], scopes: ["global"], state: model.state,
      status: { host: { state: model.host }, connection: { offers: model.offers, attachedSessions: 42, state: "attached" }, version: "1.0.0" },
    }] } })
  })
  const finish = async () => {
    try { await diagnostics.check() } finally { await page.close() }
  }
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).integrationFixture))
    await page.waitForFunction(() => document.querySelector(".session-header-expanded-actions"))
    assert.equal(await page.evaluate(() => (window as any).codenomadLogger.listLoggerNamespaces().every((entry: any) => entry.enabled)), true)
    return { page, calls, model, diagnostics, finish }
  } catch (error) { await finish(); throw error }
}
async function launch(page: Page) {
  const inline = page.locator(".session-header-expanded-actions").getByRole("button", { name: label, exact: true })
  await page.locator('.session-header-expanded-actions button[aria-label="Attach an open application…"]:visible, .session-header-actions-menu:visible').first().waitFor()
  if (await inline.isVisible()) await inline.click()
  else {
    await page.locator(".session-header-actions-menu:visible").click()
    await page.getByRole("menuitem", { name: label, exact: true }).click()
  }
  await page.getByRole("dialog", { name: label }).waitFor()
}
const echoes = async (page: Page) => {
  await call(page, "event", "rpc.neuralnomads.blender.status_changed")
  await call(page, "event", "session.updated", { sessionID: "session" })
}
async function held(model: { hold?: Route }) {
  for (let attempt = 0; attempt < 100 && !model.hold; attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(model.hold, "the fixed-target mutation reached the HTTP boundary")
  const route = model.hold
  model.hold = undefined
  return route
}
test("diagnostic capture detects sentinel text, structured arguments and Error stacks at every console level before navigation", async () => {
  const page = await browser.newPage()
  const diagnostics = captureDiagnostics(page)
  try {
    await page.addInitScript(host => {
      const error = new Error(host.token)
      error.stack += JSON.stringify(host)
      for (const level of ["debug", "log", "info", "warn", "error", "trace"] as const) {
        console[level](`capture self-check ${host.scriptHandle}`, { nested: host, error }, error)
      }
      setTimeout(() => { throw error }, 0)
    }, privateHost)
    const uncaught = page.waitForEvent("pageerror")
    await page.goto("data:text/html,<title>Diagnostic collector self-check</title>")
    await uncaught
    await diagnostics.drain()
    for (const type of ["debug", "log", "info", "warning", "error", "trace"]) {
      const entry = diagnostics.consoleEntries.find(entry => entry.type === type)
      assert.ok(entry, `captured console level ${type}`)
      assert.ok(findSentinels(entry.text, sentinelOptions).includes("scriptHandle"), "console text was captured")
      assert.deepEqual(findSentinels(entry.args, sentinelOptions).sort(), Object.keys(privateHost).sort(), "nested console arguments retain every sentinel for scanning")
      assert.deepEqual(findSentinels((entry.args[1] as any).error, sentinelOptions).sort(), Object.keys(privateHost).sort(), "Errors nested inside structured arguments retain their message and stack")
    }
    assert.deepEqual(findSentinels(diagnostics.pageErrors[0].message, sentinelOptions), ["token"], "uncaught messages are captured")
    assert.deepEqual(findSentinels(diagnostics.pageErrors[0].stack, sentinelOptions).sort(), Object.keys(privateHost).sort(), "uncaught stacks are captured")
    assert.deepEqual(findSentinels(diagnostics.pageErrors, sentinelOptions).sort(), Object.keys(privateHost).sort(), "uncaught message and stack are both scanned")
    assert.throws(() => assertNoSentinels(diagnostics.consoleEntries, sentinelOptions, "intentional capture self-check"), error => {
      // The negative control must fail without reproducing any secret in the runner's own output.
      assertNoSentinels(String(error), sentinelOptions, "leak assertion output")
      return true
    })
  } finally { try { await diagnostics.drain() } finally { await page.close() } }
})
test("real shell wide and narrow entries use a Cancel-focused trusted picker, exact Q8 matching, attach and local detach", async () => {
  for (const width of [1500, 390]) {
    const { page, calls, finish } = await open(width)
    try {
      await call(page, "hint", "other", "Scene")
      await launch(page)
      const dialog = page.getByRole("dialog", { name: label })
      assert.equal(await dialog.getByText(/Reattach/).count(), 0, "another integration's hint cannot offer reattach")
      assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).evaluate(el => el === document.activeElement), true)
      await page.keyboard.press("Enter")
      await dialog.waitFor({ state: "hidden" })
      assert.equal(calls.filter(call => call.action === "attach").length, 0)
      await call(page, "hint", "blender", "Scene")
      await launch(page)
      await dialog.getByRole("button", { name: /Reattach “Scene”/ }).waitFor()
      assert.match(await dialog.innerText(), /Fixture conversation/)
      assert.match(await dialog.innerText(), /modify the selected document/)
      assert.match(await dialog.innerText(), /remote machine/)
      assert.equal(await dialog.getByRole("button", { name: "Confirm attachment", exact: true }).isDisabled(), true)
      await dialog.getByRole("button", { name: /Reattach “Scene”/ }).click()
      const box = await dialog.boundingBox()
      assert.ok(box && box.x >= 0 && box.x + box.width <= width, "picker stays inside the viewport")
      assert.equal(await dialog.evaluate(el => getComputedStyle(el).backgroundColor === "rgba(0, 0, 0, 0)"), false, "trusted window has an opaque overlay surface")
      if (screenshots) await dialog.screenshot({ path: join(screenshots, `attachment-${width}.png`) })
      assert.equal(calls.filter(call => call.action === "attach").length, 0, "selecting never consents")
      await dialog.getByRole("button", { name: "Confirm reattach", exact: true }).click()
      await dialog.getByText(/This is a local observation/).waitFor()
      assert.deepEqual(calls.find(call => call.action === "attach"), { action: "attach", directory: "/repo", body: { sessionID: "session", offerID: "offer-1" } })
      await dialog.getByRole("button", { name: "Detach this conversation", exact: true }).click()
      await dialog.getByText(/Detach request completed here/).waitFor()
      await dialog.getByRole("button", { name: "OK", exact: true }).click()
      assert.deepEqual(calls.find(call => call.action === "detach")?.body, { sessionID: "session" })
    } finally { await finish() }
  }
})
test("native dispatcher coalesces events, reconciles reconnect/open, forgets stopped workspaces and never polls", async () => {
  const { page, calls, finish } = await open()
  try {
    await page.locator(".session-header-expanded-actions").getByRole("button", { name: label, exact: true }).waitFor()
    const reads = () => calls.filter(call => call.action === "read").length
    const before = reads()
    await call(page, "burst")
    await page.waitForTimeout(650)
    assert.equal(reads(), before + 1)
    await page.waitForTimeout(1000)
    assert.equal(reads(), before + 1, "no polling")
    await launch(page)
    await call(page, "reconnect")
    await page.getByRole("dialog", { name: label }).waitFor({ state: "hidden" })
    await page.waitForTimeout(200)
    assert.ok(reads() > before + 1)
    const reconnectReads = reads()
    await call(page, "open")
    await page.waitForTimeout(200)
    assert.ok(reads() > reconnectReads)
    await shell(page, "setActive", false)
    const hiddenReads = reads()
    await call(page, "burst")
    await page.waitForTimeout(650)
    assert.equal(reads(), hiddenReads, "native events do not read an inactive conversation")
    await shell(page, "setActive", true)
    await page.locator(".session-header-expanded-actions").getByRole("button", { name: label, exact: true }).waitFor()
    await call(page, "demandStopped")
    await page.waitForTimeout(100)
    assert.equal(await call(page, "snapshot"), "ready")
    await call(page, "stop")
    assert.equal(await call(page, "snapshot"), "loading")
  } finally { await finish() }
})
test("late hosts cannot retarget another conversation; busy/gone/refused remain actionable without replay", async () => {
  const { page, calls, model, finish } = await open()
  try {
    model.holdHosts = true
    await launch(page)
    await page.waitForTimeout(100)
    await shell(page, "addSession", "other")
    await shell(page, "selectSession", "other")
    await page.getByRole("dialog", { name: label }).waitFor({ state: "hidden" })
    await model.hold?.fulfill({ json: { offers: [{ offerID: "late", label: "Late", protocol: "ok" }] } }).catch(() => {})
    assert.equal(calls.filter(call => call.action === "attach").length, 0)
    model.holdHosts = false
    for (const outcome of ["busy", "gone", "refused"]) {
      model.outcome = outcome
      await launch(page)
      const dialog = page.getByRole("dialog", { name: label })
      await dialog.getByRole("button", { name: /Blender.*Scene/ }).click()
      await dialog.getByRole("button", { name: "Confirm attachment", exact: true }).click()
      await page.waitForTimeout(100)
      assert.ok((await dialog.getByRole("alert").innerText()).length > 20)
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    }
    assert.equal(calls.filter(call => call.action === "attach").length, 3)
    model.holdAttach = true
    await launch(page)
    await page.getByRole("dialog", { name: label }).getByRole("button", { name: /Blender.*Scene/ }).click()
    await page.getByRole("button", { name: "Confirm attachment", exact: true }).click()
    await page.waitForTimeout(100)
    await shell(page, "selectSession", "session")
    await page.getByRole("dialog", { name: label }).waitFor({ state: "hidden" })
    await model.hold?.fulfill({ json: { outcome: "attached" } })
    await page.waitForTimeout(100)
    assert.equal(await page.getByText(/This is a local observation/).count(), 0, "late mutation feedback never belongs to another session")
    assert.equal(calls.filter(call => call.action === "attach").at(-1)?.body.sessionID, "other")
  } finally { await finish() }
})
test("Plugins uses safe source association, displays catalog staleness, and unsupported WSL never reads hosts", async () => {
  const { page, calls, model, finish } = await open()
  try {
    await call(page, "plugins", true)
    const row = page.locator('[data-plugin-id="neuralnomads.blender"]')
    await row.getByRole("button").click()
    await page.getByRole("menuitem", { name: label, exact: true }).click()
    const dialog = page.getByRole("dialog", { name: label })
    await dialog.waitFor()
    assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).evaluate(el => el === document.activeElement), true)
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    for (const code of ["attached-sessions", "attachment-unverified"]) {
      model.removeCode = code
      await row.getByRole("button").click()
      await page.getByRole("menuitem", { name: "Remove from Global", exact: true }).click()
      await page.waitForTimeout(150)
      const history = await call(page, "toasts")
      assert.match(JSON.stringify(history), code === "attached-sessions" ? /Detach them in the application/ : /Enable the integration, refresh Plugins/)
    }
    model.association = 99
    await call(page, "event", "config.updated")
    await page.waitForTimeout(650)
    await row.getByRole("button").click()
    assert.equal(await page.getByRole("menuitem", { name: label, exact: true }).count(), 0, "a different source index cannot borrow an integration action")
    await page.keyboard.press("Escape")
    model.catalog = "stale"
    await call(page, "event", "config.updated")
    await page.getByText(/last valid catalog fetched at 2026-11-01/).waitFor()
    model.catalog = "unavailable"
    model.host = "unsupported"
    await call(page, "event", "plugin.updated")
    await page.getByText("Integration catalog unavailable. Refresh Plugins to try again.", { exact: true }).waitFor()
    await page.locator(".plugin-controls").getByText(/including unsupported WSL/).waitFor()
    const hostsBefore = calls.filter(call => call.action === "hosts").length
    await row.getByRole("button").click()
    assert.equal(await page.getByRole("menuitem", { name: label, exact: true }).count(), 0)
    await page.keyboard.press("Escape")
    await page.waitForTimeout(400)
    assert.equal(calls.filter(call => call.action === "hosts").length, hostsBefore)
  } finally { await finish() }
})
test("aggregate bindings and saved hints never enable attachment without active native offers", async () => {
  const { page, calls, model, finish } = await open()
  try {
    await call(page, "hint", "blender", "Scene")
    for (const variation of [{ state: "inactive" }, { state: "ok", family: "api" }, { family: "native", offers: 0 }]) {
      Object.assign(model, variation)
      await call(page, "event", "rpc.neuralnomads.blender.status_changed")
      await page.waitForTimeout(650)
      assert.equal(await page.locator(".session-header-expanded-actions").getByRole("button", { name: label, exact: true }).count(), 0)
    }
    assert.equal(calls.filter(call => call.action === "hosts" || call.action === "attach").length, 0)
  } finally { await finish() }
})
test("unrelated workspace and other-session native events preserve the picker and its explicit selection", async () => {
  const { page, calls, finish } = await open()
  try {
    await launch(page)
    const dialog = page.getByRole("dialog", { name: label })
    const offer = dialog.getByRole("button", { name: /Blender.*Scene/ })
    await offer.click()
    await call(page, "event", "rpc.neuralnomads.blender.status_changed", {}, "other-workspace")
    await call(page, "event", "session.updated", { sessionID: "other-session" })
    await call(page, "event", "session.updated", { sessionID: "session" }, "other-workspace")
    assert.equal(await dialog.isVisible(), true)
    assert.equal(await offer.getAttribute("aria-pressed"), "true")
    assert.equal(await dialog.getByRole("button", { name: "Confirm attachment", exact: true }).isEnabled(), true)
    assert.equal(calls.filter(call => call.action === "attach").length, 0)
    await call(page, "event", "session.updated", { sessionID: "session" })
    await dialog.waitFor({ state: "hidden" })
    assert.equal(calls.filter(call => call.action === "attach").length, 0, "a relevant pre-admission update expires the selection without consent")
  } finally { await finish() }
})
test("native echoes before and after attach and detach HTTP responses retain scoped local action receipts", async () => {
  for (const detachOutcome of ["detached", "none"]) {
    const { page, calls, model, finish } = await open()
    try {
      model.holdAttach = true
      model.holdDetach = true
      await launch(page)
      const dialog = page.getByRole("dialog", { name: label })
      await dialog.getByRole("button", { name: /Blender.*Scene/ }).click()
      await dialog.getByRole("button", { name: "Confirm attachment", exact: true }).click()
      const attach = await held(model)
      await echoes(page)
      await call(page, "reconnect")
      await dialog.getByText("Waiting for the application…", { exact: true }).waitFor()
      assert.match(await dialog.innerText(), /Blender Scene Scene.blend/)
      assert.match(await dialog.innerText(), /Fixture conversation/)
      await attach.fulfill({ json: { outcome: "attached" } })
      await dialog.getByText(/This is a local observation; the current binding cannot be checked/).waitFor()
      await echoes(page)
      await call(page, "open")
      await dialog.getByRole("button", { name: "Detach this conversation", exact: true }).waitFor()
      assert.equal(await dialog.getByRole("button", { name: "Detach this conversation", exact: true }).isEnabled(), true)
      assert.equal(await dialog.getByRole("button", { name: "Confirm attachment", exact: true }).count(), 0, "expired offers grant no new attach action")
      await dialog.getByRole("button", { name: "Detach this conversation", exact: true }).click()
      const detach = await held(model)
      await echoes(page)
      await dialog.getByText("Waiting for the application…", { exact: true }).waitFor()
      assert.equal(await dialog.getByRole("button", { name: "Detach this conversation", exact: true }).isDisabled(), true)
      await detach.fulfill({ json: { outcome: detachOutcome } })
      await dialog.getByText(/Detach request completed here.*local action receipt/).waitFor()
      await echoes(page)
      assert.equal(await dialog.isVisible(), true)
      assert.equal(await dialog.getByRole("button", { name: "Detach this conversation", exact: true }).count(), 0)
      assert.deepEqual(calls.filter(call => call.action === "attach" || call.action === "detach").map(call => call.body), [
        { sessionID: "session", offerID: "offer-1" }, { sessionID: "session" },
      ])
      await shell(page, "addSession", "other")
      await shell(page, "selectSession", "other")
      await dialog.waitFor({ state: "hidden" })
    } finally { await finish() }
  }
})
test("native echoes retain refused outcomes and transport errors, including a usable safe detach retry", async () => {
  const { page, calls, model, finish } = await open()
  try {
    model.holdAttach = true
    model.holdDetach = true
    for (const failure of ["busy", "gone", "refused", "http-error"]) {
      await launch(page)
      const dialog = page.getByRole("dialog", { name: label })
      await dialog.getByRole("button", { name: /Blender.*Scene/ }).click()
      await dialog.getByRole("button", { name: "Confirm attachment", exact: true }).click()
      const attach = await held(model)
      await echoes(page)
      await attach.fulfill(failure === "http-error" ? { status: 503, json: { code: "unavailable" } } : { json: { outcome: failure } })
      await dialog.getByRole("alert").filter({ hasText: /\S/ }).waitFor()
      const message = await dialog.getByRole("alert").innerText()
      await echoes(page)
      assert.equal(await dialog.getByRole("alert").innerText(), message)
      assert.equal(await dialog.getByRole("button", { name: "Detach this conversation", exact: true }).count(), 0)
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    }
    await launch(page)
    const dialog = page.getByRole("dialog", { name: label })
    await dialog.getByRole("button", { name: /Blender.*Scene/ }).click()
    await dialog.getByRole("button", { name: "Confirm attachment", exact: true }).click()
    await (await held(model)).fulfill({ json: { outcome: "attached" } })
    await dialog.getByRole("button", { name: "Detach this conversation", exact: true }).click()
    const detach = await held(model)
    await echoes(page)
    await detach.fulfill({ status: 503, json: { code: "unavailable" } })
    await dialog.getByRole("alert").filter({ hasText: /\S/ }).waitFor()
    await echoes(page)
    assert.equal(await dialog.getByRole("button", { name: "Detach this conversation", exact: true }).isEnabled(), true)
    assert.equal(calls.filter(call => call.action === "detach").length, 1, "an error never replays detach")
    await dialog.getByRole("button", { name: "Detach this conversation", exact: true }).click()
    await (await held(model)).fulfill({ json: { outcome: "none" } })
    await dialog.getByText(/Detach request completed here/).waitFor()
  } finally { await finish() }
})

for (const kind of failureKinds) test(`renderer confidentiality across ${kind}, native echoes, explicit retry and late navigation`, async () => {
  const { page, calls, model, diagnostics, finish } = await open()
  const count = (action: string) => calls.filter(call => call.action === action).length
  const header = page.locator(".session-header-expanded-actions").getByRole("button", { name: label, exact: true })
  const dialog = page.getByRole("dialog", { name: label })
  const alert = dialog.getByRole("alert").filter({ hasText: /\S/ })
  try {
    await header.waitFor()
    const reads = count("read")
    model.failure = { action: "read", kind }
    const failedRead = page.waitForEvent(kind === "network-error" ? "requestfailed" : "requestfinished", {
      predicate: request => new URL(request.url()).pathname.endsWith("/integrations"),
    })
    await call(page, "reconnect")
    await failedRead
    await page.waitForTimeout(100)
    assert.equal(count("read"), reads + 1)
    assert.equal(await header.count(), 0, "failed reads revoke stale attachment authority")
    model.failure = undefined
    await call(page, "reconnect")
    await header.waitFor()

    model.failure = { action: "hosts", kind }
    await launch(page)
    await alert.waitFor()
    assertNoSentinels(await dialog.innerText(), sentinelOptions, "hosts failure display")
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await echoes(page)
    await call(page, "reconnect")
    await header.waitFor()
    assert.equal(count("hosts"), 1, "closing and native refresh never replay a failed hosts request")
    assert.equal(count("attach"), 0)

    model.failure = { action: "attach", kind }
    await launch(page)
    await dialog.getByRole("button", { name: /Blender.*Scene/ }).click()
    await dialog.getByRole("button", { name: "Confirm attachment", exact: true }).click()
    await alert.waitFor()
    assertNoSentinels(await dialog.innerText(), sentinelOptions, "attach failure display")
    const attachMessage = await alert.innerText()
    await echoes(page)
    await call(page, "reconnect")
    await page.waitForTimeout(100)
    assert.equal(await alert.innerText() === attachMessage, true, "native echoes retain the safe failure message")
    assert.equal(count("attach"), 1, "failed attachment is never replayed")
    assert.equal(count("detach"), 0)
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()

    model.failure = undefined
    await launch(page)
    await dialog.getByRole("button", { name: /Blender.*Scene/ }).click()
    await dialog.getByRole("button", { name: "Confirm attachment", exact: true }).click()
    const detach = dialog.getByRole("button", { name: "Detach this conversation", exact: true })
    await detach.waitFor()
    model.failure = { action: "detach", kind }
    await detach.click()
    await alert.waitFor()
    assertNoSentinels(await dialog.innerText(), sentinelOptions, "detach failure display")
    await echoes(page)
    await call(page, "reconnect")
    await page.waitForTimeout(100)
    assert.equal(await detach.isEnabled(), true, "safe detach remains explicitly retryable")
    assert.equal(count("detach"), 1, "native refresh never replays failed detach")
    model.failure = undefined
    model.detachOutcome = "none"
    await detach.click()
    await dialog.getByText(/Detach request completed here/).waitFor()
    assert.equal(count("detach"), 2, "only the explicit click retries detach")
    await dialog.getByRole("button", { name: "OK", exact: true }).click()

    model.holdAttach = true
    await launch(page)
    await dialog.getByRole("button", { name: /Blender.*Scene/ }).click()
    await dialog.getByRole("button", { name: "Confirm attachment", exact: true }).click()
    const late = await held(model)
    await shell(page, "addSession", "other")
    await shell(page, "selectSession", "other")
    await dialog.waitFor({ state: "hidden" })
    await failResponse(late, kind)
    await page.waitForTimeout(100)
    assert.equal(await dialog.count(), 0, "late failures never publish into the next conversation")
    assert.equal(count("attach"), 3, "navigation never replays an admitted mutation")
    await diagnostics.drain()
    assert.ok(diagnostics.consoleEntries.some(entry => entry.text.includes("event batch")), "the real native dispatcher emitted safe SSE diagnostics")
  } finally { await finish() }
})
