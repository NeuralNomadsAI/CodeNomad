import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type Page, type Route } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { runWithDiagnosticCleanup } from "./fixture-diagnostic-boundary"
import { observeHeaderFixture } from "./header-fixture-diagnostics"
import { captureConsole, refuseUntaggedConsole, type ConsoleEntry } from "./fixture-console"
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

// Retain the original handle collector for its deferred-handle negative control.
function captureHandleControl(page: Page) {
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

async function captureDiagnostics(page: Page, record: (category: string, error: unknown) => void = () => {}) {
  const transport = await captureConsole(page, browser, { onCleanupError: error => record("console-init-cleanup-error", error) })
  const consoleEntries: ConsoleEntry[] = [], pageErrors = transport.pageErrors
  const coverageFailures: string[] = []
  const witness = (message: Parameters<typeof refuseUntaggedConsole>[0]) => {
    try { refuseUntaggedConsole(message, transport.token) }
    catch { coverageFailures.push("untagged-playwright-arguments") }
  }
  page.on("console", witness)
  let completed = false, checked = false
  const drain = async () => {
    if (completed) transport.reconcile(true)
    else await transport.fence()
    assert.equal(coverageFailures.length, 0, "every diagnostic belongs to a covered native target")
    consoleEntries.splice(0, consoleEntries.length, ...transport.consoleEntries())
  }
  const check = async () => {
    await drain()
    assertNoSentinels({ consoleEntries, pageErrors }, sentinelOptions, "renderer diagnostics")
    assert.equal(pageErrors.length, 0, "the real renderer raised no uncaught exceptions")
    assert.ok(consoleEntries.some(entry => entry.text.includes("session.messages")), "enabled renderer loggers emitted real HTTP/session diagnostics")
    assert.ok(consoleEntries.some(entry => entry.args.some(value => value && typeof value === "object")), "structured renderer diagnostics were observed")
    checked = true
  }
  return { consoleEntries, pageErrors, drain, check, transport, complete: () => runWithDiagnosticCleanup({
    run: async () => {
      await transport.complete()
      completed = true
      await drain()
      if (checked) await check()
    },
    diagnose: async () => {},
    cleanup: async () => { page.off("console", witness); await transport.abort() },
    onObservationError: () => {},
    onCleanupError: error => { record("console-observer-error", error); console.error("attachment-console-observer-cleanup-failed") },
  }) }
}

async function failResponse(route: Route, kind: FailureKind) {
  if (kind === "network-error") return route.abort("connectionfailed")
  const body = JSON.stringify(privateHost)
  if (kind === "malformed-json") return route.fulfill({ contentType: "application/json", body: `{invalid:${body}` })
  if (kind === "raw-http-error") return route.fulfill({ status: 503, contentType: "text/plain", body })
  return route.fulfill({ status: 503, json: { code: FAKE_INTEGRATION_SENTINELS.bindingKey, error: privateHost } })
}
async function prepareAttachment(page: Page, diagnostics: Awaited<ReturnType<typeof captureDiagnostics>>) {
  // lib/logger has namespace switches rather than a separate severity threshold: enable all of them at boot.
  await page.addInitScript(() => localStorage.setItem("opencode:logger:namespaces", JSON.stringify(["sse", "api", "session", "actions", "foreground-refresh", "scroll"])))
  // Drive transport status/open explicitly through ServerEvents, without incidental HTTP fixture reconnects.
  await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
  const calls: Array<{ action: string; directory: string | null; body: any; method?: string }> = []
  const model = { state: "ok", offers: 1, family: "native", host: "ok", catalog: "fresh", association: 4, outcome: "attached", detachOutcome: "detached", removeCode: "", hold: undefined as Route | undefined, holdHosts: false, holdAttach: false, holdDetach: false,
    binding: "none", bindingLabel: "Scene", bindingExtra: false, holdBinding: false, bindingRequests: [] as Route[], bindingBySession: {} as Record<string, { state: string; label?: string }>,
    hostAction: undefined as "install" | "update" | undefined, associationScope: "global", version: "1.0.0", installOutcome: "installed", holdInstall: false,
    failure: undefined as { action: "read" | "hosts" | "attach" | "detach" | "install-host" | "binding" | "remove"; kind: FailureKind } | undefined }
  await page.route("**/api/**", async route => {
    const request = route.request(), parsed = new URL(request.url())
    if (parsed.pathname.endsWith("/plugin-sources") && request.method() === "DELETE") {
      calls.push({ action: "remove", directory: null, body: request.postDataJSON(), method: request.method() })
      if (model.failure?.action === "remove") return failResponse(route, model.failure.kind)
      if (model.removeCode) return route.fulfill({ status: 409, json: { code: model.removeCode, error: "Removal refused" } })
      const body = request.postDataJSON()
      return route.fulfill({ json: { scope: body.scope, spec: body.target, reloadPending: true } })
    }
    const match = parsed.pathname.match(/\/integrations(?:\/blender\/(hosts|attach|detach|install-host|binding))?$/)
    if (!match) return route.fulfill({ json: {} })
    const action = match[1] ?? "read"
    calls.push({ action, directory: parsed.searchParams.get("directory"), body: request.postDataJSON(), ...(action === "install-host" ? { method: request.method() } : {}) })
    if (model.failure?.action === action) return failResponse(route, model.failure.kind)
    if (action === "binding") {
      if (model.holdBinding) { model.bindingRequests.push(route); return }
      const value = model.bindingBySession[parsed.searchParams.get("sessionID") ?? ""]
        ?? { state: model.binding, ...(model.binding === "attached" ? { label: model.bindingLabel } : {}) }
      return route.fulfill({ json: { ...value, ...(model.bindingExtra ? { authority: privateHost } : {}) } })
    }
    if (action === "hosts") {
      if (model.holdHosts) { model.hold = route; return }
      return route.fulfill({ json: { offers: [{ offerID: "offer-1", label: "Scene", document: "Scene.blend", protocol: "ok" }] } })
    }
    if (action === "attach" && model.holdAttach) { model.hold = route; return }
    if (action === "detach" && model.holdDetach) { model.hold = route; return }
    if (action === "install-host") {
      if (model.holdInstall) { model.hold = route; return }
      return route.fulfill({ json: { outcome: model.installOutcome } })
    }
    if (action === "attach" || action === "detach") {
      if (action === "attach" && model.outcome === "attached") model.binding = "attached"
      if (action === "detach") model.binding = "none"
      return route.fulfill({ json: { outcome: action === "detach" ? model.detachOutcome : model.outcome } })
    }
    return route.fulfill({ json: { location: { directory: "/repo" }, catalog: { state: model.catalog, fetchedAt: "2026-11-01T12:00:00Z" }, integrations: [{
      id: "blender", displayName: "OpenCode for Blender", app: { name: "Blender", versions: ">=5.2" }, family: model.family,
      configured: true, configuredSources: [{ scope: model.associationScope, entryIndex: model.association }], scopes: ["global"], state: model.state,
      status: { host: { state: model.host, ...(model.hostAction ? { action: model.hostAction } : {}) }, connection: { offers: model.offers, attachedSessions: 42, state: "attached" }, version: model.version },
    }] } })
  })
  const reload = async () => {
    await diagnostics.drain()
    await page.reload()
  }
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).integrationFixture))
  await page.waitForFunction(() => document.querySelector(".session-header-expanded-actions"))
  assert.equal(await page.evaluate(() => (window as any).codenomadLogger.listLoggerNamespaces().every((entry: any) => entry.enabled)), true)
  return { page, calls, model, diagnostics, reload }
}

async function withAttachment<T>(run: (fixture: Awaited<ReturnType<typeof prepareAttachment>>) => Promise<T>, width = 1500, height = 850) {
  let page: Page | undefined, diagnostics: Awaited<ReturnType<typeof captureDiagnostics>> | undefined
  let observer: ReturnType<typeof observeHeaderFixture> | undefined, evidenceDirectory: string | undefined
  let phase = "allocation", checking = false
  // Raw observations can contain private URLs and sentinels. Keep them only in owned TEMP evidence.
  const record = (category: string, value: unknown) => {
    try {
      evidenceDirectory ??= mkdtempSync(join(tmpdir(), "codenomad-attachment-failure-"))
      appendFileSync(join(evidenceDirectory, "diagnostics.private.jsonl"), JSON.stringify({ category, phase, value }, (_key, item) =>
        item instanceof Error ? { name: item.name, message: item.message, stack: item.stack, categories: (item as any).categories } : item) + "\n")
    } catch { console.error("attachment-evidence-write-failed") }
  }
  return runWithDiagnosticCleanup({
    run: async () => {
      try {
        page = await browser.newPage({ viewport: { width, height } })
        page.setDefaultTimeout(20_000)
        diagnostics = await captureDiagnostics(page, record)
        observer = observeHeaderFixture(page, "integrationFixture")
        await observer.install()
        phase = "bootstrap"
        const fixture = await prepareAttachment(page, diagnostics)
        phase = "body"
        const result = await run(fixture)
        phase = "diagnostics"
        checking = true
        await diagnostics.check()
        return result
      } catch (error) { record("primary", error); throw error }
    },
    diagnose: async () => {
      console.error("attachment-primary-failed", phase)
      try { await observer?.diagnose(message => record("snapshot", message)) }
      catch (error) { record("snapshot-error", error); console.error("attachment-snapshot-failed") }
      if (!checking) await diagnostics?.check()
    },
    cleanup: async () => {
      try {
        await runWithDiagnosticCleanup({
          run: async () => { try { await page?.close() } catch (error) { record("close-error", error); throw error } },
          diagnose: async () => {},
          cleanup: async () => { try { await diagnostics?.complete() } catch (error) { record("console-completion-error", error); throw error } },
          onObservationError: () => {},
          onCleanupError: () => console.error("attachment-console-completion-failed"),
        })
      }
      finally {
        observer?.detach()
        if (evidenceDirectory) record("resources", { pageClosed: page?.isClosed(), contextOwned: page ? browser.contexts().includes(page.context()) : false })
      }
    },
    onObservationError: error => { record("diagnostic-error", error); console.error("attachment-diagnostic-failed") },
    onCleanupError: () => console.error("attachment-close-failed"),
  })
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
const installLabel = "Install application integration…"
const bindingRow = (page: Page) => page.locator('[data-integration-binding="blender"]')
const bindingDetach = (page: Page) => bindingRow(page).getByRole("button", { name: "Detach this conversation", exact: true })
const updateLabel = "Update application integration…"
const pluginRow = (page: Page) => page.locator('[data-plugin-id="neuralnomads.blender"]')
async function refreshInstallation(page: Page) {
  await call(page, "event", "rpc.neuralnomads.blender.status_changed")
  await page.waitForTimeout(450)
}
async function installationMenu(page: Page) {
  await pluginRow(page).getByRole("button").click()
}
async function launchInstallation(page: Page, name = installLabel) {
  await installationMenu(page)
  await page.getByRole("menuitem", { name, exact: true }).click()
  const dialog = page.getByRole("dialog", { name, exact: true })
  await dialog.waitFor()
  return dialog
}
async function installationReady(page: Page, model: { host: string; hostAction?: "install" | "update"; offers: number }) {
  Object.assign(model, { host: "absent", hostAction: "install", offers: 0 })
  await call(page, "plugins", true)
  await refreshInstallation(page)
}
async function nextToast(page: Page, count: number) {
  await page.waitForFunction(count => (window as any).integrationFixture.toasts().length > count, count)
  return (await call(page, "toasts"))[0]
}

for (const stage of ["addInitScript", "goto", "waitForFunction"] as const)
test(`attachment boundary preserves ${stage} primary under diagnostic and close failures`, async t => {
  const page = await browser.newPage(), context = page.context(), close = page.close.bind(page)
  const primary = new Error("bootstrap primary"), stack = primary.stack, output: unknown[][] = []
  t.mock.method(console, "error", (...args: unknown[]) => { output.push(args) })
  t.mock.method(browser, "newPage", async () => page)
  if (stage === "addInitScript") t.mock.method(page, "addInitScript", async () => { throw primary })
  else {
    t.mock.method(page, "goto", async () => { if (stage === "goto") throw primary; return null })
    t.mock.method(page, "waitForFunction", async () => { throw primary })
  }
  const closing = t.mock.method(page, "close", async () => { await close(); throw new Error("close secondary") })
  try {
    await assert.rejects(withAttachment(async () => assert.fail("bootstrap must reject")), error => error === primary && (error as Error).stack === stack)
    assert.equal(page.isClosed(), true)
    assert.equal(browser.contexts().includes(context), false, "the owned newPage context is closed immediately")
    assert.equal(closing.mock.callCount(), 1)
    for (const event of ["requestfailed", "response", "framenavigated"]) assert.equal(page.listenerCount(event), 0, "the failure observer is detached")
    assert.deepEqual(output, [["attachment-primary-failed", stage === "addInitScript" ? "allocation" : "bootstrap"],
      ["attachment-diagnostic-failed"], ["attachment-close-failed"]])
  } finally { await close() }
})

test("attachment boundary preserves body primary and separates diagnostic and close failures", async t => {
  const primary = new Error("body primary"), stack = primary.stack, output: unknown[][] = []
  let ownedPage: Page | undefined
  t.mock.method(console, "error", (...args: unknown[]) => { output.push(args) })
  await assert.rejects(withAttachment(async ({ page }) => {
    ownedPage = page
    const close = page.close.bind(page)
    t.mock.method(page, "close", async () => { await close(); throw new Error("close secondary") })
    await page.evaluate(host => console.debug("private failure evidence", host), privateHost)
    throw primary
  }), error => error === primary && (error as Error).stack === stack)
  assert.equal(ownedPage?.isClosed(), true)
  assertNoSentinels(output, sentinelOptions, "public failure categories")
  assert.deepEqual(output, [["attachment-primary-failed", "body"], ["attachment-diagnostic-failed"], ["attachment-close-failed"]])
})

test("AC-C15 install/update uses exact source association and fresh active native status, without a session or offers", async () => {
  await withAttachment(async ({ page, model, calls }) => {
    await call(page, "sessionless", true)
    await installationReady(page, model)
    for (const variation of [
      { association: 99 }, { association: 4, associationScope: "project" },
      { associationScope: "global", state: "inactive" }, { state: "ok", family: "api" },
      { family: "native", host: "unknown" }, { host: "unsupported" },
      { host: "absent", hostAction: undefined }, { hostAction: "install", version: "" },
    ]) {
      Object.assign(model, variation)
      await refreshInstallation(page)
      await installationMenu(page)
      assert.equal(await page.getByRole("menuitem", { name: /^(Install|Update) application integration/ }).count(), 0)
      await page.keyboard.press("Escape")
    }
    model.version = "1.2.3"
    for (const [host, hostAction, name] of [["absent", "install", installLabel], ["outdated", "update", updateLabel]] as const) {
      Object.assign(model, { host, hostAction })
      await refreshInstallation(page)
      const dialog = await launchInstallation(page, name)
      assert.match(await dialog.innerText(), /Blender.*integration package version 1\.2\.3/s)
      assert.match(await dialog.innerText(), /machine where OpenCode runs.*remote/s)
      assert.match(await dialog.innerText(), /Installation does not attach a conversation/)
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    }
    assert.equal(calls.some(call => ["hosts", "attach", "detach", "install-host"].includes(call.action)), false)
  })
})

for (const [width, height, locale] of [[1500, 850, "en"], [390, 850, "en"], [390, 480, "en"], [390, 850, "he"]] as const)
test(`AC-C15 shared confirmation ${width}x${height} ${locale}: Cancel focus/ring and Enter/Cancel/Escape/backdrop never install`, async () => {
    await withAttachment(async ({ page, model, calls }) => {
      await installationReady(page, model)
      if (locale === "he") {
        await shell(page, "setLocale", "he")
        await page.waitForFunction(() => document.documentElement.dir === "rtl"
          && (window as any).integrationFixture.installLabel() !== "Install application integration…")
      }
      // Use the real translated row action and shared buttons for the Hebrew pass.
      const name = await call(page, "installLabel")
      for (const dismissal of ["Enter", "Cancel", "Escape", "backdrop"]) {
        const opener = await pluginRow(page).getByRole("button").elementHandle()
        const dialog = await launchInstallation(page, name)
        await call(page, "event", "plugin.updated", {}, "other-workspace")
        const cancel = dialog.locator("button.button-secondary")
        await page.waitForFunction(() => {
          const button = document.querySelector('.alert-dialog button.button-secondary')
          if (button !== document.activeElement || !button) return false
          const style = getComputedStyle(button)
          return style.outlineStyle !== "none" && style.outlineWidth !== "0px" && style.boxShadow !== "none"
        })
        assert.equal(await dialog.locator("button.button-primary").count(), 1)
        const box = await dialog.boundingBox()
        assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height, `${locale} confirmation fits ${width}x${height}`)
        if (dismissal === "Cancel") await cancel.click()
        else if (dismissal === "backdrop") await page.mouse.click(width - 2, height - 2)
        else await page.keyboard.press(dismissal)
        await dialog.waitFor({ state: "hidden" })
        await page.waitForFunction(element => element === document.activeElement, opener)
        assert.equal(calls.filter(call => call.action === "install-host").length, 0)
      }
    }, width, height)
})

const installInvalidations: Array<[string, (page: Page) => Promise<unknown>]> = [
  ["session navigation", async page => { await shell(page, "addSession", "other"); await shell(page, "selectSession", "other") }],
  ["session roundtrip", async page => { await shell(page, "addSession", "other"); await shell(page, "selectSession", "other"); await shell(page, "selectSession", "session") }],
  ["Location navigation", page => call(page, "directory", "/other-repo")],
  ["instance navigation", page => call(page, "instance", "other-workspace")],
  ["surface hiding", page => call(page, "plugins", false)],
  ["inactive surface", page => call(page, "active", false)],
  ...["plugin.updated", "config.updated", "rpc.neuralnomads.blender.status_changed"].map(type => [type, (page: Page) => call(page, "event", type)] as [string, (page: Page) => Promise<unknown>]),
  ["session invalidation", page => call(page, "event", "session.updated", { sessionID: "session" })],
  ["reconnect", page => call(page, "reconnect")],
  ["stream open", page => call(page, "open")],
  ["workspace stop", page => call(page, "stop", "installation-only")],
]
for (const [name, invalidate] of installInvalidations) test(`AC-C15 ${name} revokes preconsent without installer dispatch`, async () => {
  await withAttachment(async ({ page, model, calls }) => {
    // Stop the real Plugins demand without removing the unrelated imported shell's instance.
    if (name === "workspace stop") await call(page, "instance", "installation-only")
    await installationReady(page, model)
    const opener = await pluginRow(page).getByRole("button").elementHandle()
    const dialog = await launchInstallation(page)
    await invalidate(page)
    await dialog.waitFor({ state: "hidden", timeout: 3000 })
    await page.waitForTimeout(100)
    assert.equal(await opener!.evaluate(element => element === document.activeElement), false, "revoked consent never restores a stale opener")
    await page.keyboard.press("Enter")
    assert.equal(calls.filter(call => call.action === "install-host").length, 0)
  })
})

test("AC-C15 unrelated instance events retain consent; each projected outcome posts exactly one empty body to its captured Location", async () => {
  await withAttachment(async ({ page, model, calls }) => {
    await installationReady(page, model)
    await call(page, "directory", "/installation-repo")
    await page.waitForTimeout(450)
    for (const outcome of ["installed", "updated", "unchanged", "refused", "failed"]) {
      model.installOutcome = outcome
      const dialog = await launchInstallation(page)
      await call(page, "event", "plugin.updated", {}, "other-workspace")
      await call(page, "event", "rpc.neuralnomads.blender.status_changed", {}, "other-workspace")
      assert.equal(await dialog.isVisible(), true)
      const before = (await call(page, "toasts")).length
      await dialog.getByRole("button", { name: installLabel, exact: true }).click()
      const toast = await nextToast(page, before)
      assert.match(toast.message, new RegExp(outcome === "unchanged" ? "already up to date" : outcome))
      assert.equal(toast.variant, ["refused", "failed"].includes(outcome) ? "error" : "success")
      assertNoSentinels({ toast, dom: await page.locator("body").innerText() }, sentinelOptions, "installer result")
    }
    assert.deepEqual(calls.filter(call => call.action === "install-host"), Array.from({ length: 5 }, () => ({ action: "install-host", directory: "/installation-repo", body: {}, method: "POST" })))
    assert.equal(calls.some(call => ["hosts", "attach", "detach"].includes(call.action)), false)
  })
})

test("AC-C15 unsupported WSL hides installation while mirrored compatible status still handles route refusal safely", async () => {
  await withAttachment(async ({ page, model, calls }) => {
    await installationReady(page, model)
    model.host = "unsupported"
    await refreshInstallation(page)
    await page.locator(".plugin-controls").getByText(/including unsupported WSL/).waitFor()
    await installationMenu(page)
    assert.equal(await page.getByRole("menuitem", { name: installLabel, exact: true }).count(), 0)
    await page.keyboard.press("Escape")
    assert.equal(calls.filter(call => call.action === "install-host").length, 0)
    model.host = "absent"
    await refreshInstallation(page)
    model.holdInstall = true
    const dialog = await launchInstallation(page)
    const before = (await call(page, "toasts")).length
    await dialog.getByRole("button", { name: installLabel, exact: true }).click()
    await (await held(model)).fulfill({ status: 422, json: { code: "unsupported", error: privateHost } })
    const toast = await nextToast(page, before)
    assert.match(toast.message, /including WSL/)
    assert.equal(toast.variant, "error")
    assertNoSentinels({ toast, dom: await page.locator("body").innerText() }, sentinelOptions, "WSL refusal")
    assert.equal(calls.filter(call => call.action === "install-host").length, 1)
  })
})

for (const name of ["session navigation", "surface hiding"] as const) test(`AC-C15 held successful installation after ${name} never publishes wrong-view feedback or retries`, async () => {
  await withAttachment(async ({ page, model, calls }) => {
    await installationReady(page, model)
    model.holdInstall = true
    const dialog = await launchInstallation(page)
    const before = (await call(page, "toasts")).length
    await dialog.getByRole("button", { name: installLabel, exact: true }).click()
    const request = await held(model)
    // A pending installer cannot offer a second invocation in the same row.
    await installationMenu(page)
    assert.equal(await page.getByRole("menuitem", { name: installLabel, exact: true }).count(), 0)
    await page.keyboard.press("Escape")
    await installInvalidations.find(([value]) => value === name)![1](page)
    await request.fulfill({ json: { outcome: "installed" } })
    await page.waitForTimeout(200)
    assert.equal((await call(page, "toasts")).length, before, "an admitted result stays owned by its original live view")
    assert.equal(calls.filter(call => call.action === "install-host").length, 1)
  })
})

for (const kind of [...failureKinds, "invalid-outcome"] as const) test(`AC-C15 installer ${kind} is confidential, never replayed, and late navigation receives no feedback`, async () => {
  await withAttachment(async ({ page, model, calls }) => {
    await installationReady(page, model)
    if (kind === "invalid-outcome") model.installOutcome = FAKE_INTEGRATION_SENTINELS.token
    else model.failure = { action: "install-host", kind }
    const dialog = await launchInstallation(page)
    const before = (await call(page, "toasts")).length
    await dialog.getByRole("button", { name: installLabel, exact: true }).click()
    const toast = await nextToast(page, before)
    assert.match(toast.message, /outcome is uncertain.*Do not repeat.*Check the application/s)
    assert.equal(toast.variant, "error")
    assertNoSentinels({ toast, dom: await page.locator("body").innerText() }, sentinelOptions, "installer failure")
    await echoes(page)
    await call(page, "event", "plugin.updated")
    await call(page, "event", "config.updated")
    await call(page, "reconnect")
    await call(page, "open")
    await page.waitForTimeout(650)
    assert.equal(calls.filter(call => call.action === "install-host").length, 1, "native refresh never retries an uncertain installation")
    model.failure = undefined
    model.holdInstall = true
    const fresh = await launchInstallation(page)
    await fresh.getByRole("button", { name: installLabel, exact: true }).click()
    const late = await held(model)
    const toastCount = (await call(page, "toasts")).length
    await shell(page, "addSession", "other")
    await shell(page, "selectSession", "other")
    if (kind === "invalid-outcome") await late.fulfill({ json: { outcome: FAKE_INTEGRATION_SENTINELS.token, detail: privateHost } })
    else await failResponse(late, kind)
    await page.waitForTimeout(150)
    assert.equal((await call(page, "toasts")).length, toastCount, "late failures never publish into another conversation")
    assertNoSentinels(await page.locator("body").innerText(), sentinelOptions, "late installer failure")
    assert.equal(calls.filter(call => call.action === "install-host").length, 2, "a fresh explicit confirmation is the only second dispatch")
  })
})

async function checkDiagnosticCapture() {
  const page = await browser.newPage()
  let diagnostics: Awaited<ReturnType<typeof captureDiagnostics>> | undefined
  await runWithDiagnosticCleanup({ run: async () => {
    diagnostics = await captureDiagnostics(page)
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
    await diagnostics.drain()
  }, diagnose: async () => { await diagnostics?.drain() }, cleanup: () => runWithDiagnosticCleanup({
    run: () => page.close(), diagnose: async () => {}, cleanup: async () => { await diagnostics?.complete() },
    onObservationError: () => {}, onCleanupError: () => console.error("capture-control-completion-failed"),
  }),
  onObservationError: () => console.error("capture-control-diagnostic-failed"),
  onCleanupError: () => console.error("capture-control-close-failed") })
}
test("diagnostic capture detects sentinel text, structured arguments and Error stacks at every console level before navigation", checkDiagnosticCapture)
test("diagnostic capture control closes its owned page on transport initialization failure", async t => {
  const page = await browser.newPage(), context = page.context(), primary = new Error("capture initialization primary"), stack = primary.stack
  t.after(() => context.close())
  t.mock.method(browser, "newPage", async () => page)
  t.mock.method(context, "addInitScript", async () => { throw primary })
  await assert.rejects(checkDiagnosticCapture(), error => error === primary && (error as Error).stack === stack)
  assert.equal(page.isClosed(), true)
  assert.equal(browser.contexts().includes(context), false, "capture setup releases its owned context immediately")
})
for (const width of [1500, 390]) for (const entry of ["header", "plugins"])
test(`attachment cancellation returns to its exact ${entry} opener at ${width}px`, async () => {
  await withAttachment(async ({ page, calls }) => {
    if (entry === "plugins") await call(page, "plugins", true)
    for (const dismissal of ["Enter", "Cancel", "Escape"]) {
      const opener = entry === "plugins" ? pluginRow(page).getByRole("button")
        : page.locator('.session-header-expanded-actions button[aria-label="Attach an open application…"]:visible, .session-header-actions-menu:visible').first()
      await opener.waitFor()
      const actual = await opener.elementHandle()
      if (entry === "plugins") {
        await opener.click()
        await page.getByRole("menuitem", { name: label, exact: true }).click()
      } else await launch(page)
      const dialog = page.getByRole("dialog", { name: label })
      const cancel = dialog.getByRole("button", { name: "Cancel", exact: true })
      await call(page, "event", "plugin.updated", {}, "other-workspace")
      await page.waitForFunction(() => document.querySelector('.integration-attachment .button-secondary') === document.activeElement)
      if (dismissal === "Cancel") await cancel.click()
      else await page.keyboard.press(dismissal)
      await dialog.waitFor({ state: "hidden" })
      await page.waitForFunction(element => element === document.activeElement, actual)
    }
    assert.equal(calls.some(call => ["attach", "detach", "install-host"].includes(call.action)), false)
  }, width)
})
for (const width of [1500, 390]) for (const entry of ["header", "plugins"])
test(`attachment ${entry} restoration is fenced by navigation, invalidation and visibility at ${width}px`, async () => {
  for (const change of ["navigation", "roundtrip", "event", "hidden", "disabled", "detached"]) {
    await withAttachment(async ({ page }) => {
      if (entry === "plugins") await call(page, "plugins", true)
      const trigger = entry === "plugins" ? pluginRow(page).getByRole("button")
        : page.locator('.session-header-expanded-actions button[aria-label="Attach an open application…"]:visible, .session-header-actions-menu:visible').first()
      await trigger.waitFor()
      const opener = await trigger.elementHandle()
      if (entry === "plugins") {
        await trigger.click()
        await page.getByRole("menuitem", { name: label, exact: true }).click()
      } else await launch(page)
      const dialog = page.getByRole("dialog", { name: label })
      await dialog.waitFor()
      if (change === "navigation" || change === "roundtrip") {
        await shell(page, "addSession", "other")
        await shell(page, "selectSession", "other")
        if (change === "roundtrip") await shell(page, "selectSession", "session")
      } else if (change === "event") await call(page, "event", "rpc.neuralnomads.blender.status_changed")
      else {
        await opener!.evaluate((element, change) => {
          if (change === "hidden") (element as HTMLElement).style.visibility = "hidden"
          else if (change === "disabled") (element as HTMLButtonElement).disabled = true
          else element.remove()
        }, change)
        await page.keyboard.press("Escape")
      }
      await dialog.waitFor({ state: "hidden" })
      await page.waitForTimeout(100)
      assert.equal(await opener!.evaluate(element => element === document.activeElement), false, `${change} must not restore stale focus`)
    }, width)
  }
})
for (const width of [1500, 390]) test(`installation never restores a hidden, disabled or detached opener at ${width}px`, async () => {
  for (const change of ["hidden", "disabled", "detached"]) {
    await withAttachment(async ({ page, model }) => {
      await installationReady(page, model)
      const opener = await pluginRow(page).getByRole("button").elementHandle()
      const dialog = await launchInstallation(page)
      await opener!.evaluate((element, change) => {
        if (change === "hidden") (element as HTMLElement).style.display = "none"
        else if (change === "disabled") (element as HTMLButtonElement).disabled = true
        else element.remove()
      }, change)
      await page.keyboard.press("Escape")
      await dialog.waitFor({ state: "hidden" })
      await page.waitForTimeout(100)
      assert.equal(await opener!.evaluate(element => element === document.activeElement), false)
    }, width)
  }
})
for (const action of ["attachment", "installation"]) test(`${action} changed integration digest suppresses opener restoration`, async () => {
  await withAttachment(async ({ page, model }) => {
    if (action === "installation") await installationReady(page, model)
    const opener = await (action === "installation" ? pluginRow(page).getByRole("button")
      : page.locator('.session-header-expanded-actions button[aria-label="Attach an open application…"]')).elementHandle()
    if (action === "installation") await launchInstallation(page)
    else await launch(page)
    model.version = "9.9.9"
    // Change the read model without an epoch event, exercising the captured digest independently.
    await call(page, "refresh")
    const dialog = page.getByRole("dialog")
    if (action === "attachment") await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "hidden" })
    await page.waitForTimeout(100)
    assert.equal(await opener!.evaluate(element => element === document.activeElement), false)
  })
})
test("real shell wide and narrow entries use a Cancel-focused trusted picker, exact Q8 matching, attach and local detach", async () => {
  for (const width of [1500, 390]) {
    await withAttachment(async ({ page, calls }) => {
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
       await dialog.getByText(/Attachment request completed here/).waitFor()
      assert.deepEqual(calls.find(call => call.action === "attach"), { action: "attach", directory: "/repo", body: { sessionID: "session", offerID: "offer-1" } })
      await dialog.getByRole("button", { name: "Detach this conversation", exact: true }).click()
      await dialog.getByText(/Detach request completed here/).waitFor()
      await dialog.getByRole("button", { name: "OK", exact: true }).click()
      assert.deepEqual(calls.find(call => call.action === "detach")?.body, { sessionID: "session" })
    }, width)
  }
})
test("native dispatcher coalesces events, reconciles reconnect/open, forgets stopped workspaces and never polls", async () => {
  await withAttachment(async ({ page, calls }) => {
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
  })
})
test("late hosts cannot retarget another conversation; busy/gone/refused remain actionable without replay", async () => {
  await withAttachment(async ({ page, calls, model }) => {
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
    assert.equal(await page.getByText(/Attachment request completed here/).count(), 0, "late mutation feedback never belongs to another session")
    assert.equal(calls.filter(call => call.action === "attach").at(-1)?.body.sessionID, "other")
  })
})
test("Plugins uses safe source association, displays catalog staleness, and unsupported WSL never reads hosts", async () => {
  await withAttachment(async ({ page, calls, model }) => {
    await call(page, "plugins", true)
    const row = page.locator('[data-plugin-id="neuralnomads.blender"]')
    await row.getByRole("button").click()
    await page.getByRole("menuitem", { name: label, exact: true }).click()
    const dialog = page.getByRole("dialog", { name: label })
    await dialog.waitFor()
    assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).evaluate(el => el === document.activeElement), true)
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    for (const code of ["stale"]) {
      model.removeCode = code
      await row.getByRole("button").click()
      await page.getByRole("menuitem", { name: "Remove from Global", exact: true }).click()
      const removal = page.getByRole("dialog", { name: /Remove from Global/ })
      await removal.waitFor()
      await page.waitForTimeout(650)
      await removal.getByRole("button", { name: "Remove from Global", exact: true }).click()
      await page.waitForTimeout(150)
      const history = await call(page, "toasts")
      assert.match(JSON.stringify(history), /changed in the Global configuration/)
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
  })
})
for (const kind of failureKinds) test(`D25 removal ${kind}: confidential uncertainty, one submission and no detach`, async () => {
  await withAttachment(async ({ page, calls, model }) => {
    await call(page, "plugins", true)
    model.binding = "attached"
    model.failure = { action: "remove", kind }
    const row = page.locator('[data-plugin-id="neuralnomads.blender"]')
    await row.getByRole("button").click()
    await page.getByRole("menuitem", { name: "Remove from Global", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: /Remove from Global/ })
    await dialog.waitFor()
    assert.match(await dialog.innerText(), /other projects/)
    await page.waitForTimeout(650)
    await dialog.getByRole("button", { name: "Remove from Global", exact: true }).click()
    await page.waitForFunction(() => JSON.stringify((window as any).integrationFixture.toasts()).includes("could not be confirmed"))
    await call(page, "event", "plugin.updated")
    await call(page, "event", "config.updated")
    await page.waitForTimeout(400)
    assert.equal(calls.filter(call => call.action === "remove").length, 1)
    assert.equal(calls.filter(call => ["detach", "attach"].includes(call.action)).length, 0)
    assert.equal(model.binding, "attached")
  })
})

test("aggregate bindings and saved hints never enable attachment without active native offers", async () => {
  await withAttachment(async ({ page, calls, model }) => {
    await call(page, "hint", "blender", "Scene")
    for (const variation of [{ state: "inactive" }, { state: "ok", family: "api" }, { family: "native", offers: 0 }]) {
      Object.assign(model, variation)
      await call(page, "event", "rpc.neuralnomads.blender.status_changed")
      await page.waitForTimeout(650)
      assert.equal(await page.locator(".session-header-expanded-actions").getByRole("button", { name: label, exact: true }).count(), 0)
    }
    assert.equal(calls.filter(call => call.action === "hosts" || call.action === "attach").length, 0)
  })
})
test("unrelated workspace and other-session native events preserve the picker and its explicit selection", async () => {
  await withAttachment(async ({ page, calls }) => {
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
  })
})
test("native echoes before and after attach and detach HTTP responses retain scoped local action receipts", async () => {
  for (const detachOutcome of ["detached", "none"]) {
    await withAttachment(async ({ page, calls, model }) => {
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
      model.binding = "attached"
      await attach.fulfill({ json: { outcome: "attached" } })
      await dialog.getByText(/Attachment request completed here/).waitFor()
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
      model.binding = "none"
      await detach.fulfill({ json: { outcome: detachOutcome } })
      await dialog.getByText(/Detach request completed here/).waitFor()
      await echoes(page)
      assert.equal(await dialog.isVisible(), true)
      assert.equal(await dialog.getByRole("button", { name: "Detach this conversation", exact: true }).count(), 0)
      assert.deepEqual(calls.filter(call => call.action === "attach" || call.action === "detach").map(call => call.body), [
        { sessionID: "session", offerID: "offer-1" }, { sessionID: "session" },
      ])
      await shell(page, "addSession", "other")
      await shell(page, "selectSession", "other")
      await dialog.waitFor({ state: "hidden" })
    })
  }
})
test("native echoes retain refused outcomes and transport errors, including a usable safe detach retry", async () => {
  await withAttachment(async ({ page, calls, model }) => {
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
    model.binding = "attached"
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
    model.binding = "none"
    await (await held(model)).fulfill({ json: { outcome: "none" } })
    await dialog.getByText(/Detach request completed here/).waitFor()
  })
})

for (const kind of failureKinds) test(`renderer confidentiality across ${kind}, native echoes, explicit retry and late navigation`, async () => {
  await withAttachment(async ({ page, calls, model, diagnostics }) => {
    const count = (action: string) => calls.filter(call => call.action === action).length
    const header = page.locator(".session-header-expanded-actions").getByRole("button", { name: label, exact: true })
    const dialog = page.getByRole("dialog", { name: label })
    const alert = dialog.getByRole("alert").filter({ hasText: /\S/ })
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
  })
})

for (const width of [1500, 390]) test(`AC-C12 durable binding outside overflow at ${width}px: external authority, safe bounded label, Q8 and none/unknown`, async () => {
  await withAttachment(async ({ page, calls, model }) => {
    await page.waitForFunction(() => Boolean(document.querySelector('.session-header-expanded-actions')))
    await page.waitForTimeout(100)
    assert.equal(await bindingRow(page).count(), 0, "authoritative none has no indicator")
    await call(page, "hint", "blender", "Scene")
    assert.equal(await bindingRow(page).count(), 0, "Q8 grants neither an indicator nor Detach")
    model.binding = "attached"
    model.bindingLabel = `אבג <img onerror=alert(1)> ${"W".repeat(90)}`
    await call(page, "event", "rpc.neuralnomads.blender.hosts_changed")
    await bindingDetach(page).waitFor()
    const row = bindingRow(page), label = row.locator(".integration-binding-label")
    assert.match(await row.innerText(), /Blender/)
    assert.equal(await row.locator("img, script").count(), 0, "labels render as text")
    assert.equal(await label.locator("bdi").count(), 2)
    assert.ok((await label.getAttribute("title"))?.includes(model.bindingLabel), "full label stays accessible")
    assert.equal(await label.getAttribute("title"), await label.getAttribute("aria-label"))
    assert.equal(await row.evaluate(el => Boolean(el.closest('.session-header-expanded-actions, [role="menu"]'))), false)
    const box = await row.boundingBox()
    assert.ok(box && box.x >= 0 && box.x + box.width <= width, "durable row stays within the viewport")
    assert.equal(await label.evaluate(el => getComputedStyle(el).textOverflow), "ellipsis")
    assert.equal(await label.evaluate(el => el.scrollWidth > el.clientWidth), true, "long label is visibly truncated")
    assert.equal(calls.filter(call => call.action === "hosts" || call.action === "attach").length, 0, "external native attach needs no local receipt")
    await bindingDetach(page).click()
    await row.waitFor({ state: "hidden" })
    assert.deepEqual(calls.find(call => call.action === "detach")?.body, { sessionID: "session" })
    model.binding = "unknown"
    await call(page, "event", "rpc.neuralnomads.blender.status_changed")
    await row.getByText(/Binding unknown/).waitFor()
    assert.equal(await bindingDetach(page).count(), 0)
    model.binding = "none"
    await call(page, "event", "plugin.updated")
    await row.waitFor({ state: "hidden" })
  }, width)
})

test("AC-C12 reload restores a live binding without Q8 or an action receipt and reads external detachment afresh", async () => {
  await withAttachment(async ({ page, model, calls, reload }) => {
    model.binding = "attached"
    model.bindingLabel = "Restored scene"
    await reload()
    await bindingDetach(page).waitFor()
    assert.match(await bindingRow(page).innerText(), /Restored scene/)
    assert.equal(calls.filter(call => call.action === "attach").length, 0, "reload never replays attachment")
    model.binding = "none"
    const freshRead = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/binding"))
    await reload()
    await page.waitForFunction(() => Boolean((window as any).integrationFixture))
    await freshRead
    assert.equal(await bindingRow(page).count(), 0, "no saved UI authority survives reload")
    assert.equal(calls.filter(call => call.action === "detach").length, 0, "external detachment is a read, never a replay")
  })
})

test("diagnostic capture retains real dispatcher output after drain while the original handle control rejects document death", async () => {
  await withAttachment(async ({ page, diagnostics }) => {
    const legacy = captureHandleControl(page)
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    page.prependListener("console", message => {
      if (!message.text().includes("event batch")) return
      const argument = message.args()[4], evaluate = argument.evaluate.bind(argument)
      argument.evaluate = async (expression, arg) => { started.resolve(); await release.promise; return evaluate(expression, arg) }
    })
    await diagnostics.drain()
    await legacy.drain()
    try {
      await call(page, "event", "session.updated", { sessionID: "other-session" })
      await started.promise
      await page.reload()
      release.resolve()
      await assert.rejects(legacy.drain, error => error instanceof assert.AssertionError && error.actual === 1 && error.expected === 0
        && error.message.includes("every console argument was serialized before teardown"))
      await page.waitForFunction(() => Boolean((window as any).integrationFixture))
      await diagnostics.drain()
      const entry = diagnostics.consoleEntries.find(entry => entry.text.includes("event batch") && entry.args.some((value: any) => value?.size === 1))
      assert.ok(entry, "the actual dispatcher message emitted after drain retained its structured value")
      const snapshot = diagnostics.transport.snapshots.get(entry.id!)
      assert.equal(diagnostics.transport.history.get(snapshot.uniqueId).retired, true)
    } finally { release.resolve() }
  })
})

test("diagnostic capture drains a delayed structured argument before fixture reload", async () => {
  await withAttachment(async ({ page, diagnostics: captured, reload }) => {
    const diagnostics = captureHandleControl(page), authorityDrain = captured.drain
    captured.drain = async () => { await diagnostics.drain(); await authorityDrain() }
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    page.prependListener("console", message => {
      if (!message.text().startsWith("delayed reload diagnostic")) return
      const argument = message.args()[1], evaluate = argument.evaluate.bind(argument)
      argument.evaluate = async (expression, arg) => {
        started.resolve()
        await release.promise
        return evaluate(expression, arg)
      }
    })
    const drain = diagnostics.drain
    // Hold the real JSHandle until the boundary drains it, or navigation destroys its context.
    diagnostics.drain = () => { release.resolve(); return drain() }
    page.once("framenavigated", () => release.resolve())
    try {
      await page.evaluate(() => console.debug("delayed reload diagnostic", { nested: { value: "retained" }, error: new Error("retained error") }))
      await started.promise
      await reload()
      await page.waitForFunction(() => Boolean((window as any).integrationFixture))
      await diagnostics.drain()
      const entry = diagnostics.consoleEntries.find(entry => entry.text.startsWith("delayed reload diagnostic"))!
      assert.deepEqual((entry.args[1] as any).nested, { value: "retained" })
      assert.equal((entry.args[1] as any).error.message, "retained error")
      assert.match((entry.args[1] as any).error.stack, /Error: retained error/)
    } finally { release.resolve() }
  })
})

test("AC-C12 pending binding reads cannot publish into another session/Location or revive revoked authority", async () => {
  await withAttachment(async ({ page, calls, model }) => {
    model.binding = "attached"
    await call(page, "event", "rpc.neuralnomads.blender.status_changed")
    await bindingDetach(page).waitFor()
    model.holdBinding = true
    await call(page, "event", "config.updated")
    assert.equal(await bindingDetach(page).count(), 0, "invalidation revokes Detach before debounce")
    await page.waitForTimeout(350)
    assert.equal(model.bindingRequests.length, 1)
    await shell(page, "addSession", "other")
    await shell(page, "selectSession", "other")
    await page.waitForTimeout(100)
    assert.equal(model.bindingRequests.length, 2)
    await model.bindingRequests[0]!.fulfill({ json: { state: "attached", label: "Obsolete" } }).catch(() => {})
    await model.bindingRequests[1]!.fulfill({ json: { state: "none" } })
    await bindingRow(page).waitFor({ state: "hidden" })
    assert.equal(await page.getByText("Obsolete", { exact: true }).count(), 0)
    await call(page, "move", "other", "/worktree")
    await page.waitForTimeout(100)
    assert.equal(calls.filter(call => call.action === "binding").at(-1)?.directory, "/worktree")
    await model.bindingRequests[2]!.fulfill({ json: { state: "attached", label: "Moved" } })
    await bindingDetach(page).waitFor()
    assert.match(await bindingRow(page).innerText(), /Moved/)
    await call(page, "disconnect")
    assert.equal(await bindingDetach(page).count(), 0)
    await call(page, "reconnect")
    await page.waitForTimeout(100)
    await call(page, "open")
    await model.bindingRequests[3]!.fulfill({ json: { state: "attached", label: "Pre-open" } })
    await page.waitForTimeout(100)
    assert.equal(await bindingDetach(page).count(), 0, "pre-open answer is fenced")
    await model.bindingRequests[4]!.fulfill({ json: { state: "none" } })
    await bindingRow(page).waitFor({ state: "hidden" })
    assert.equal(calls.some(call => call.action === "detach"), false)
  })
})

test("AC-C12 receipts never grant Detach: fresh authority controls the picker, expiry/revocation and uncertain mutations reconcile once", async () => {
  await withAttachment(async ({ page, calls, model }) => {
    model.holdAttach = true
    await launch(page)
    const dialog = page.getByRole("dialog", { name: label })
    await dialog.getByRole("button", { name: /Blender.*Scene/ }).click()
    await dialog.getByRole("button", { name: "Confirm attachment", exact: true }).click()
    await (await held(model)).fulfill({ json: { outcome: "attached" } })
    await dialog.getByText(/Attachment request completed here/).waitFor()
    await page.waitForTimeout(100)
    assert.equal(await dialog.getByRole("button", { name: "Detach this conversation", exact: true }).count(), 0, "successful receipt with authoritative none grants nothing")
    model.binding = "attached"
    await call(page, "event", "rpc.neuralnomads.blender.status_changed")
    const detach = dialog.getByRole("button", { name: "Detach this conversation", exact: true })
    await detach.waitFor()
    model.binding = "unknown"
    await call(page, "event", "rpc.neuralnomads.blender.hosts_changed")
    assert.equal(await detach.count(), 0, "expiry immediately revokes picker Detach")
    model.binding = "attached"
    await call(page, "reconnect")
    await detach.waitFor()
    model.holdBinding = true
    model.failure = { action: "detach", kind: "network-error" }
    const before = calls.filter(call => call.action === "binding").length
    await detach.click()
    await dialog.getByRole("alert").filter({ hasText: /\S/ }).waitFor()
    assert.equal(await detach.count(), 0, "an uncertain mutation cannot retain authority")
    await page.waitForTimeout(100)
    assert.equal(calls.filter(call => call.action === "binding").length, before + 1, "finally reads once without native echoes")
    await model.bindingRequests[0]!.fulfill({ json: { state: "none" } })
    await call(page, "event", "rpc.neuralnomads.blender.status_changed")
    await page.waitForTimeout(350)
    assert.equal(calls.filter(call => call.action === "detach").length, 1, "no automatic mutation replay")
  })
})

for (const kind of [...failureKinds, "extra-fields", "oversized-label"] as const) test(`AC-C12 binding ${kind} revokes attached and keeps renderer diagnostics confidential`, async () => {
  await withAttachment(async ({ page, model }) => {
    model.binding = "attached"
    await call(page, "reconnect")
    await bindingDetach(page).waitFor()
    if (kind === "extra-fields") model.bindingExtra = true
    else if (kind === "oversized-label") model.bindingLabel = "x".repeat(121)
    else model.failure = { action: "binding", kind }
    await call(page, "reconnect")
    await bindingRow(page).getByText(/Binding unknown/).waitFor()
    await page.waitForTimeout(100)
    assert.equal(await bindingDetach(page).count(), 0)
    assertNoSentinels(await page.locator("body").innerText(), sentinelOptions, "binding error display")
    model.bindingExtra = false; model.bindingLabel = "Scene"; model.failure = undefined
    await call(page, "open")
    await bindingDetach(page).waitFor()
  })
})

for (const disconnect of ["disconnect", "transportDisconnect"]) test(`AC-C12 ${disconnect} aborts dirty trailing work until reconnect`, async () => {
  await withAttachment(async ({ page, model, calls }) => {
    model.binding = "attached"
    await call(page, "reconnect")
    await bindingDetach(page).waitFor()
    model.holdBinding = true
    await call(page, "event", "config.updated")
    await page.waitForTimeout(350)
    await call(page, "event", "plugin.updated")
    await page.waitForTimeout(350)
    const reads = calls.filter(call => call.action === "binding").length
    await call(page, disconnect)
    assert.equal(await bindingDetach(page).count(), 0)
    await model.bindingRequests[0]!.fulfill({ json: { state: "attached", label: "Stale" } }).catch(() => {})
    await call(page, "event", "rpc.neuralnomads.blender.hosts_changed")
    await page.waitForTimeout(400)
    assert.equal(calls.filter(call => call.action === "binding").length, reads, "disconnected work cannot revive authority")
    assert.equal(await bindingDetach(page).count(), 0)
    model.holdBinding = false
    await call(page, disconnect === "disconnect" ? "reconnect" : "open")
    await bindingDetach(page).waitFor()
  })
})
