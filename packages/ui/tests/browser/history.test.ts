import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, baseUrl: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "history-fixture", configureServer(server) {
      server.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await server.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/history.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] }, server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  await server.listen()
  baseUrl = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

test("real search window counts, searches unloaded history and switches workspace scope without loading transcripts", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const errors: string[] = [], requests: any[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", async route => {
    if (!route.request().url().endsWith("/session-history/query")) return route.fulfill({ contentType: "application/json", body: "{}" })
    const input = route.request().postDataJSON(); requests.push(input)
    const scan = Number(input.cursor ?? 0)
    const result = { status: "page", scanned: 32, tools: 16, reasoning: 8, skipped: 0, candidates: [], hits: [] as any[], cursor: null as string | null }
    if (input.purpose === "stats") result.cursor = scan < 8 ? String(scan + 1) : null
    else if (input.query === "needle") {
      if (!input.cursor) result.cursor = "1"
      else {
        result.hits = [{ sessionID: input.sessionID ?? "other-session", messageID: `unloaded-${scan}`, role: "assistant", partIndex: 0, kind: "text", excerpt: input.sessionID ? `Old needle answer ${scan}` : `Workspace needle answer ${scan}` }]
        result.cursor = scan === 1 ? "2" : null
      }
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(result) })
  })
  try {
    await page.goto(`${baseUrl}/fixture`)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.open())
    await page.getByText("288 messages · 144 tools · 72 thinking blocks", { exact: false }).waitFor()
    await page.getByRole("searchbox").fill("needle")
    await page.getByText("Old needle answer 1", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Next results" }).click()
    await page.getByText("Old needle answer 2", { exact: true }).waitFor()
    assert.equal(await page.getByText("Old needle answer 1", { exact: true }).count(), 0, "result pages remain bounded")
    await page.getByRole("combobox", { name: "Search scope" }).selectOption("workspace")
    await page.getByText("Workspace needle answer 1", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.snapshot()), { ids: ["resident"], loads: 0, previewReads: [] })
    await page.getByText("Workspace needle answer 1", { exact: true }).click()
    await page.getByText("Full selected historical message", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.snapshot()), { ids: ["resident"], loads: 0, previewReads: ["unloaded-1"] })
    assert(requests.some(input => input.sessionID === undefined && input.purpose === "search"))
    const captures = path.join(os.tmpdir(), "opencode")
    await mkdir(captures, { recursive: true })
    await page.screenshot({ path: path.join(captures, "history-search-browser.png") })
    await page.evaluate(() => (window as any).fixture.deactivate())
    await page.getByRole("searchbox").waitFor({ state: "hidden" })
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error({ errors, requests, body: await page.locator("body").innerText() })
    throw error
  } finally { await page.close() }
})
