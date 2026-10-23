import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { REASONING_RENDER_CHARACTER_LIMIT } from "../../src/lib/message-render-cache"
import { TEXT_REVEAL_CHARACTER_STEP } from "../../src/lib/render-text-window"

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

const line = "Live reasoning keeps arriving while the model thinks past the display bound.\n"
const cardSelector = '.message-reasoning-card[data-part-id="msg_assistant-reasoning-0"]'
const textSelector = `${cardSelector} .message-reasoning-text`
const scrollerSelector = `${cardSelector} .message-reasoning-output`

/** The reasoning scroller's position: its offset and distance from the bottom. */
const scrollPosition = (page: Page) => page.evaluate(selector => {
  const scroller = document.querySelector(selector)!
  return { top: scroller.scrollTop, below: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop }
}, scrollerSelector)

/** Waits until the scroller follows its bottom, where the reveal line sits. */
const pinnedToBottom = (page: Page) => page.waitForFunction(selector => {
  const scroller = document.querySelector(selector)
  return Boolean(scroller && scroller.scrollTop > 0 && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 2)
}, scrollerSelector)

/** Asserts a reveal kept the reader where they clicked instead of following the new bottom. */
const assertKeptPlace = (at: { top: number }, now: { top: number; below: number }, context: string) => {
  assert.ok(Math.abs(now.top - at.top) <= 2, `${context}: the reader stays at the reveal point (${at.top} -> ${now.top})`)
  assert.ok(now.below > 1_000, `${context}: the revealed text lies below the reader (${now.below}px)`)
}

test("long streaming reasoning keeps a growing reveal, renders revealed text coalesced and keeps it after completion", { timeout: 90_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  /** Streams `count` small deltas a few milliseconds apart, like a model thinking. */
  const stream = (count: number) => page.evaluate(async ({ count, line }) => {
    for (let index = 0; index < count; index++) {
      ;(window as any).fixture.reasoningDelta(line.repeat(10))
      await new Promise(resolve => setTimeout(resolve, 15))
    }
  }, { count, line })
  const rendered = () => page.evaluate(selector => document.querySelector(selector)?.textContent?.length ?? 0, textSelector)
  const hidden = () => page.evaluate(selector => document.querySelector(`${selector} .message-hidden-text-label`)?.textContent ?? "", cardSelector)
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.revealThinking())
    await page.evaluate(() => (window as any).fixture.startReasoning())
    await stream(1)
    const card = page.locator(cardSelector)
    await card.waitFor()
    const toggle = card.locator(".message-reasoning-toggle")
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
    await page.waitForFunction(selector => (document.querySelector(selector)?.textContent?.length ?? 0) > 0, textSelector)

    // Past the bound the window keeps its prefix and the reveal line counts what arrives.
    await stream(20)
    await card.locator(".message-hidden-text").waitFor()
    const prefix = await rendered()
    assert.ok(prefix <= REASONING_RENDER_CHARACTER_LIMIT && prefix > REASONING_RENDER_CHARACTER_LIMIT * 0.9, `bounded window (got ${prefix})`)
    const before = await hidden()
    await stream(10)
    await page.waitForFunction(({ selector, before }) =>
      (document.querySelector(`${selector} .message-hidden-text-label`)?.textContent ?? "") !== before, { selector: cardSelector, before })
    assert.equal(await rendered(), prefix, "the bounded prefix does not re-render while the stream grows")

    // Show all reveals the live text below the reader; further deltas render at
    // most every 200 ms and leave the reader in place.
    await pinnedToBottom(page)
    const revealPoint = await scrollPosition(page)
    await card.getByRole("button", { name: "Show all" }).click()
    await page.waitForFunction(({ selector, prefix }) => (document.querySelector(selector)?.textContent?.length ?? 0) > prefix, { selector: textSelector, prefix })
    await page.waitForTimeout(300)
    assertKeptPlace(revealPoint, await scrollPosition(page), "streaming reveal")
    await page.evaluate(selector => {
      const pre = document.querySelector(selector)!
      ;(window as any).reasoningRenders = 0
      new MutationObserver(() => { (window as any).reasoningRenders++ }).observe(pre, { childList: true, characterData: true, subtree: true })
    }, textSelector)
    const pre = await page.evaluateHandle(selector => document.querySelector(selector)!, textSelector)
    await stream(120)
    assert.ok(await pre.evaluate(element => element.isConnected), "the streaming card updates in place")
    const renders = await page.evaluate(() => (window as any).reasoningRenders as number)
    assert.ok(renders > 0 && renders < 40, `120 deltas over ~2 s render coalesced (got ${renders})`)
    // 151 deltas of ten lines; the card trims the final line break.
    const streamed = line.length * 10 * 151 - 1
    assert.ok(streamed > 100_000)
    await page.waitForFunction(({ selector, streamed }) => document.querySelector(selector)?.textContent?.length === streamed, { selector: textSelector, streamed })
    assert.equal(await card.locator(".message-hidden-text").count(), 0, "the revealed stream stays whole")
    assertKeptPlace(revealPoint, await scrollPosition(page), "after more deltas")

    // Completion keeps the revealed text rather than cutting it back to the prefix.
    const final = await page.evaluate(selector => document.querySelector(selector)!.textContent!, textSelector)
    await page.evaluate(text => (window as any).fixture.endReasoning(text), final)
    await page.waitForTimeout(500)
    assert.equal(await rendered(), streamed, "the reader keeps what it revealed")
    assert.equal(final.length, streamed)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("revealing completed reasoning keeps the reader at the reveal point, also after following again", { timeout: 60_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  // Over the bound plus one reveal step: Show more first, then Show all.
  const text = line.repeat(4_000)
  assert.ok(text.length > REASONING_RENDER_CHARACTER_LIMIT + TEXT_REVEAL_CHARACTER_STEP)
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.revealThinking())
    await page.evaluate(() => (window as any).fixture.startReasoning())
    await page.evaluate(text => (window as any).fixture.reasoningDelta(text), text)
    await page.evaluate(text => (window as any).fixture.endReasoning(text), text)
    const card = page.locator(cardSelector)
    await card.waitFor()
    const toggle = card.locator(".message-reasoning-toggle")
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
    await card.locator(".message-hidden-text").waitFor()

    await pinnedToBottom(page)
    const first = await scrollPosition(page)
    await card.getByRole("button", { name: /^Show .* more$/ }).click()
    await page.waitForFunction(({ selector, length }) => (document.querySelector(selector)?.textContent?.length ?? 0) > length,
      { selector: textSelector, length: REASONING_RENDER_CHARACTER_LIMIT + TEXT_REVEAL_CHARACTER_STEP / 2 })
    await page.waitForTimeout(300)
    assertKeptPlace(first, await scrollPosition(page), "Show more")

    // Wheeling to the bottom follows again; Show all still keeps the reader in place.
    await page.locator(scrollerSelector).hover()
    await page.mouse.wheel(0, 1_000_000)
    await pinnedToBottom(page)
    await page.waitForTimeout(300)
    const second = await scrollPosition(page)
    await card.getByRole("button", { name: "Show all" }).click()
    await page.waitForFunction(({ selector, length }) => document.querySelector(selector)?.textContent?.length === length,
      { selector: textSelector, length: text.trimEnd().length })
    await page.waitForTimeout(300)
    assertKeptPlace(second, await scrollPosition(page), "Show all")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
