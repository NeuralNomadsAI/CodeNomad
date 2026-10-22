import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { REASONING_RENDER_CHARACTER_LIMIT } from "../../src/lib/message-render-cache"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  try {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
      plugins: [shutdown.plugin, solid(), { name: "reasoning-stream", configureServer(s) {
        s.middlewares.use("/reasoning-fixture", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await s.transformIndexHtml("/reasoning-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/session.tsx"></script></body></html>'))
        })
      } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    })
    shutdown.own(server)
    await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/reasoning-fixture`
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  } catch (error) { if (server) await server.close(); else await cache.dispose(); throw error }
})
after(async () => { try { await browser?.close() } finally { await server?.close() } })

// A delta long enough that the third one carries the accumulated reasoning
// past the render bound.
const chunk = "Live reasoning keeps rendering while the model thinks past the display bound.\n".repeat(100)

const cardSelector = '.message-reasoning-card[data-part-id="msg_assistant-reasoning-0"]'
const textSelector = `${cardSelector} .message-reasoning-text`

test("streaming reasoning keeps rendering new text past the render bound", { timeout: 60_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.revealThinking())
    await page.evaluate(() => (window as any).fixture.startReasoning())
    await page.evaluate(delta => (window as any).fixture.reasoningDelta(delta), chunk)
    const card = page.locator(cardSelector)
    await card.waitFor()
    // Open the thoughts, as a user watching the model think.
    const toggle = card.locator(".message-reasoning-toggle")
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
    const renderedLength = () => page.evaluate(selector => document.querySelector(selector)?.textContent?.length ?? 0, textSelector)
    await page.waitForFunction(selector => (document.querySelector(selector)?.textContent?.length ?? 0) > 5000, textSelector)
    let previous = await renderedLength()
    assert.ok(previous > 5_000, `the first delta renders whole (got ${previous})`)

    for (let round = 2; round <= 3; round++) {
      await page.evaluate(delta => (window as any).fixture.reasoningDelta(delta), chunk)
      await page.waitForFunction(({ selector, minimum }) =>
        (document.querySelector(selector)?.textContent?.length ?? 0) > minimum, { selector: textSelector, minimum: previous }, { timeout: 10_000 })
      previous = await renderedLength()
      assert.ok(previous > chunk.length * round - 100, `delta ${round} renders whole (got ${previous})`)
    }
    assert.ok(previous > REASONING_RENDER_CHARACTER_LIMIT,
      `the live stream keeps rendering past the render bound (got ${previous})`)

    // Completing the part returns it to the bounded prefix; copy stays whole.
    await page.evaluate(text => (window as any).fixture.endReasoning(text), chunk.repeat(3))
    await page.waitForFunction(({ selector, expected }) =>
      (document.querySelector(selector)?.textContent?.length ?? 0) === expected,
      { selector: textSelector, expected: REASONING_RENDER_CHARACTER_LIMIT }, { timeout: 10_000 })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
