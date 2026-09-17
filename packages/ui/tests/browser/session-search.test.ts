import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "session-search-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/session-search.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

test("search is flat, filters each session, selects only matches and restores the normal hierarchy", async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  const rows = () => page.locator(".session-item-base").evaluateAll(elements => elements.map(el => el.getAttribute("data-session-id")))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    const toggle = page.getByRole("switch", { name: "Show subsessions" })
    await page.locator('.session-item-base[data-session-id="parent"]').waitFor()
    assert.deepEqual(await rows(), ["local", "parent"])
    await toggle.check()
    assert.deepEqual(await rows(), ["child", "grandchild", "local", "parent"])
    assert.equal(await page.locator(".session-item-nested").count(), 0)
    assert.equal(await page.locator(".session-item-expander[aria-expanded]").count(), 0)
    assert.equal(await page.locator('[data-session-id="grandchild"] .worktree-indicator').innerText(), "feature")
    const sort = page.getByRole("combobox").first()
    await sort.selectOption("name")
    assert.deepEqual(await rows(), ["child", "grandchild", "local", "parent"])
    await sort.selectOption("worktree")
    assert.deepEqual(await rows(), ["grandchild", "parent", "child", "local"])
    await sort.selectOption("activity")
    assert.deepEqual(await rows(), ["child", "grandchild", "local", "parent"])
    const filter = page.getByRole("combobox", { name: "Filter sessions by worktree" })
    await filter.selectOption("/repo")
    assert.deepEqual(await rows(), ["child", "local"])
    const search = page.getByRole("textbox", { name: "Search sessions" })
    await search.fill("needle")
    await page.waitForFunction(() => (window as any).fixture.searches.some((s: any) => s.search === "needle"))
    await page.waitForFunction(() => document.querySelectorAll(".session-item-base").length === 1)
    assert.deepEqual(await rows(), ["child"])
    await page.getByRole("button", { name: "Select all sessions" }).click()
    assert.equal(await page.locator('.session-item-base input[type="checkbox"]:checked').count(), 1)
    await toggle.uncheck()
    assert.deepEqual(await rows(), [])
    assert.equal(await page.getByRole("button", { name: /Delete selected/ }).count(), 0)
    await toggle.check()
    assert.equal(await page.locator('.session-item-base input[type="checkbox"]:checked').count(), 0)
    await page.locator('[data-session-id="child"] .session-item-select').click()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.selected), ["child"])
    await filter.selectOption("/feature")
    await search.fill("remote")
    await page.locator('[data-session-id="orphan"]').waitFor()
    assert.deepEqual(await rows(), ["orphan"], "server result without its parent is independently renderable")
    assert.equal(await page.evaluate(() => (window as any).fixture.parentReads()), 0)
    await page.evaluate(() => (window as any).fixture.setSearchMode(false))
    await page.locator('[data-session-id="parent"]').waitFor()
    assert.equal(await page.getByRole("switch").count(), 0)
    assert.ok((await rows()).includes("parent"))
    assert.ok(await page.locator(".session-item-expander[aria-expanded]").count() > 0)
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error({ errors, body: await page.locator("body").innerText() })
    throw error
  } finally { await page.close() }
})
