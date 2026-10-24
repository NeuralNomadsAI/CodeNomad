import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"

let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  cache = await createFixtureCache()
  server = await createServer({ configFile: false, cacheDir: cache.cacheDir, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "session-child-activity-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/session-child-activity.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { try { await browser?.close() } finally { await server?.close(); await cache?.dispose() } })

test("a collapsed parent's chevron carries visible subsession statuses without reshaping the list", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  const rows = () => page.locator(".session-item-base").evaluateAll(elements => elements.map(el => el.getAttribute("data-session-id")))
  const chevron = (sessionId: string) => page.locator(`[data-session-id="${sessionId}"] .session-item-expander`)
  const color = (sessionId: string) => chevron(sessionId).evaluate(el => getComputedStyle(el).color)
  // The chevron transitions its colour; wait until it settles on the status token.
  const settlesOn = (sessionId: string, token: string) => page.waitForFunction(([id, name]) => {
    const probe = document.createElement("span")
    probe.style.color = `var(${name})`
    document.body.append(probe)
    const expected = getComputedStyle(probe).color
    probe.remove()
    return getComputedStyle(document.querySelector(`[data-session-id="${id}"] .session-item-expander`)!).color === expected
  }, [sessionId, token] as const)
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.locator('[data-session-id="other"]').waitFor()
    assert.deepEqual(await rows(), ["work", "other"])
    const workBox = await page.locator('[data-session-id="work"]').boundingBox()
    const idleColor = await color("other")
    assert.equal(await chevron("other").getAttribute("data-child-activity"), null)
    assert.equal(await chevron("other").getAttribute("aria-label"), "Expand session")

    // A subsession of another conversation starts: nothing opens, the collapsed parent's chevron is coloured.
    await page.evaluate(() => (window as any).fixture.status("other-grandchild", "working"))
    await page.waitForFunction(() => document.querySelector('[data-session-id="other"] .session-item-expander')?.getAttribute("data-child-activity") === "working")
    assert.deepEqual(await rows(), ["work", "other"])
    assert.deepEqual(await page.locator('[data-session-id="work"]').boundingBox(), workBox)
    assert.equal(await chevron("other").getAttribute("aria-label"), "Expand session — 1 subsession working")
    assert.equal(await chevron("other").getAttribute("title"), "Expand — 1 subsession working")
    await settlesOn("other", "--session-status-working-fg")
    assert.notEqual(await color("other"), idleColor)
    assert.equal(await chevron("other").locator(".disclosure-chevron").evaluate(el => getComputedStyle(el).animationName), "pulse")
    // No extra badge: the parent's own status area is untouched.
    assert.equal(await page.locator('[data-session-id="other"] .session-item-badges > *').count(), 0)

    // Input requests outrank work, stay steady and are counted in the label.
    await page.evaluate(() => (window as any).fixture.permission("other-child", true))
    await page.waitForFunction(() => document.querySelector('[data-session-id="other"] .session-item-expander')?.getAttribute("data-child-activity") === "permission")
    assert.equal(await chevron("other").getAttribute("aria-label"), "Expand session — 1 subsession needs input, 1 subsession working")
    await settlesOn("other", "--session-status-permission-fg")
    assert.equal(await chevron("other").locator(".disclosure-chevron").evaluate(el => getComputedStyle(el).animationName), "none")
    if (process.env.CODENOMAD_CHILD_ACTIVITY_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_CHILD_ACTIVITY_CAPTURE })

    // Expanding restores a plain chevron; the child rows show their own state.
    await chevron("other").click()
    await page.locator('[data-session-id="other-child"]').waitFor()
    assert.equal(await chevron("other").getAttribute("data-child-activity"), null)
    assert.equal(await chevron("other").getAttribute("aria-label"), "Collapse session")
    assert.equal(await chevron("other-child").getAttribute("data-child-activity"), "working")

    // Completing the nested helper turns its collapsed ancestors green, just like its Idle tag.
    await page.evaluate(() => {
      ;(window as any).fixture.permission("other-child", false)
      ;(window as any).fixture.status("other-grandchild", "idle")
    })
    await settlesOn("other-child", "--session-status-idle-fg")
    assert.equal(await chevron("other-child").getAttribute("aria-label"), "Expand session — 1 subsession idle")
    await chevron("other-child").click()
    await page.locator('[data-session-id="other-grandchild"] .session-idle').waitFor()
    assert.equal(await chevron("other-child").getAttribute("data-child-activity"), null)
    await chevron("other").click()
    await settlesOn("other", "--session-status-idle-fg")
    assert.equal(await chevron("other").locator(".disclosure-chevron").evaluate(el => getComputedStyle(el).animationName), "none")
    if (process.env.CODENOMAD_CHILD_ACTIVITY_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_CHILD_ACTIVITY_CAPTURE })

    // Work and input still outrank idle. Clearing the last unseen idle removes the green hint.
    await page.evaluate(() => (window as any).fixture.status("other-child", "compacting"))
    await settlesOn("other", "--session-status-compacting-fg")
    await page.evaluate(() => (window as any).fixture.permission("other-child", true))
    await settlesOn("other", "--session-status-permission-fg")
    await page.evaluate(() => {
      ;(window as any).fixture.permission("other-child", false)
      ;(window as any).fixture.status("other-child", "idle")
    })
    await settlesOn("other", "--session-status-idle-fg")
    assert.equal(await chevron("other").getAttribute("aria-label"), "Expand session — 2 subsessions idle")
    await page.evaluate(() => {
      ;(window as any).fixture.seen("other-child")
      ;(window as any).fixture.seen("other-grandchild")
    })
    assert.equal(await chevron("other").getAttribute("data-child-activity"), null)

    // Follow the existing idle visibility preference, including the seen-badge fade.
    await page.evaluate(() => (window as any).fixture.idle("other-grandchild", 1))
    await settlesOn("other", "--session-status-idle-fg")
    await page.evaluate(() => (window as any).fixture.keepIdle(false))
    assert.equal(await chevron("other").getAttribute("data-child-activity"), null)
    await page.evaluate(() => (window as any).fixture.idle("other-grandchild", Date.now()))
    await settlesOn("other", "--session-status-idle-fg")
    await page.waitForFunction(() => !document.querySelector('[data-session-id="other"] .session-item-expander')?.hasAttribute("data-child-activity"), undefined, { timeout: 8000 })
    await page.evaluate(() => (window as any).fixture.idle("other-grandchild", 1))
    await page.evaluate(() => (window as any).fixture.fade("other-grandchild"))
    await settlesOn("other", "--session-status-idle-fg")
    await page.evaluate(() => {
      ;(window as any).fixture.seen("other-grandchild")
      ;(window as any).fixture.endFade("other-grandchild", 1)
    })
    assert.equal(await chevron("other").getAttribute("data-child-activity"), null)

    // Neither interrupted nor retrying badges may be misrepresented as green idle.
    for (const extra of [{ generationRecovery: "interrupted" }, { retry: { attempt: 1, message: "Retry", next: 0 } }]) {
      await page.evaluate(extra => (window as any).fixture.idle("other-grandchild", Date.now(), extra), extra)
      assert.equal(await chevron("other").getAttribute("data-child-activity"), null)
    }

    // A subsession of the viewed conversation is revealed below it.
    await page.evaluate(() => (window as any).fixture.status("work-child", "working"))
    await page.locator('[data-session-id="work-child"]').waitFor()
    assert.deepEqual((await rows()).slice(0, 2), ["work", "work-child"])
    assert.deepEqual(await page.locator('[data-session-id="work"]').boundingBox(), workBox)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
