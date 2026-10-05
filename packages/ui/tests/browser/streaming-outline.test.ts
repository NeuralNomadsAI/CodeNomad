import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { readFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string, cache: string
before(async () => {
  cache = await mkdtemp(join(tmpdir(), "codenomad-streaming-outline-vite-"))
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)),
    logLevel: "error", cacheDir: cache, plugins: [solid(), {
      name: "streaming-outline-fixture", configureServer(server) {
        server.middlewares.use("/fixture", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await server.transformIndexHtml("/fixture", '<html><body><div id="root" style="display:flex;height:850px;width:1200px"></div><script type="module" src="/tests/browser/fixtures/streaming-outline.tsx"></script></body></html>'))
        })
      }, async load(id) {
        if (!id.replaceAll("\\", "/").endsWith("/src/components/session-outline-projection.ts")) return
        const source = process.env.CODENOMAD_OUTLINE_BASELINE
          ? await readFile(process.env.CODENOMAD_OUTLINE_BASELINE, "utf8") : await readFile(id, "utf8")
        // Count the real full-history implementation, without changing inputs,
        // outputs, scheduling or the production interface.
        return source.replace("const byMessage =", "(globalThis as any).__outlineWork ??= { calls: 0 }; (globalThis as any).__outlineWork.calls++; const byMessage =")
      },
    }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null } })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close(); if (cache) await rm(cache, { recursive: true, force: true }) })

test("real native token deltas do not reproject a 10k outline until resident markers change", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: route.request().url().includes("events") ? "text/event-stream" : "application/json", body: "{}" }))
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 })
    await page.waitForFunction(() => Boolean((window as any).outlineFixture), {}, { timeout: 60000 })
    await page.waitForFunction(() => (window as any).outlineFixture.snapshot().reads >= 20 && (window as any).outlineFixture.snapshot().calls > 0)
    await page.evaluate(() => (window as any).outlineFixture.start())
    await page.evaluate(() => (window as any).outlineFixture.delta("a"))
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const measurement = await page.evaluate(async () => {
      const fixture = (window as any).outlineFixture
      fixture.reset()
      const started = performance.now()
      for (let index = 0; index < 64; index++) { fixture.delta("a"); await new Promise(resolve => setTimeout(resolve, 5)) }
      return { ...fixture.snapshot(), ms: performance.now() - started }
    })
    assert.equal(measurement.calls, 0, "sub-bucket text deltas must not walk the entire outline")
    console.log("steady-outline", measurement)
    await page.evaluate(() => (window as any).outlineFixture.delta("b".repeat(64)))
    await page.waitForFunction(() => (window as any).outlineFixture.snapshot().calls > 0)
    const beforeLocale = await page.evaluate(() => (window as any).outlineFixture.snapshot().calls)
    await page.evaluate(() => (window as any).outlineFixture.locale("fr"))
    await page.waitForFunction(before => (window as any).outlineFixture.snapshot().calls > before, beforeLocale)
    await page.evaluate(() => (window as any).outlineFixture.finish("a".repeat(65) + "b".repeat(64)))
    assert.equal(await page.evaluate(() => (window as any).outlineFixture.snapshot().text), "a".repeat(65) + "b".repeat(64))
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
