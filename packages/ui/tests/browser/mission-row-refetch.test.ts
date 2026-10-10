import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"

let server: ViteDevServer, browser: Browser, url: string, cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  cache = await createFixtureCache()
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), cacheDir: cache.cacheDir,
    logLevel: "error", plugins: [solid(), { name: "mission-row-refetch", configureServer(s) {
      s.middlewares.use("/mission-row-refetch", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/mission-row-refetch", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/mission-row-refetch.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/mission-row-refetch`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close(); await cache?.dispose() })
async function prepare(page: Page) {
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).missionRowFixture))
  await page.locator('[data-fixture="attention"] .mission-needs-item').first().waitFor()
  await page.locator('[data-fixture="cleanup"] .mission-list-item').waitFor()
}
const attentionRows = '[data-fixture="attention"] .mission-needs-item'
const answerButtons = `${attentionRows} button.mission-needs-answer`
const cleanupRow = '[data-fixture="cleanup"] .mission-list-item'
async function refetch(page: Page) { await page.evaluate(() => (window as any).missionRowFixture.refetch()); await page.waitForTimeout(80) }

test("Attention retains exact Form/permission buttons across identical queues and fresh snapshot objects", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let mutations = 0
  try {
    await prepare(page)
    await page.route("**/api/**", route => {
      if (route.request().method() !== "GET") mutations++
      return route.fulfill({ contentType: "application/json", body: "{}" })
    })
    assert.equal(await page.locator(attentionRows).count(), 2) // same native ID, different type/session
    assert.deepEqual(await page.locator(answerButtons).allTextContents(), ["Answer", "Answer"])
    for (const index of [0, 1]) {
      const button = await page.locator(answerButtons).nth(index).elementHandle()
      await button!.focus()
      await refetch(page)
      assert.equal(await button!.evaluate(e => e.isConnected && e === document.activeElement), true)
    }
    const form = await page.locator(answerButtons).first().elementHandle()
    await form!.focus()
    await page.evaluate(() => (window as any).missionRowFixture.update())
    await page.waitForTimeout(80)
    assert.equal(await form!.evaluate(e => e.isConnected && e === document.activeElement), true)
    assert.match((await form!.getAttribute("aria-description"))!, /refreshed/)
    assert.match((await page.locator(attentionRows).nth(1).textContent())!, /Fresh permission title.*Permission requested by Actor B refreshed.*fresh\.txt/)
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => document.querySelector('[data-fixture="navigation"]')?.textContent === "actor-a:3")
    assert.match((await page.locator(attentionRows).first().textContent())!, /Fresh form title/)
    assert.equal(mutations, 0) // routing only, never another native answer path
  } finally { await page.close() }
})

test("Attention keeps an exact narrow Answer button through queue refresh and routes the current target only", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  try {
    await prepare(page)
    // Attention has no overflow menu: the single Answer action stays visible
    // even at a very narrow width.
    await page.evaluate(() => (window as any).missionRowFixture.width(60))
    const form = page.locator(attentionRows).first()
    await page.waitForTimeout(100)
    assert.equal(await form.locator(".action-overflow-trigger").count(), 0)
    assert.equal(await form.locator("button.mission-needs-answer").isVisible(), true)
    const answer = await form.locator("button.mission-needs-answer").elementHandle()
    await answer!.focus()
    await refetch(page)
    assert.equal(await answer!.evaluate(e => e.isConnected && e === document.activeElement), true)
    await page.evaluate(() => (window as any).missionRowFixture.update())
    await page.waitForTimeout(80)
    assert.equal(await answer!.evaluate(e => e.isConnected && e === document.activeElement), true)
    assert.match((await answer!.getAttribute("aria-description"))!, /refreshed/)
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => document.querySelector('[data-fixture="navigation"]')?.textContent === "actor-a:2")
    await page.evaluate(() => (window as any).missionRowFixture.width(420))
    const previous = await form.locator("button.mission-needs-answer").elementHandle()
    await page.locator('[data-fixture="outside"]').focus()
    await page.evaluate(() => (window as any).missionRowFixture.moveForm())
    await page.waitForTimeout(80)
    assert.equal(await previous!.evaluate(e => e.isConnected), false)
    assert.equal(await page.locator('[data-fixture="outside"]').evaluate(e => e === document.activeElement), true)
    await page.locator(answerButtons).first().click()
    await page.waitForFunction(() => document.querySelector('[data-fixture="navigation"]')?.textContent === "actor-b:2")
    const current = await page.locator(answerButtons).first().elementHandle()
    await page.evaluate(() => (window as any).missionRowFixture.closeForm())
    assert.equal(await current!.evaluate(e => e.isConnected), false)
    await current!.evaluate(e => (e as HTMLButtonElement).click())
    assert.equal(await page.locator('[data-fixture="navigation"]').textContent(), "actor-b:2")
  } finally { await page.close() }
})

test("Cleanup preserves exact retry controls/open menus while current receipt text and disabled state update", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let posts = 0
  try {
    await prepare(page)
    const button = await page.locator(`${cleanupRow} .mission-list-inline button`).elementHandle()
    await button!.focus()
    await refetch(page)
    assert.equal(await button!.evaluate(e => e.isConnected && e === document.activeElement), true)
    await page.evaluate(() => (window as any).missionRowFixture.update())
    await page.waitForTimeout(80)
    assert.equal(await button!.evaluate(e => e.isConnected && e === document.activeElement), true)
    assert.match((await page.locator(cleanupRow).textContent())!, /Fresh cleanup receipt/)
    await page.evaluate(() => (window as any).missionRowFixture.disabled(true))
    assert.equal(await button!.isDisabled(), true)
    await page.evaluate(() => (window as any).missionRowFixture.disabled(false))
    await page.evaluate(() => (window as any).missionRowFixture.width(80))
    await page.locator(`${cleanupRow} .action-overflow-trigger`).click()
    // Do not race the menu's deferred opening autofocus with item.focus().
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menu")
    const menu = await page.getByRole("menuitem").elementHandle()
    await menu!.focus()
    await refetch(page)
    assert.equal(await menu!.evaluate(e => e.isConnected && e === document.activeElement), true)
    await page.route("**/api/workspaces/row-refetch/missions", async route => {
      const cleanups = await page.evaluate(() => (window as any).missionRowFixture.receipt())
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ available: true, cleanups }) })
    })
    await page.route("**/api/workspaces/row-refetch/missions/mission", async route => {
      posts++
      assert.equal(route.request().method(), "DELETE")
      assert.equal(route.request().postDataJSON().requestId, "request")
      await route.fulfill({ contentType: "application/json", body: "{}" })
    })
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => document.querySelector('[data-fixture="refreshes"]')?.textContent === "1")
    assert.equal(posts, 1)
    assert.equal(await button!.evaluate(e => e.isConnected), true)
  } finally { await page.close() }
})

test("Cleanup replaced/settled receipts and newly disabled contexts fence delayed retries without stealing focus", async () => {
  for (const change of ["replaceReceipt", "settle", "disabled", "active", "active-aba", "disabled-aba", "receipt-aba", "instance-aba"]) {
    const page = await browser.newPage({ locale: "en-US" })
    let release!: () => void, reads = 0, writes = 0
    const waiting = new Promise<void>(resolve => { release = resolve })
    try {
      await prepare(page)
      const saved = await page.evaluate(() => (window as any).missionRowFixture.receipt())
      await page.route("**/api/workspaces/row-refetch/missions", async route => {
        reads++
        await waiting
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ available: true, cleanups: saved }) })
      })
      await page.route("**/api/workspaces/row-refetch/missions/mission", async route => {
        writes++
        await route.fulfill({ contentType: "application/json", body: "{}" })
      })
      const button = await page.locator(`${cleanupRow} .mission-list-inline button`).elementHandle()
      await button!.click()
      await page.waitForFunction(() => (document.querySelector('[data-fixture="cleanup"] .mission-list-inline button') as HTMLButtonElement)?.disabled)
      await page.locator('[data-fixture="outside"]').focus()
      await page.evaluate(change => {
        const fixture = (window as any).missionRowFixture
        if (change === "disabled") fixture.disabled(true)
        else if (change === "active") fixture.active(false)
        else if (change === "active-aba") { fixture.active(false); fixture.active(true) }
        else if (change === "disabled-aba") { fixture.disabled(true); fixture.disabled(false) }
        else if (change === "receipt-aba") { fixture.settle(); fixture.restoreReceipt() }
        else if (change === "instance-aba") { fixture.instance("other-instance"); fixture.instance("row-refetch") }
        else fixture[change]()
      }, change)
      release()
      await page.waitForTimeout(150)
      assert.equal(reads, 1)
      assert.equal(writes, 0, change)
      assert.equal(await page.locator('[data-fixture="refreshes"]').textContent(), "0")
      assert.equal(await page.locator('[data-fixture="outside"]').evaluate(e => e === document.activeElement), true)
      if (change === "replaceReceipt" || change === "settle") {
        assert.equal(await button!.evaluate(e => e.isConnected), false)
        await button!.evaluate(e => (e as HTMLButtonElement).click())
        assert.equal(reads, 1)
      }
    } finally { release(); await page.close() }
  }
})

test("switching cleanup instances clears old pending state, and late completion cannot clear a new attempt", async () => {
  const page = await browser.newPage({ locale: "en-US" })
  let releaseOld!: () => void, releaseNew!: () => void, writes = 0
  const oldRead = new Promise<void>(resolve => { releaseOld = resolve })
  const newRead = new Promise<void>(resolve => { releaseNew = resolve })
  try {
    await prepare(page)
    const saved = await page.evaluate(() => (window as any).missionRowFixture.receipt())
    await page.route("**/api/workspaces/*/missions", async route => {
      await (route.request().url().includes("/row-refetch/") ? oldRead : newRead)
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ available: true, cleanups: saved }) })
    })
    await page.route("**/api/workspaces/*/missions/mission", async route => {
      writes++
      await route.fulfill({ contentType: "application/json", body: "{}" })
    })
    await page.locator(`${cleanupRow} .mission-list-inline button`).click()
    await page.waitForFunction(() => (document.querySelector('[data-fixture="cleanup"] .mission-list-inline button') as HTMLButtonElement)?.disabled)
    await page.evaluate(() => (window as any).missionRowFixture.instance("other-instance"))
    await page.waitForFunction(() => !(document.querySelector('[data-fixture="cleanup"] .mission-list-inline button') as HTMLButtonElement)?.disabled)
    await page.locator(`${cleanupRow} .mission-list-inline button`).click()
    releaseOld()
    await page.waitForTimeout(100)
    assert.equal(writes, 0)
    assert.equal(await page.locator(`${cleanupRow} .mission-list-inline button`).isDisabled(), true)
    releaseNew()
    await page.waitForFunction(() => document.querySelector('[data-fixture="refreshes"]')?.textContent === "1")
    assert.equal(writes, 1)
    assert.equal(await page.locator(`${cleanupRow} .mission-list-inline button`).isDisabled(), false)
  } finally { releaseOld(); releaseNew(); await page.close() }
})
