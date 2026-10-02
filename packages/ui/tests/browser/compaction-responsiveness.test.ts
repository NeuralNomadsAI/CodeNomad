import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), {
      name: "compaction-counts",
      enforce: "pre",
      async transform(source, id) {
        if (id.endsWith("/stores/instances.ts") && process.env.CODENOMAD_COMPACTION_BASELINE) {
          return readFile(`${process.env.CODENOMAD_COMPACTION_BASELINE}/instances.ts`, "utf8")
        }
        if (!id.endsWith("/stores/opencode-data.ts")) return
        if (process.env.CODENOMAD_COMPACTION_BASELINE) source = await readFile(`${process.env.CODENOMAD_COMPACTION_BASELINE}/opencode-data.ts`, "utf8")
        // Observe the actual native reducer boundary, not a reimplemented reducer.
        return source.replace("for (const listener of listeners)", `
          if (details.type === "session.compaction.delta") {
            const counts = (window as any).compactionCounts?.deltas
            if (counts) counts[details.data.sessionID] = (counts[details.data.sessionID] ?? 0) + 1
          }
          for (const listener of listeners)`)
          .replace("const source = data.session.message.list(sessionId)", `
            const counts = (window as any).compactionCounts?.projections
            if (counts) counts[sessionId] = (counts[sessionId] ?? 0) + 1
            const source = data.session.message.list(sessionId)`)
      },
      configureServer(vite) {
        vite.middlewares.use("/compaction", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await vite.transformIndexHtml("/compaction", '<html><body><div id="root" style="display:flex;width:1100px;height:740px"></div><script type="module" src="/tests/browser/fixtures/compaction-responsiveness.tsx"></script></body></html>'))
        })
      },
    }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/compaction`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function fixture(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/*", route => {
    const request = new URL(route.request().url())
    if (request.hostname !== "127.0.0.1") return route.abort()
    if (request.pathname.startsWith("/api/")) return route.fulfill({ json: {} })
    return route.continue()
  })
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
    await page.waitForFunction(() => Boolean((window as any).compactionFixture), undefined, { timeout: 30_000 })
    await page.waitForTimeout(300)
    await run(page)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
}
const snapshot = (page: Page) => page.evaluate(() => (window as any).compactionFixture.snapshot())
const joined = (count: number) => Array.from({ length: count }, (_, index) => `[${index}]`).join("")

test("128 active deltas reduce and project once, preserve immediate revision, and end authoritatively", () => fixture(async page => {
  await page.evaluate(() => { const f = (window as any).compactionFixture; f.start(); f.resetCounts() })
  const before = await snapshot(page)
  const dispatchMs = await page.evaluate(() => (window as any).compactionFixture.burst("active"))
  const pending = await snapshot(page)
  console.log(JSON.stringify({ scenario: "active128-ingress", dispatchMs, counts: pending.counts }))
  assert.equal(pending.revision - before.revision, 128)
  assert.equal(pending.counts.deltas.active ?? 0, 0)
  assert.equal(pending.counts.projections.active ?? 0, 0)
  await page.waitForFunction(() => (window as any).compactionFixture.snapshot().active?.length > 0)
  const flushed = await snapshot(page)
  assert.equal(flushed.active, joined(128))
  assert.equal(flushed.counts.deltas.active, 1)
  assert.equal(flushed.counts.projections.active, 1)
  assert.equal(flushed.messageLists, 0)
  console.log(JSON.stringify({ scenario: "active128", dispatchMs, counts: flushed.counts }))
  await page.evaluate(() => { const f = (window as any).compactionFixture; f.burst("active", 4); f.end("active", "authoritative final") })
  await page.waitForTimeout(300)
  const final = await snapshot(page)
  assert.equal(final.active, "authoritative final")
  assert.equal(final.counts.deltas.active, 1, "terminal final text cancels pending fragments")
}))

test("spaced native events coalesce per interval without losing chunks or affecting the other session", () => fixture(async page => {
  await page.evaluate(() => { const f = (window as any).compactionFixture; f.start(); f.resetCounts() })
  for (let phase = 1; phase <= 2; phase++) {
    await page.evaluate(() => (window as any).compactionFixture.phase("active"))
    await page.waitForFunction(phase => (window as any).compactionFixture.snapshot().active ===
      Array.from({ length: 8 }, (_, index) => `[${index}]`).join("").repeat(phase), phase)
    const state = await snapshot(page)
    assert.equal(state.counts.deltas.active, phase)
    assert.equal(state.counts.projections.active, phase)
    assert.equal(state.messageLists, 0)
  }
}))

test("never-loaded inactive compaction allocates no reducer payload; activation and remount hydrate exact final text", () => fixture(async page => {
  await page.evaluate(() => { const f = (window as any).compactionFixture; f.resetCounts(); f.start("inactive"); f.burst("inactive"); f.end("inactive", "saved summary") })
  await page.waitForTimeout(300)
  const inactive = await snapshot(page)
  assert.deepEqual(inactive.counts, { deltas: {}, projections: {} })
  assert.equal(inactive.inactive, undefined)
  assert.equal(inactive.messageLists, 0)
  await page.evaluate(() => (window as any).compactionFixture.activate("inactive"))
  await page.waitForFunction(() => (window as any).compactionFixture.snapshot().inactive === "saved summary")
  await page.evaluate(() => (window as any).compactionFixture.unmount())
  await page.evaluate(() => (window as any).compactionFixture.remount())
  await page.waitForFunction(() => (window as any).compactionFixture.snapshot().inactive === "saved summary")
  assert.equal((await snapshot(page)).active, undefined)
}))

test("activation during an unobserved compaction hydrates then resumes exact streaming summary", () => fixture(async page => {
  await page.evaluate(() => { const f = (window as any).compactionFixture; f.seed("inactive", 199); f.start("inactive"); f.burst("inactive", 4); f.activate("inactive") })
  await page.waitForFunction(() => (window as any).compactionFixture.snapshot().inactive === "[0][1][2][3]")
  await page.evaluate(() => (window as any).compactionFixture.burst("inactive", 2))
  await page.waitForFunction(() => (window as any).compactionFixture.snapshot().inactive === "[0][1][2][3][0][1]")
  await page.evaluate(() => { const f = (window as any).compactionFixture; f.resetCounts(); f.burst("inactive", 2) })
  await page.waitForFunction(() => (window as any).compactionFixture.snapshot().inactive === "[0][1][2][3][0][1][0][1]")
  const resumed = await snapshot(page)
  assert.equal(resumed.counts.deltas.inactive, 1)
  assert.equal(resumed.counts.projections.inactive, 1)
  assert.equal(resumed.messageLists, 0)
  assert.equal(resumed.ids.length, 200, "SDK's 20-row recovery must retain the hydrated native 200-row window")
}))

test("a loaded but inactive reducer batches text, does not hydrate its hidden view, and returns without duplication", () => fixture(async page => {
  await page.evaluate(() => { const f = (window as any).compactionFixture; f.start(); f.activate("inactive"); f.resetCounts(); f.burst("active", 4) })
  await page.waitForTimeout(300)
  const hidden = await snapshot(page)
  assert.equal(hidden.counts.deltas.active, 1)
  assert.equal(hidden.counts.projections.active ?? 0, 0)
  assert.equal(hidden.active, "", "hidden visible snapshot is revalidated, not hydrated by every delta")
  await page.evaluate(() => (window as any).compactionFixture.activate("active"))
  await page.waitForFunction(() => (window as any).compactionFixture.snapshot().active === "[0][1][2][3]")
  await page.evaluate(() => (window as any).compactionFixture.burst("active", 2))
  await page.waitForFunction(() => (window as any).compactionFixture.snapshot().active === "[0][1][2][3][0][1]")
}))
