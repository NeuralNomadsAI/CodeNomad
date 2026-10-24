import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { chromium, type Browser } from "playwright"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, baseUrl: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [shutdown.plugin, solid(), { name: "history-fixture", configureServer(server) {
      server.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await server.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/history.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  shutdown.own(server)
  await server.listen()
  baseUrl = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await server?.close() })

test("search derives page progress from search responses without a separate count scan", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const errors: string[] = [], requests: any[] = []
  let releaseScan!: () => void
  const pauseScan = new Promise<void>(resolve => { releaseScan = resolve })
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", async route => {
    if (!route.request().url().endsWith("/session-history/query")) return route.fulfill({ contentType: "application/json", body: "{}" })
    const input = route.request().postDataJSON(); requests.push(input)
    const scan = Number(input.cursor ?? 0)
    const result = { status: "page", scanned: 32, tools: 16, reasoning: 8, skipped: 0, candidates: [], hits: [] as any[], cursor: null as string | null }
    if (input.query === "empty") result.scanned = 0
    if (input.query === "needle") {
      if (!input.cursor) result.cursor = "1"
      else {
        if (input.sessionID && scan === 2) await pauseScan
        // Workspace hits come two per session, so results group by conversation.
        result.hits = [{ sessionID: input.sessionID ?? `other-session-${Math.ceil(scan / 2)}`, messageID: `unloaded-${scan}`, role: "assistant", partIndex: 0, kind: "text", excerpt: input.sessionID ? `Old needle answer ${scan}` : `Workspace needle answer ${scan}` }]
        result.cursor = scan < 34 ? String(scan + 1) : null
      }
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(result) })
  })
  try {
    await page.goto(`${baseUrl}/fixture`)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.open())
    await page.getByRole("searchbox").waitFor()
    await page.getByRole("checkbox", { name: "Include tools and thinking" }).check()
    await page.getByRole("checkbox", { name: "Include tools and thinking" }).uncheck()
    assert.equal(requests.length, 0, "opening and toggling an empty search performs no scan")
    await page.getByRole("searchbox").fill("needle")
    await page.getByText("Old needle answer 1", { exact: true }).waitFor()
    await page.getByText("This page: 1 results · 64 messages scanned", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "Next results" }).isDisabled(), true, "partial results are visible while the next scan is pending")
    const focusedResult = await page.locator(".history-search-result").first().elementHandle()
    assert(focusedResult)
    await focusedResult.focus()
    releaseScan()
    await page.getByText("Old needle answer 32", { exact: true }).waitFor()
    await page.getByText("This page: 32 results · 1056 messages scanned", { exact: true }).waitFor()
    assert(await focusedResult.evaluate(element => element.isConnected && document.activeElement === element), "progress preserves the focused result button")
    await focusedResult.dispose()
    await page.getByRole("button", { name: "Next results" }).click()
    await page.getByText("Old needle answer 34", { exact: true }).waitFor()
    await page.getByText("This page: 2 results · 64 messages scanned", { exact: true }).waitFor()
    assert.equal(await page.getByText("Old needle answer 1", { exact: true }).count(), 0, "result pages remain bounded")
    assert.equal(await page.locator(".history-search-session").count(), 0, "session scope needs no conversation headers")
    assert.doesNotMatch(await page.locator(".history-search-results").innerText(), /unloaded-|other-session-/, "rows never show raw native IDs")
    await page.getByRole("combobox", { name: "Search scope" }).selectOption("workspace")
    await page.getByText("Workspace needle answer 1", { exact: true }).waitFor()
    await page.getByText("Workspace needle answer 32", { exact: true }).waitFor()
    await page.getByText("This page: 32 results · 1056 messages scanned", { exact: true }).waitFor()
    assert.equal(await page.locator(".history-search-result").count(), 32, "workspace results span many sessions and scan batches")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.snapshot()), { ids: ["resident"], loads: 0, previewReads: [] })
    // Each consecutive session group names its conversation and current worktree branch.
    const headers = page.locator(".history-search-session")
    assert.equal(await headers.count(), 16)
    await page.getByText("Conversation 16", { exact: true }).waitFor()
    assert.match(await headers.nth(0).innerText(), /Conversation 1\s*dev/)
    assert.match(await headers.nth(1).innerText(), /Conversation 2\s*feature\/search/)
    assert.equal((await headers.nth(2).innerText()).trim(), "Session unavailable", "a failed read names no worktree")
    assert.equal(await page.locator(".history-search-result").first().getAttribute("aria-describedby"), await headers.nth(0).getAttribute("id"))
    const labelReads = await page.evaluate(() => (window as any).fixture.sessionReads())
    assert.deepEqual([...labelReads.reads].sort(), Array.from({ length: 16 }, (_, index) => `other-session-${index + 1}`).sort(), "one read per conversation")
    assert.ok(labelReads.peak <= 4, `label reads stay bounded (peak ${labelReads.peak})`)
    assert.doesNotMatch(await page.locator(".history-search-results").innerText(), /unloaded-|other-session-/)
    await page.getByText("Workspace needle answer 1", { exact: true }).click()
    await page.getByText("Full selected historical message", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.snapshot()), { ids: ["resident"], loads: 0, previewReads: ["unloaded-1"] })
    assert(requests.some(input => input.sessionID === undefined && input.purpose === "search" && input.includeTechnical === false))
    const captures = path.join(os.tmpdir(), "opencode")
    await mkdir(captures, { recursive: true })
    await page.screenshot({ path: path.join(captures, "history-search-browser.png") })
    await page.getByRole("button", { name: "Next match", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.snapshot().previewReads.length === 2)
    assert.match(await page.locator(".history-search-result-active").innerText(), /Workspace needle answer 2$/)
    await page.getByRole("button", { name: "Next results", exact: true }).click()
    await page.getByText("Workspace needle answer 34", { exact: true }).waitFor()
    assert.match(await page.locator(".history-search-result-active").innerText(), /Workspace needle answer 33$/)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.snapshot()), { ids: ["resident"], loads: 0, previewReads: ["unloaded-1", "unloaded-2"] }, "replacing a page resets selection without navigating an intermediate match")
    await page.getByRole("checkbox", { name: "Include tools and thinking" }).check()
    await page.getByText("This page: 32 results · 1056 messages scanned", { exact: true }).waitFor()
    await page.getByRole("searchbox").fill("absent")
    await page.getByText("This page: 0 results · 32 messages scanned", { exact: true }).waitFor()
    await page.getByRole("searchbox").fill("empty")
    await page.getByText("This page: 0 results · 0 messages scanned", { exact: true }).waitFor()
    await page.getByRole("searchbox").fill("")
    await page.getByText("This page:", { exact: false }).waitFor({ state: "hidden" })
    assert(requests.every(input => input.purpose === "search"), "search never starts a separate statistics traversal")
    assert(requests.some(input => input.includeTechnical === true && input.query === "needle"))
    // Opening another conversation hydrates only it and anchors its transcript at the hit.
    await page.getByRole("searchbox").fill("needle")
    await page.getByText("Workspace needle answer 3", { exact: true }).click()
    const preview = page.locator(".history-message-preview")
    await preview.getByText("feature/search", { exact: true }).waitFor()
    await preview.getByText("3h ago", { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => (window as any).fixture.showDestinationPreview()), "preview")
    await preview.getByRole("button", { name: "Open in session" }).click()
    await page.waitForFunction(() => (window as any).fixture.opened().active === "other-session-2")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.opened()), { active: "other-session-2", anchor: "unloaded-3", surface: "chat" },
      "opening returns a destination left on its browser preview to the transcript")
    await page.evaluate(() => (window as any).fixture.deactivate())
    await page.getByRole("searchbox").waitFor({ state: "hidden" })
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error({ errors, requests, body: await page.locator("body").innerText() })
    throw error
  } finally { releaseScan(); await page.close() }
})
