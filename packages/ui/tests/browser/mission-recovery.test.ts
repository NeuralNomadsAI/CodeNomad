import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { missionRecoveryMessages as english } from "../../src/lib/i18n/messages/en/mission-recovery"
import { createFixtureCache } from "./fixture-cache"

let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  cache = await createFixtureCache()
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    cacheDir: cache.cacheDir,
    plugins: [solid(), { name: "mission-recovery-fixture", configureServer(s) {
      s.middlewares.use("/mission-recovery-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/mission-recovery-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-recovery.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-recovery-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { try { await browser?.close(); await server?.close() } finally { await cache?.dispose() } })
const call = (page: Page, method: string, arg?: unknown) => page.evaluate(({ method, arg }) => (window as any).recoveryFixture[method](arg), { method, arg })
async function setup(page: Page) {
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
}

test("idle-without-report permits explicit verification only; clicks, refresh and remount never replay admitted recovery", async () => {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 390, height: 700 } })
  try {
    await setup(page)
    const requests: unknown[] = []
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    await page.route("**/missions/mission-recovery/recover", async route => {
      requests.push(route.request().postDataJSON())
      await held
      await route.fulfill({ json: { mission: {}, admitted: true } })
    })
    await page.goto(url)
    const button = page.getByRole("button", { name: english["missions.recovery.coordinator"], exact: true })
    await button.waitFor()
    assert.equal(requests.length, 0)
    assert.equal(await button.getAttribute("title"), english["missions.recovery.coordinator"])
    assert.equal(await button.evaluate(el => getComputedStyle(el).borderRadius), "0px")
    const sent = page.waitForRequest(request => request.url().endsWith("/recover"))
    await button.evaluate(el => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click() })
    await sent
    await page.getByRole("status").waitFor()
    assert.equal(await button.isDisabled(), true)
    assert.equal(await button.getAttribute("aria-busy"), "true")
    assert.equal(requests.length, 1)
    release()
    await page.waitForFunction(() => (window as any).recoveryFixture.refreshes().length === 1)
    assert.deepEqual(requests, [{ expectedRevision: 1, target: "coordinator" }])
    await button.evaluate(el => (el as HTMLButtonElement).click())
    await call(page, "mount", false)
    await call(page, "mount", true)
    assert.equal(await button.isDisabled(), true)
    assert.equal(requests.length, 1)
    assert.equal(await page.getByRole("status").count(), 0)
    assert.equal(await page.getByRole("alert").count(), 0)
    assert.deepEqual(await call(page, "refreshes"), ["coordinator"])
    await call(page, "patch", { revision: 2 })
    assert.equal(await button.isEnabled(), true)
    assert.equal(requests.length, 1)
    await call(page, "failRefresh", true)
    await button.click()
    await page.waitForFunction(() => (window as any).recoveryFixture.refreshes().length === 2)
    assert.deepEqual(requests[1], { expectedRevision: 2, target: "coordinator" })
    assert.equal(await page.getByRole("alert").count(), 0)
    assert.equal(await button.isDisabled(), true)
  } finally { await page.close() }
})

test("pending guard survives remount and old completions cannot refresh a replacement mission", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    await setup(page)
    let count = 0, release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    await page.route("**/missions/mission-recovery/recover", async route => {
      count++
      await held
      await route.fulfill({ json: { admitted: true } })
    })
    await page.goto(url)
    const button = page.locator('[data-target="report"] button')
    const sent = page.waitForRequest(request => request.url().endsWith("/recover"))
    await button.click()
    await sent
    await page.getByRole("status").waitFor()
    await call(page, "mount", false)
    await call(page, "mount", true)
    assert.equal(await button.isDisabled(), true)
    await button.evaluate(el => (el as HTMLButtonElement).click())
    assert.equal(count, 1)
    await call(page, "patch", { id: "replacement" })
    assert.equal(await button.isEnabled(), true)
    release()
    await page.waitForResponse(response => response.url().endsWith("/recover"))
    // Read after the old fetch continuation; no native retry or old callback.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    assert.deepEqual(await call(page, "refreshes"), [])
    assert.equal(await page.getByRole("alert").count(), 0)
    assert.equal(count, 1)
    await call(page, "patch", { id: "mission-recovery" })
    assert.equal(await button.isDisabled(), true)
  } finally { await page.close() }
})

test("lifecycle, native waits and unadmitted or resolved tasks suppress recovery without sending", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    await setup(page)
    let count = 0
    await page.route("**/recover", route => { count++; return route.fulfill({ json: { admitted: true } }) })
    await page.goto(url)
    await page.locator('[data-target="coordinator"] button').waitFor()
    for (const runState of ["prepared", "paused", "stopped"]) {
      await call(page, "patch", { runState })
      assert.equal(await page.getByRole("button").count(), 0)
    }
    await call(page, "patch", { runState: "running" })
    for (const status of ["completed", "failed", "stopped"]) {
      await call(page, "patch", { status })
      assert.equal(await page.getByRole("button").count(), 0)
    }
    await call(page, "patch", { status: "active", control: { pending: ["ses_coordinator"] } })
    assert.equal(await page.getByRole("button").count(), 0)
    await call(page, "patch", { control: null })
    for (const activity of ["running", "queued", "background", "permission", "form", "missing"]) {
      await call(page, "activity", activity)
      assert.equal(await page.getByRole("button").count(), 0)
    }
    await call(page, "activity", "idle-without-report")
    assert.equal(await page.getByRole("button").count(), 2)
    await call(page, "runtime", "working")
    assert.equal(await page.getByRole("button").count(), 2, "historical actor status cannot overrule the native idle projection")
    await call(page, "activity", "unknown")
    // A report may still ask the backend to verify unknown activity, but the
    // coordinator (Play's slot) is never offered recovery without observed idle:
    // an oversized background subagent tree projects as unknown.
    assert.equal(await page.locator('[data-target="report"] button').count(), 1, "unknown report activity permits explicit backend verification")
    assert.equal(await page.locator('[data-target="coordinator"] button').count(), 0, "unknown never offers coordinator recovery")
    await call(page, "runtime", "idle")
    await call(page, "activity")
    assert.equal(await page.locator('[data-target="coordinator"] button').count(), 0, "absent activity is not observed idle")
    assert.equal(await page.locator('[data-target="report"] button').count(), 1)
    await call(page, "task", { admissionId: null })
    assert.equal(await page.locator('[data-target="report"] button').count(), 0)
    await call(page, "task", { admissionId: "msg_admitted", report: { id: "report" } })
    assert.equal(await page.locator('[data-target="report"] button').count(), 0)
    await call(page, "task", { report: null, status: "withdrawn", outstandingExecution: false })
    assert.equal(await page.locator('[data-target="report"] button').count(), 0)
    await call(page, "task", { outstandingExecution: true })
    assert.equal(await page.locator('[data-target="report"] button').count(), 1)
    await call(page, "disabled", true)
    assert.equal(await page.locator('[data-target="report"] button').isDisabled(), true)
    assert.equal(count, 0)
  } finally { await page.close() }
})

test("report request is task-scoped and classified rejections never expose upstream text or retry themselves", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    await setup(page)
    const cases = [
      ["recovery-busy", "busy"], ["recovery-unknown", "unknown"], ["recovery-conflict", "conflict"],
      ["revision-conflict", "conflict"], ["unexpected-upstream", "failed"],
    ] as const
    let index = 0
    const requests: any[] = []
    await page.route("**/recover", route => {
      requests.push(route.request().postDataJSON())
      return route.fulfill({ status: 409, json: { code: cases[index][0], error: "PRIVATE RAW UPSTREAM ERROR" } })
    })
    await page.goto(url)
    const button = page.locator('[data-target="report"] button')
    for (index = 0; index < cases.length; index++) {
      await button.click()
      const alert = page.getByRole("alert")
      await alert.getByText(english[`missions.recovery.error.${cases[index][1]}`], { exact: true }).waitFor()
      assert.equal(await button.getAttribute("aria-description"), await alert.innerText())
      assert.equal((await page.locator("body").innerText()).includes("PRIVATE RAW"), false)
      assert.deepEqual(requests[index], { expectedRevision: 1, target: "report", taskKey: "task-report" })
      assert.deepEqual(await call(page, "refreshes"), [])
      await call(page, "mount", false)
      await call(page, "mount", true)
      assert.equal(await page.getByRole("alert").count(), 0)
      assert.equal(requests.length, index + 1)
    }
  } finally { await page.close() }
})

test("changed view identity fences late errors and refresh callbacks without unmounting", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    await setup(page)
    let release!: () => void
    let held = new Promise<void>(resolve => { release = resolve })
    let admitted = false, count = 0
    await page.route("**/recover", async route => {
      count++
      await held
      await route.fulfill(admitted ? { json: { admitted: true } }
        : { status: 409, json: { code: "recovery-busy", error: "OLD FAILURE" } })
    })
    await page.goto(url)
    const button = page.locator('[data-target="coordinator"] button')
    for (const succeeds of [false, true]) {
      admitted = succeeds
      const sent = page.waitForRequest(request => request.url().endsWith("/recover"))
      await button.click()
      await sent
      await call(page, "patch", { id: "replacement", revision: 2 })
      const received = page.waitForResponse(response => response.url().endsWith("/recover"))
      release()
      await received
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
      assert.equal(await page.getByRole("alert").count(), 0)
      assert.deepEqual(await call(page, "refreshes"), [])
      assert.equal(await button.isEnabled(), true)
      await call(page, "patch", { id: "mission-recovery", revision: 1 })
      held = new Promise<void>(resolve => { release = resolve })
    }
    assert.equal(count, 2)
    assert.equal(await button.isDisabled(), true)
  } finally { await page.close() }
})

test("every locale registers all recovery messages", async () => {
  for (const locale of ["en", "es", "fr", "de", "ru", "ja", "zh-Hans", "he", "ne", "tr"]) {
    const part = (await import(`../../src/lib/i18n/messages/${locale}/mission-recovery.ts`)).missionRecoveryMessages
    const merged = Object.values(await import(`../../src/lib/i18n/messages/${locale}/index.ts`))[0] as Record<string, string>
    assert.deepEqual(Object.keys(part).sort(), Object.keys(english).sort(), locale)
    for (const key of Object.keys(english)) {
      assert.equal(typeof part[key], "string", `${locale}: ${key}`)
      assert.ok(part[key].trim())
      assert.equal(merged[key], part[key])
    }
  }
})
