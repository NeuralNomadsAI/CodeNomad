import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "loading-phase",
    routes: [{ path: "/fixture", html: '<html><body><div id="loading-root"></div><script type="module" src="/src/renderer/loading/main.tsx"></script></body></html>' }],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

async function open(host: string, initial: object, hold = false, context = "local") {
  const page = await browser.newPage({ locale: "en-US" })
  await page.addInitScript(({ host, initial, hold, context }) => {
    const w = window as any
    w.__name = (value: unknown) => value
    w.__CODENOMAD_RUNTIME_HOST__ = host
    w.__CODENOMAD_WINDOW_CONTEXT__ = context
    const handlers: Record<string, (payload: unknown) => void> = {}
    w.deliver = (event: string, payload: unknown) => handlers[event]?.(payload)
    w.statusRead = false
    const read = async () => {
      w.statusRead = true
      if (!hold) return initial
      return new Promise((resolve, reject) => {
        w.releaseStatus = (fail: boolean) => fail ? reject(new Error("Late read failure")) : resolve(initial)
      })
    }
    if (host === "electron") w.electronAPI = {
      onCliStatus: (handler: (payload: unknown) => void) => { handlers["cli:status"] = handler; return () => {} },
      onCliError: (handler: (payload: unknown) => void) => { handlers["cli:error"] = handler; return () => {} },
      getCliStatus: read,
    }
    else {
      let id = 0
      const callbacks = new Map<number, (event: unknown) => void>()
      w.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "local-fixture" }, currentWebview: { label: "local-fixture" } },
        transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++id, callback); return id },
        invoke: async (command: string, args: any) => {
          if (command === "cli_get_status") return read()
          if (command === "plugin:event|listen") {
            handlers[args.event] = payload => callbacks.get(args.handler)?.({ payload })
            return args.handler
          }
        },
      }
    }
  }, { host, initial, hold, context })
  await page.goto(url)
  return page
}

async function status(page: Page, text: string) {
  await page.getByText(text, { exact: true }).waitFor()
  assert.equal(await page.locator(".loading-row").innerText(), text)
  assert.equal(await page.getByRole("button").count(), 0)
}

for (const host of ["electron", "tauri"]) {
  test(`${host}: the real backend state replaces phrases and follows startup/recovery`, async () => {
    const page = await open(host, { state: "starting" })
    try {
      await page.waitForFunction(() => (window as any).statusRead)
      await status(page, "Starting server…")
      await page.evaluate(() => (window as any).deliver("cli:status", { state: "ready" }))
      await status(page, "Opening CodeNomad…")
      assert.equal(page.url(), url, "the native host owns ready navigation")
      await page.evaluate(() => (window as any).deliver("cli:status", { state: "error", error: "Backend failed" }))
      await status(page, "Encountered an issue")
      assert.equal(await page.locator(".loading-error").innerText(), "Backend failed")
      assert.equal(await page.locator(".spinner").count(), 0)
      await page.evaluate(() => (window as any).deliver("cli:status", { state: "stopped" }))
      await status(page, "Server stopped")
      assert.equal(await page.locator(".loading-error").count(), 0)
      await page.evaluate(() => (window as any).deliver("cli:status", { state: "starting" }))
      await status(page, "Starting server…")
      await page.locator(".spinner").waitFor()
      await page.evaluate((host) => (window as any).deliver("cli:error",
        host === "electron" ? { message: "Launch failed" } : { error: "Launch failed" }), host)
      await status(page, "Encountered an issue")
      assert.equal(await page.locator(".loading-error").innerText(), "Launch failed")
    } finally { await page.close() }
  })

  test(`${host}: the initial snapshot reports an already-failed startup`, async () => {
    const page = await open(host, { state: "error", error: "Already failed" })
    try {
      await status(page, "Encountered an issue")
      assert.equal(await page.locator(".loading-error").innerText(), "Already failed")
    } finally { await page.close() }
  })

  for (const fail of [false, true]) test(`${host}: a late snapshot ${fail ? "failure" : "result"} preserves newer status`, async () => {
    const page = await open(host, { state: "starting" }, true)
    try {
      await page.waitForFunction(() => (window as any).statusRead)
      await page.evaluate(() => (window as any).deliver("cli:status", { state: "error", error: "Current failure" }))
      await status(page, "Encountered an issue")
      await page.evaluate(fail => (window as any).releaseStatus(fail), fail)
      assert.equal(await page.locator(".loading-error").innerText(), "Current failure")
      await status(page, "Encountered an issue")
    } finally { await page.close() }
  })

  test(`${host}: a remote window never reads local startup status`, async () => {
    const page = await open(host, { state: "error", error: "Local failure" }, false, "remote")
    try {
      await status(page, "Loading CodeNomad…")
      assert.equal(await page.evaluate(() => (window as any).statusRead), false)
    } finally { await page.close() }
  })
}
