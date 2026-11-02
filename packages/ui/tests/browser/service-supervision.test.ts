import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import type { SupervisionSettingsControl, SupervisionSettingsResponse } from "../../../server/src/api-types"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { fixtureEventStream } from "./fixture-event-stream"
import { runWithDiagnosticCleanup } from "./fixture-diagnostic-boundary"
import { serviceSupervisionMessages as messages } from "../../src/lib/i18n/messages/en/service-supervision"

let browser: Browser, url: string
let events: Awaited<ReturnType<typeof fixtureEventStream>> | undefined
async function closeEvents() {
  const owned = events
  events = undefined
  await owned?.close()
}
before(async () => {
  const fixture = await borrowFixture({ name: "service-supervision", routes: [{ path: "/fixture",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/service-supervision.tsx"></script></body></html>' }] })
  url = fixture.url
  let ready = false
  await runWithDiagnosticCleanup({ run: async () => {
    events = await fixtureEventStream(url)
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
    armFixtureNavigationBudget(browser)
    ready = true
  }, diagnose: async () => {}, cleanup: async () => {
    if (!ready) { try { await browser?.close() } finally { await closeEvents() } }
  }, onObservationError: () => console.error("supervision-startup-observation-failed"),
  onCleanupError: () => console.error("supervision-startup-cleanup-failed") })
})
after(async () => { try { await browser?.close() } finally { await closeEvents() } })
const key = "a".repeat(64), otherKey = "b".repeat(64)
const initial = (): SupervisionSettingsResponse => ({ serviceKey: key, desired: "unset", revision: 0,
  state: "off", cause: null, serviceResponding: true })

async function setup(page: Page) {
  let state = initial(), failRead = false, mode: "success" | "lost-applied" | "lost-unknown" | "hold" | "malformed" = "success"
  let release: (() => void) | undefined, readRelease: (() => void) | undefined, holdRead = false
  let heldResolve: () => void = () => {}
  const held = new Promise<void>(resolve => { heldResolve = resolve })
  let reads = 0, inFlight = 0, maxInFlight = 0
  const writes: SupervisionSettingsControl[] = [], queries: string[] = [], errors: string[] = []
  let receipt: SupervisionSettingsControl | undefined
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", async route => {
    const request = route.request(), parsed = new URL(request.url())
    if (parsed.pathname !== "/api/opencode/supervision") {
      if (parsed.pathname === "/api/storage/config/server" && request.method() === "PATCH") {
        return route.fulfill({ json: request.postDataJSON() })
      }
      return route.fulfill({ json: {} })
    }
    if (request.method() === "GET") {
      reads++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); queries.push(parsed.search)
      const captured = structuredClone(state)
      if (holdRead) { holdRead = false; await new Promise<void>(resolve => { readRelease = resolve }) }
      inFlight--
      if (failRead) return route.fulfill({ status: 503, json: { error: "supervision-unavailable" } })
      const requestID = parsed.searchParams.get("requestID")
      return route.fulfill({ json: { ...captured, ...(requestID ? { request: receipt?.requestID === requestID
        ? { requestID, state: "recorded", action: receipt.action, appliedRevision: state.revision }
        : { requestID, state: "unknown" } } : {}) } })
    }
    const input = request.postDataJSON() as SupervisionSettingsControl
    writes.push(input)
    const actionMode = mode; mode = "success"
    if (actionMode === "hold") await new Promise<void>(resolve => { release = resolve; heldResolve() })
    if (actionMode === "lost-unknown") return route.abort("failed")
    if (actionMode === "malformed") return route.fulfill({ json: {} })
    if (input.serviceKey !== state.serviceKey || input.expectedRevision !== state.revision)
      return route.fulfill({ status: 409, json: { error: "supervision-conflict" } })
    if (input.action !== "retry") {
      receipt = input
      state = { ...state, revision: state.revision + 1, desired: input.action,
        state: input.action === "on" ? "running" : "off", cause: null }
    } else state = { ...state, state: state.desired === "on" ? "running" : "off", cause: null }
    if (actionMode === "lost-applied") return route.abort("failed")
    return route.fulfill({ json: { ...state, request: { requestID: input.requestID,
      state: input.action === "retry" ? "unknown" : "recorded", action: input.action, appliedRevision: state.revision } } })
  })
  await events!.route(page)
  return { writes, queries, errors, held, state: (next: Partial<SupervisionSettingsResponse>) => { state = { ...state, ...next } },
    mode: (next: typeof mode) => { mode = next }, readFailure: (value: boolean) => { failRead = value },
    reads: () => reads, maxInFlight: () => maxInFlight, holdRead: () => { holdRead = true },
    release: () => release?.(), releaseRead: () => readRelease?.() }
}
const frames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
async function capture(page: Page, name: string) {
  if (!process.env.CODENOMAD_SUPERVISION_CAPTURE) return
  await mkdir(process.env.CODENOMAD_SUPERVISION_CAPTURE, { recursive: true })
  await page.screenshot({ path: path.join(process.env.CODENOMAD_SUPERVISION_CAPTURE, `supervision-${name}.png`), fullPage: true })
}

test("supervision observes without installing; explicit ON/OFF pin service revision and preserve the running service", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  const fixture = await setup(page)
  try {
    await page.goto(url)
    const toggle = page.getByRole("switch", { name: "Keep OpenCode running", exact: true })
    await page.getByRole("status").filter({ hasText: /^Off$/ }).waitFor()
    assert.equal(await toggle.isChecked(), false)
    assert.equal(fixture.writes.length, 0)
    await toggle.click()
    await page.getByText("Running · supervision active", { exact: true }).waitFor()
    await capture(page, "running-en")
    assert.equal(fixture.writes.length, 1)
    assert.deepEqual({ ...fixture.writes[0], requestID: "id" }, { serviceKey: key, expectedRevision: 0, requestID: "id", action: "on" })
    assert.match(fixture.writes[0].requestID, /^[a-f\d-]{36}$/)
    await toggle.click()
    await page.getByRole("status").filter({ hasText: /^Off$/ }).waitFor()
    await page.getByText("OpenCode responds, but supervision is not confirmed active.", { exact: true }).waitFor()
    assert.deepEqual(fixture.writes.map(item => [item.action, item.expectedRevision]), [["on", 0], ["off", 1]])
    await page.evaluate(() => (window as any).fixture.mount(false))
    await page.evaluate(() => (window as any).fixture.mount(true))
    await page.getByRole("status").filter({ hasText: /^Off$/ }).waitFor()
    assert.equal(fixture.writes.length, 2, "remount never reinstalls")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("supervision prose stays in the info tip, accessible by keyboard and touch without changing the setting", async () => {
  for (const touch of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 950 }, hasTouch: touch })
    const fixture = await setup(page)
    try {
      await page.goto(url)
      const status = page.getByRole("status").filter({ hasText: /^Off$/ })
      await status.waitFor()
      const toggle = page.getByRole("switch")
      assert.equal(await toggle.getAttribute("aria-describedby"), await status.getAttribute("id"))
      const prose = ["info", "scope", "default", "off"].map(key => messages[`settings.supervision.${key}` as keyof typeof messages])
      for (const text of prose) assert.equal(await page.getByText(text, { exact: false }).count(), 0)
      const tip = page.locator(".settings-info-tip"), tooltip = page.getByRole("tooltip")
      if (touch) await tip.tap()
      else {
        await page.keyboard.press("Tab")
        assert.equal(await tip.evaluate(el => el === document.activeElement), true)
      }
      await tooltip.waitFor()
      assert.equal(await tooltip.innerText(), prose.join(" "))
      if (touch) await tip.tap()
      else await page.keyboard.press("Tab")
      await tooltip.waitFor({ state: "hidden" })
      assert.equal(await toggle.isChecked(), false)
      assert.equal(fixture.writes.length, 0)
      assert.deepEqual(fixture.errors, [])
    } finally { await page.close() }
  }
})

test("all protection states and platform causes are visible, including deferred Linux rollback with Retry", async () => {
  const page = await browser.newPage({ viewport: { width: 380, height: 950 } })
  const fixture = await setup(page)
  try {
    fixture.state({ desired: "on", revision: 4, state: "failing", cause: "guard-absent", lastAttemptAt: "2026-10-30T12:00:00Z",
      retryAt: "2026-10-30T12:00:05Z", recoveryNextTickAt: "2026-10-30T12:01:00Z" })
    await page.goto(url)
    await page.getByText("Supervision failed", { exact: true }).waitFor()
    await page.getByText("The OS supervisor is absent.", { exact: true }).waitFor()
    await page.getByText(/OpenCode responds, but supervision/).waitFor()
    for (const text of ["Last attempt:", "Supervisor retry:", "OS recovery safety check:"])
      assert.equal(await page.getByText(text, { exact: false }).count(), 1)
    const refresh = page.getByRole("button", { name: "Check supervision status", exact: true })
    for (const [state, cause, label] of [
      ["pending", "reconciliation-pending", "Installing or removing supervision…"],
      ["installed", "service-starting", "Installed · service starting"],
      ["failing", "wsl-forwarding-unavailable", "Windows cannot reach the WSL service."],
      ["failing", "linux-linger-permission-required", "Linux requires permission to change lingering."],
      ["off", "linux-linger-deferred", "Supervision is off. Restoring Linux lingering is deferred"],
    ] as const) {
      fixture.state({ state, cause, ...(state === "off" ? { desired: "off" } : {}) })
      await refresh.click()
      await page.getByText(label, { exact: state === "pending" || state === "installed" }).waitFor()
    }
    const retry = page.getByRole("button", { name: "Retry supervision", exact: true })
    await retry.click()
    await retry.waitFor({ state: "detached" })
    assert.equal(fixture.writes[0].action, "retry")
    assert.equal(fixture.writes[0].expectedRevision, 4)
    // Linux's whole-user effect is available from the keyboard-focusable info tip.
    await page.locator(".settings-info-tip").focus()
    await page.getByRole("tooltip").filter({ hasText: /ALL enabled user services/ }).waitFor()
    assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth), true)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("lost acknowledgements reconcile by exact receipt; unknown actions keep their original identity across remount", async () => {
  const page = await browser.newPage()
  const fixture = await setup(page)
  try {
    fixture.mode("lost-applied")
    await page.goto(url)
    const toggle = page.getByRole("switch", { name: "Keep OpenCode running", exact: true })
    await page.getByRole("status").filter({ hasText: /^Off$/ }).waitFor()
    await toggle.click()
    await page.getByText("Running · supervision active", { exact: true }).waitFor()
    assert.equal(fixture.writes.length, 1)
    assert.ok(fixture.queries.some(query => query.includes(`requestID=${fixture.writes[0].requestID}`)))
    assert.equal(await toggle.isDisabled(), false)
    fixture.mode("lost-unknown")
    await toggle.click()
    await page.getByRole("alert").filter({ hasText: /This action is unconfirmed/ }).waitFor()
    assert.equal(await toggle.isDisabled(), true)
    const original = fixture.writes[1]
    await page.evaluate(() => (window as any).fixture.mount(false))
    await page.evaluate(() => (window as any).fixture.mount(true))
    await page.getByRole("button", { name: "Retry original action", exact: true }).waitFor()
    await page.getByRole("button", { name: "Check supervision status", exact: true }).click()
    await frames(page)
    assert.equal(fixture.writes.length, 2, "status reads and remounts never resend")
    await page.getByRole("button", { name: "Retry original action", exact: true }).click()
    await page.getByRole("status").filter({ hasText: /^Off$/ }).waitFor()
    assert.deepEqual(fixture.writes[2], original, "explicit retry keeps key, revision and request ID")
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("reads coalesce, stale observations are withheld, hidden sections make no requests and failed reads disable writes", async () => {
  const page = await browser.newPage()
  const fixture = await setup(page)
  try {
    await page.goto(url)
    await page.getByRole("status").filter({ hasText: /^Off$/ }).waitFor()
    fixture.holdRead()
    await page.getByRole("button", { name: "Check supervision status", exact: true }).click()
    const before = fixture.reads()
    await page.evaluate(() => { for (let i = 0; i < 8; i++) (window as any).fixture.reconnect() })
    fixture.state({ desired: "on", state: "running", revision: 1 })
    fixture.releaseRead()
    await page.getByText("Running · supervision active", { exact: true }).waitFor()
    assert.equal(fixture.reads(), before + 1)
    assert.equal(fixture.maxInFlight(), 1)
    await page.evaluate(() => (window as any).fixture.activate(false))
    const hiddenReads = fixture.reads()
    await page.evaluate(() => (window as any).fixture.reconnect())
    await frames(page)
    assert.equal(fixture.reads(), hiddenReads)
    fixture.readFailure(true)
    await page.evaluate(() => (window as any).fixture.activate(true))
    await page.getByRole("alert").filter({ hasText: /Service supervision could not be read/ }).waitFor()
    assert.equal(await page.getByRole("switch").isDisabled(), true)
    fixture.readFailure(false)
    await page.getByRole("button", { name: "Check supervision status", exact: true }).click()
    await page.getByText("Running · supervision active", { exact: true }).waitFor()
    fixture.readFailure(true)
    await page.getByRole("button", { name: "Check supervision status", exact: true }).click()
    await page.getByRole("alert").waitFor()
    assert.equal(await page.getByText("Running · supervision active", { exact: true }).count(), 1, "last good display survives a passive failure")
    assert.equal(fixture.writes.length, 0)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("all ten narrow locale layouts render translated controls, including the first-Play opt-out", async () => {
  for (const locale of ["en", "fr", "de", "es", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) {
    const { serviceSupervisionMessages: messages } = await import(`../../src/lib/i18n/messages/${locale}/service-supervision.ts`)
    const title = messages["settings.supervision.title"]
    const page = await browser.newPage({ viewport: { width: 390, height: 950 } })
    const fixture = await setup(page)
    fixture.state({ desired: "off", state: "off", revision: 2, cause: "linux-linger-deferred" })
    try {
      await page.goto(`${url}?locale=${locale}`)
      await page.getByRole("switch", { name: title, exact: true }).waitFor()
      await page.locator(".settings-info-actions button").nth(1).waitFor()
      assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth), true)
      assert.equal(await page.locator("main").innerText().then(text => text.includes("settings.supervision.")), false)
      await capture(page, locale)
      fixture.state({ desired: "unset", revision: 0, cause: null })
      await page.getByRole("button", { name: messages["settings.supervision.refresh"], exact: true }).click()
      await page.getByRole("button", { name: messages["settings.supervision.keepOff"], exact: true }).waitFor()
      assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth), true, `${locale}: opt-out fits`)
      assert.deepEqual(fixture.errors, [])
    } finally { await page.close() }
  }
})

test("a stale revision refreshes without overwriting another profile's choice", async () => {
  const page = await browser.newPage()
  const fixture = await setup(page)
  try {
    await page.goto(url)
    await page.getByRole("status").filter({ hasText: /^Off$/ }).waitFor()
    fixture.state({ desired: "off", revision: 5 })
    await page.getByRole("switch").click()
    await page.getByRole("alert").filter({ hasText: /Another action changed this service/ }).waitFor()
    await page.locator('[role="switch"]:enabled').waitFor()
    assert.equal(fixture.writes.length, 1)
    assert.equal(fixture.writes[0].expectedRevision, 0)
    assert.equal(await page.getByRole("button", { name: "Retry original action", exact: true }).count(), 0)
    assert.equal(await page.getByRole("switch").isChecked(), false)
    assert.equal(await page.getByRole("switch").isDisabled(), false)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("an in-flight control survives remount and its late reply cannot publish into a newly selected service", async () => {
  const page = await browser.newPage()
  const fixture = await setup(page)
  try {
    await page.goto(url)
    await page.getByRole("status").filter({ hasText: /^Off$/ }).waitFor()
    fixture.mode("hold")
    await page.getByRole("switch").click()
    await fixture.held
    await page.evaluate(() => (window as any).fixture.mount(false))
    await page.evaluate(() => (window as any).fixture.mount(true))
    await page.getByRole("status").filter({ hasText: /^Off$/ }).waitFor()
    assert.equal(await page.getByRole("switch").isDisabled(), true)
    assert.equal(fixture.writes.length, 1)
    fixture.state({ serviceKey: otherKey, desired: "off", revision: 8 })
    await page.evaluate(() => (window as any).fixture.select("/another/opencode2"))
    await page.locator('[role="switch"]:enabled').waitFor()
    fixture.release()
    await frames(page)
    assert.equal(await page.getByRole("switch").isChecked(), false)
    assert.equal(await page.getByRole("alert").count(), 0, "the old failure must not annotate the new host")
    assert.equal(fixture.writes.length, 1)
    assert.deepEqual(fixture.errors, [])
  } finally { fixture.release(); await page.close() }
})

test("a remounted card observes completion of the control still owned by its prior mount", async () => {
  const page = await browser.newPage()
  const fixture = await setup(page)
  try {
    await page.goto(url)
    await page.getByRole("status").filter({ hasText: /^Off$/ }).waitFor()
    fixture.mode("hold")
    await page.getByRole("switch").click()
    await fixture.held
    await page.evaluate(() => (window as any).fixture.mount(false))
    await page.evaluate(() => (window as any).fixture.mount(true))
    await page.getByRole("status").filter({ hasText: /^Off$/ }).waitFor()
    assert.equal(await page.getByRole("switch").isDisabled(), true)
    fixture.release()
    await page.getByText("Running · supervision active", { exact: true }).waitFor()
    assert.equal(await page.getByRole("switch").isChecked(), true)
    assert.equal(fixture.writes.length, 1)
    assert.deepEqual(fixture.errors, [])
  } finally { fixture.release(); await page.close() }
})

test("explicit OFF can be saved before first Play without installing supervision", async () => {
  const page = await browser.newPage()
  const fixture = await setup(page)
  try {
    await page.goto(url)
    await page.getByRole("button", { name: "Keep off at first Mission Play", exact: true }).click()
    await page.getByRole("button", { name: "Keep off at first Mission Play", exact: true }).waitFor({ state: "detached" })
    assert.deepEqual(fixture.writes.map(item => item.action), ["off"])
    assert.equal(await page.getByRole("switch").isChecked(), false)
    assert.equal(await page.getByRole("button", { name: "Keep off at first Mission Play", exact: true }).count(), 0)
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("a malformed acknowledgement retains the original action instead of treating it as saved", async () => {
  const page = await browser.newPage()
  const fixture = await setup(page)
  try {
    await page.goto(url)
    await page.getByRole("status").filter({ hasText: /^Off$/ }).waitFor()
    fixture.mode("malformed")
    await page.getByRole("switch").click()
    await page.getByRole("alert").filter({ hasText: /This action is unconfirmed/ }).waitFor()
    assert.equal(await page.getByRole("switch").isDisabled(), true)
    assert.equal(fixture.writes.length, 1)
    await page.getByRole("button", { name: "Retry original action", exact: true }).click()
    await page.getByText("Running · supervision active", { exact: true }).waitFor()
    assert.deepEqual(fixture.writes[1], fixture.writes[0])
    assert.deepEqual(fixture.errors, [])
  } finally { await page.close() }
})

test("supervision owns a persistent native EventSource until page and event-server cleanup", async t => {
  const page = await browser.newPage()
  t.after(() => page.close())
  const previousEvents = events
  events = await fixtureEventStream(url)
  const owned = events, close = owned.close.bind(owned)
  t.after(async () => {
    try { if (events === owned) await closeEvents() } finally { events = previousEvents }
  })
  await page.clock.install()
  await page.addInitScript(() => localStorage.setItem("opencode:logger:namespaces", '["sse"]'))
  let requests = 0
  const failures: string[] = []
  page.on("request", request => { if (request.resourceType() === "eventsource") requests++ })
  page.on("requestfailed", request => { if (request.resourceType() === "eventsource") failures.push("stream-request-failed") })
  page.on("console", message => { if (/MIME|scheduling reconnect|failed to connect/i.test(message.text())) failures.push("stream-console-error") })
  const response = page.waitForResponse(response => response.request().resourceType() === "eventsource")
  const opened = page.waitForEvent("console", message => message.text().includes("Events stream connected"))
  const closing = t.mock.method(owned, "close", async () => {
    assert.equal(page.isClosed(), true, "the page owns the connection lifetime")
    await close()
  })
  try {
    const fixture = await setup(page)
    await page.goto(url)
    await page.getByRole("status").filter({ hasText: /^Off$/ }).waitFor()
    assert.equal((await response).headers()["content-type"], "text/event-stream")
    await opened
    await page.clock.runFor(1500)
    assert.equal(requests, 1, "a live stream does not retry or hit the JSON fallback")
    assert.deepEqual(failures, [])
    assert.deepEqual(fixture.errors, [])
    assert.equal(fixture.writes.length, 0)
  } finally { try { await page.close() } finally { await closeEvents() } }
  await closeEvents()
  assert.equal(closing.mock.callCount(), 1, "the suite releases only its owned event server once")
})
