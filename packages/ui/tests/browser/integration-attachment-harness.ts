import assert from "node:assert/strict"
import { after, before } from "node:test"
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type Page, type Route } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { runWithDiagnosticCleanup } from "./fixture-diagnostic-boundary"
import { observeHeaderFixture } from "./header-fixture-diagnostics"
import { captureConsole, refuseUntaggedConsole, type ConsoleEntry } from "./fixture-console"
import { assertNoSentinels, FAKE_INTEGRATION_SENTINELS } from "../../../../scripts/fixtures/fake-integration/index.mjs"

export let browser: Browser
let url: string
export const screenshots = process.env.CODENOMAD_ATTACHMENT_SCREENSHOTS
/** Registers the shared fixture and browser of one test file. */
export function useAttachmentBrowser() {
  before(async () => {
    const fixture = await borrowFixture({ name: "integration-attachment", routes: [{ path: "/fixture", html:
      '<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/integration-attachment.tsx"></script></body></html>' }] })
    url = fixture.url
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
    armFixtureNavigationBudget(browser)
    if (screenshots) mkdirSync(screenshots, { recursive: true })
  })
  after(async () => { await browser?.close() })
}

export const pickerTitle = "Attach an application"
export const installLabel = "Install in application…"
export const updateLabel = "Update application…"
export const call = (page: Page, method: string, ...args: unknown[]) => page.evaluate(([name, values]) => (window as any).integrationFixture[name as string](...(values as unknown[])), [method, args] as const)
export const shell = (page: Page, method: string, ...args: unknown[]) => page.evaluate(([name, values]) => (window as any).fixture[name as string](...(values as unknown[])), [method, args] as const)
export const sentinelPort = 49179
export const privateHost = { ...FAKE_INTEGRATION_SENTINELS, port: sentinelPort }
export const sentinelOptions = { port: sentinelPort }
export const failureKinds = ["malformed-json", "raw-http-error", "json-http-error", "network-error"] as const
export type FailureKind = typeof failureKinds[number]
export type Action = "read" | "hosts" | "attach" | "detach" | "install-host" | "binding" | "remove"

// Retain the original handle collector for its deferred-handle negative control.
export function captureHandleControl(page: Page) {
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

export async function captureDiagnostics(page: Page, record: (category: string, error: unknown) => void = () => {}) {
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

export async function failResponse(route: Route, kind: FailureKind) {
  if (kind === "network-error") return route.abort("connectionfailed")
  const body = JSON.stringify(privateHost)
  if (kind === "malformed-json") return route.fulfill({ contentType: "application/json", body: `{invalid:${body}` })
  if (kind === "raw-http-error") return route.fulfill({ status: 503, contentType: "text/plain", body })
  return route.fulfill({ status: 503, json: { code: FAKE_INTEGRATION_SENTINELS.bindingKey, error: privateHost } })
}

export type Call = { action: string; directory: string | null; body: any; method?: string; sessionID?: string | null }
export interface PrepareOptions { status?: boolean; locale?: "en" | "he" }

async function prepareAttachment(page: Page, diagnostics: Awaited<ReturnType<typeof captureDiagnostics>>, options: PrepareOptions) {
  // lib/logger has namespace switches rather than a separate severity threshold: enable all of them at boot.
  await page.addInitScript(() => localStorage.setItem("opencode:logger:namespaces", JSON.stringify(["sse", "api", "session", "actions", "foreground-refresh", "scroll"])))
  // Drive transport status/open explicitly through ServerEvents, without incidental HTTP fixture reconnects.
  await page.addInitScript(() => { (window as any).EventSource = class { addEventListener() {} removeEventListener() {} close() {} } })
  // The right panel opens on its Status tab only when a test asks for it.
  await page.addInitScript(status => localStorage.setItem("opencode-session-right-panel-tab-v2", status ? "status" : "files"), options.status !== false)
  const calls: Call[] = []
  const model = { state: "ok", offers: 1, family: "native", host: "ok", catalog: "fresh", association: 4, outcome: "attached", detachOutcome: "detached", removeCode: "", hold: undefined as Route | undefined, holdHosts: false, holdAttach: false, holdDetach: false,
    binding: "none", bindingLabel: "Scene", bindingExtra: false, holdBinding: false, bindingRequests: [] as Route[], bindingBySession: {} as Record<string, { state: string; label?: string }>,
    hostAction: undefined as "install" | "update" | undefined, associationScope: "global", version: "1.0.0", installOutcome: "installed", holdInstall: false,
    /** Plants the aggregate fields the route no longer sends, to prove the UI never displays them. */
    plantAggregate: false,
    /** Successful attach/detach answers change what the binding route reports next. */
    bindingFollows: true,
    /** A non-2xx status of the binding route (an ownership refusal), when set. */
    bindingStatus: 0,
    failure: undefined as { action: Action; kind: FailureKind } | undefined }
  await page.route("**/api/**", async route => {
    const request = route.request(), parsed = new URL(request.url())
    if (parsed.pathname.endsWith("/plugin-sources") && request.method() === "DELETE") {
      calls.push({ action: "remove", directory: parsed.searchParams.get("directory"), body: request.postDataJSON(), method: request.method() })
      if (model.failure?.action === "remove") return failResponse(route, model.failure.kind)
      if (model.removeCode) return route.fulfill({ status: 409, json: { code: model.removeCode, error: "Removal refused" } })
      const body = request.postDataJSON()
      return route.fulfill({ json: { scope: body.scope, spec: body.target, reloadPending: true } })
    }
    // The RightPanel reads the installed panel extensions as a list.
    if (parsed.pathname === "/api/panel-extensions") return route.fulfill({ json: [] })
    const match = parsed.pathname.match(/\/integrations(?:\/blender\/(hosts|attach|detach|install-host|binding))?$/)
    if (!match) return route.fulfill({ json: {} })
    const action = match[1] ?? "read"
    calls.push({ action, directory: parsed.searchParams.get("directory"), body: request.postDataJSON(), method: request.method(),
      ...(action === "binding" ? { sessionID: parsed.searchParams.get("sessionID") } : {}) })
    if (model.failure?.action === action) return failResponse(route, model.failure.kind)
    if (action === "binding") {
      if (model.holdBinding) { model.bindingRequests.push(route); return }
      if (model.bindingStatus) return route.fulfill({ status: model.bindingStatus, json: { code: "placement", error: privateHost } })
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
      const sessionID = request.postDataJSON()?.sessionID
      if (!model.bindingFollows) { /* the binding route keeps its answer */ }
      else if (action === "attach" && model.outcome === "attached") {
        if (model.bindingBySession[sessionID]) model.bindingBySession[sessionID] = { state: "attached", label: model.bindingLabel }
        else model.binding = "attached"
      }
      if (action === "detach" && model.bindingFollows) {
        if (model.bindingBySession[sessionID]) model.bindingBySession[sessionID] = { state: "none" }
        else model.binding = "none"
      }
      if (action === "detach") await call(page, "hint", undefined, undefined, sessionID)
      return route.fulfill({ json: { outcome: action === "detach" ? model.detachOutcome : model.outcome } })
    }
    return route.fulfill({ json: { location: { directory: parsed.searchParams.get("directory") }, catalog: { state: model.catalog, fetchedAt: "2026-11-01T12:00:00Z" }, ambiguousSources: [], integrations: [{
      id: "blender", displayName: "OpenCode for Blender", app: { name: "Blender", versions: ">=5.2" }, family: model.family,
      summary: { en: "Use Blender from OpenCode." }, catalogStatus: "preview", plugin: { declared: true, runtime: "loaded" },
      configured: true, configuredSources: [{ scope: model.associationScope, entryIndex: model.association, expectedRevision: "a".repeat(64) }], configuredRules: [], scopes: ["global"], state: model.state,
      version: model.version,
      status: { host: { state: model.host, ...(model.hostAction ? { action: model.hostAction } : {}) },
        connection: { offers: model.offers, ...(model.plantAggregate ? { attachedSessions: 42, state: "attached" } : {}) }, version: model.version },
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
  if (options.locale === "he") {
    await shell(page, "setLocale", "he")
    await page.waitForFunction(() => document.documentElement.dir === "rtl")
  }
  if (options.status !== false) await openStatus(page)
  return { page, calls, model, diagnostics, reload }
}
export type AttachmentFixture = Awaited<ReturnType<typeof prepareAttachment>>

export async function withAttachment<T>(run: (fixture: AttachmentFixture) => Promise<T>, width = 1500, height = 850, options: PrepareOptions & { colorScheme?: "light" | "dark" } = {}) {
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
        page = await browser.newPage({ viewport: { width, height }, ...(options.colorScheme ? { colorScheme: options.colorScheme } : {}) })
        page.setDefaultTimeout(20_000)
        diagnostics = await captureDiagnostics(page, record)
        observer = observeHeaderFixture(page, "integrationFixture")
        await observer.install()
        phase = "bootstrap"
        const fixture = await prepareAttachment(page, diagnostics, options)
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

// The Status section of the Blender integration and its lines (integration-section.tsx).
export const panelToggle = (page: Page) => page.locator('button[aria-label="Right panel"]')
export const statusTab = (page: Page) => page.getByRole("tab", { name: "Status", exact: true })
export const section = (page: Page) => page.locator('[data-status-section="integration:blender"]')
export const sectionTrigger = (page: Page) => page.locator('[data-status-section-trigger="integration:blender"]')
export const sectionBody = (page: Page) => page.locator('[data-integration-section="blender"]')
export const line = (page: Page, name: "plugin" | "application" | "conversation" | "connection") => sectionBody(page).locator(`[data-line="${name}"]`)
export const conversation = (page: Page) => line(page, "conversation").locator("[data-conversation-state]")
export const conversationAction = (page: Page) => line(page, "conversation").locator("[data-conversation-action]")
export const stateBadge = (page: Page) => section(page).locator('[data-integration-state]:not([data-integration-state="update"])')
export const pluginsTrigger = (page: Page) => page.locator('[data-status-section-trigger="plugins"]')
export const pluginRow = (page: Page) => page.locator('[data-plugin-id="neuralnomads.blender"]')
export const pluginRowMenu = (page: Page) => pluginRow(page).getByRole("button", { name: "Actions for neuralnomads.blender", exact: true })
export const sectionMenu = (page: Page) => line(page, "plugin").getByRole("button", { name: "Actions for OpenCode for Blender", exact: true })
export const installButton = (page: Page, name = installLabel) => line(page, "application").getByRole("button", { name, exact: true })
/** A modal window by its accessible name, whether Kobalte marks it dialog or alertdialog. */
export const dialogNamed = (page: Page, name: string | RegExp) => page.getByRole("alertdialog", { name, exact: typeof name === "string" })
  .or(page.getByRole("dialog", { name, exact: typeof name === "string" }))
export const picker = (page: Page) => dialogNamed(page, pickerTitle)

/** Opens the shell's right panel on its Status tab, and the Blender section. */
export async function openStatus(page: Page) {
  const toggle = panelToggle(page)
  await toggle.waitFor()
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click()
  await statusTab(page).waitFor()
  if (await statusTab(page).getAttribute("aria-selected") !== "true") await statusTab(page).click()
  await expandSection(page)
}
export async function expandSection(page: Page) {
  const trigger = sectionTrigger(page)
  await trigger.waitFor()
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click()
  await sectionBody(page).waitFor()
}
export async function expandPlugins(page: Page) {
  const trigger = pluginsTrigger(page)
  await trigger.waitFor()
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click()
  await pluginRow(page).waitFor()
}
export async function waitConversation(page: Page, state: string) {
  await line(page, "conversation").locator(`[data-conversation-state="${state}"]`).waitFor()
}
/** The enabled conversation action with this exact label. */
export async function actionReady(page: Page, label: string) {
  const button = conversationAction(page)
  await page.waitForFunction(label => {
    const element = document.querySelector('[data-integration-section="blender"] [data-line="conversation"] [data-conversation-action]')
    return element?.textContent?.trim() === label && element.getAttribute("aria-disabled") !== "true"
  }, label)
  return button
}
/** Opens the trusted picker from the section's "Attach…" (or "Reattach …") action. */
export async function launch(page: Page, label: string | RegExp = "Attach…") {
  await expandSection(page)
  if (typeof label === "string") await actionReady(page, label)
  else await page.waitForFunction(source => new RegExp(source).test(document.querySelector('[data-integration-section="blender"] [data-conversation-action]')?.textContent ?? ""), label.source)
  await conversationAction(page).click()
  await picker(page).waitFor()
}
/** Selects the only offer and confirms once the guarded Attach is enabled. */
export async function confirmAttach(page: Page, confirm = "Attach") {
  const dialog = picker(page)
  const offer = dialog.getByRole("button", { name: /Blender.*Scene/ })
  if (await offer.getAttribute("aria-pressed") !== "true") await offer.click()
  const button = dialog.getByRole("button", { name: confirm, exact: true })
  await page.waitForFunction(() => !(document.querySelector(".integration-attachment .button-primary") as HTMLButtonElement | null)?.disabled)
  await button.click()
}
export const echoes = async (page: Page) => {
  await call(page, "event", "rpc.neuralnomads.blender.status_changed")
  await call(page, "event", "session.updated", { sessionID: "session" })
}
export async function held(model: { hold?: Route }) {
  for (let attempt = 0; attempt < 100 && !model.hold; attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(model.hold, "the fixed-target mutation reached the HTTP boundary")
  const route = model.hold
  model.hold = undefined
  return route
}
/** The oldest held binding read of one conversation, removed from the held list. */
export async function takeBinding(model: { bindingRequests: Route[] }, sessionID: string) {
  const matches = (route: Route) => new URL(route.request().url()).searchParams.get("sessionID") === sessionID
  for (let attempt = 0; attempt < 100 && !model.bindingRequests.some(matches); attempt++) await new Promise(resolve => setTimeout(resolve, 20))
  const index = model.bindingRequests.findIndex(matches)
  assert.ok(index >= 0, `a binding read of ${sessionID} is held`)
  return model.bindingRequests.splice(index, 1)[0]!
}
export const heldSessions = (model: { bindingRequests: Route[] }) => model.bindingRequests.map(route => new URL(route.request().url()).searchParams.get("sessionID"))
export async function refreshInstallation(page: Page) {
  await call(page, "event", "rpc.neuralnomads.blender.status_changed")
  await page.waitForTimeout(450)
}
/** Opens the shared guarded host-install confirmation from the section's Application line. */
export async function launchInstallation(page: Page, name = installLabel) {
  await expandSection(page)
  await installButton(page, name).click()
  const dialog = dialogNamed(page, name)
  await dialog.waitFor()
  return dialog
}
export async function installationReady(page: Page, model: { host: string; hostAction?: "install" | "update"; offers: number }) {
  Object.assign(model, { host: "absent", hostAction: "install", offers: 0 })
  await refreshInstallation(page)
  await expandSection(page)
  await installButton(page).waitFor()
}
/** Waits for the guarded confirmation's action to be enabled (600 ms after it is shown). */
export async function confirmationReady(page: Page) {
  await page.waitForFunction(() => !(document.querySelector(".alert-dialog .button-primary") as HTMLButtonElement | null)?.disabled)
}
export async function nextToast(page: Page, count: number) {
  await page.waitForFunction(count => (window as any).integrationFixture.toasts().length > count, count)
  return (await call(page, "toasts"))[0]
}
export const count = (calls: Call[], action: string) => calls.filter(call => call.action === action).length
