import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "message-part-virtualization-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/message-part-virtualization.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function withFixture(scenario: string, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: "en-US" })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(`${url}?scenario=${scenario}`, { waitUntil: "domcontentloaded", timeout: 30_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.locator('.message-stream-block[data-message-id="virtual-parts-message"]').waitFor()
    await run(page)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
}

// A string body: the test transpiler would inject `__name` into a named in-page helper.
const settle = (page: Page) => page.evaluate(`new Promise((resolve) => {
  let frames = 4
  const tick = () => --frames > 0 ? requestAnimationFrame(tick) : setTimeout(resolve, 30)
  requestAnimationFrame(tick)
})`)

/** Rendered parts of the long message, in DOM order, by native part index. */
const renderedParts = (page: Page, visibleOnly: boolean) => page.evaluate((visibleOnly) => {
  const stream = document.querySelector<HTMLElement>(".message-stream")!.getBoundingClientRect()
  const block = document.querySelector('.message-stream-block[data-message-id="virtual-parts-message"]')!
  const indexes: number[] = []
  for (const element of block.querySelectorAll<HTMLElement>("[data-part-id]")) {
    const rect = element.getBoundingClientRect()
    if (visibleOnly && (rect.bottom <= stream.top || rect.top >= stream.bottom || rect.height === 0)) continue
    const index = Number(/(\d+)$/.exec(element.dataset.partId!)![1])
    if (indexes.at(-1) !== index) indexes.push(index)
  }
  return indexes
}, visibleOnly)

const atBottom = (page: Page) => page.evaluate(() => {
  const stream = document.querySelector<HTMLElement>(".message-stream")!
  return stream.scrollHeight - stream.clientHeight - stream.scrollTop < 2
})

/** The part at the viewport center and its offset from the viewport top. */
const centerAnchor = (page: Page) => page.evaluate(() => {
  const stream = document.querySelector<HTMLElement>(".message-stream")!
  const rect = stream.getBoundingClientRect()
  const elements = [...document.querySelectorAll<HTMLElement>('.message-stream-block[data-message-id="virtual-parts-message"] [data-part-id]')]
  const target = elements.find(element => {
    const box = element.getBoundingClientRect()
    return box.height > 0 && box.top <= rect.top + rect.height / 2 && box.bottom > rect.top + rect.height / 2
  }) ?? elements.find(element => element.getBoundingClientRect().top >= rect.top)
  return target ? { id: target.dataset.partId!, top: target.getBoundingClientRect().top - rect.top } : null
})

const anchorTop = (page: Page, id: string) => page.evaluate((id) => {
  const stream = document.querySelector<HTMLElement>(".message-stream")!.getBoundingClientRect()
  const element = document.querySelector<HTMLElement>(`[data-part-id="${CSS.escape(id)}"]`)
  return element ? element.getBoundingClientRect().top - stream.top : null
}, id)

function assertContiguous(indexes: number[], context: string) {
  assert.ok(indexes.length > 0, `${context}: parts render in the viewport`)
  indexes.forEach((index, position) => {
    if (position > 0) assert.equal(index, indexes[position - 1] + 1, `${context}: parts render in order without gaps ${JSON.stringify(indexes)}`)
  })
}

test("a 3000-part message mounts a bounded number of parts at the followed bottom", { timeout: 60_000 }, async () => withFixture("static", async page => {
  await page.waitForFunction(() => document.querySelector('[data-part-id="tool-2999"]'))
  await settle(page)
  assert.ok(await atBottom(page), "Initial render follows the bottom of the long turn")
  const mounted = await renderedParts(page, false)
  assert.ok(mounted.length < 400, `Only chunks near the viewport render (${mounted.length} parts)`)
  assert.equal(mounted.at(-1), 2999)
  assert.ok(await page.locator('[data-virtual-chunk="placeholder"]').count() > 10, "Distant chunks are measured placeholders")
  assertContiguous(await renderedParts(page, true), "bottom")
}))

test("scrolling through a long message mounts the right parts in order without jumps", { timeout: 240_000 }, async () => withFixture("static", async page => {
  await page.waitForFunction(() => document.querySelector('[data-part-id="tool-2999"]'))
  await settle(page)
  // A real wheel gesture leaves bottom-following; later steps scroll natively.
  await page.mouse.move(500, 400)
  await page.mouse.wheel(0, -200)
  await page.waitForFunction(() => {
    const stream = document.querySelector<HTMLElement>(".message-stream")!
    return stream.scrollHeight - stream.clientHeight - stream.scrollTop > 100
  })
  await settle(page)
  const step = 700
  let reachedStart = false
  for (let index = 0; index < 400 && !reachedStart; index++) {
    const anchor = await centerAnchor(page)
    assert.ok(anchor, "A rendered part is at the viewport center")
    const moved = await page.evaluate((step) => {
      const stream = document.querySelector<HTMLElement>(".message-stream")!
      const before = stream.scrollTop
      stream.scrollTop -= step
      return before - stream.scrollTop
    }, step)
    await settle(page)
    const top = await anchorTop(page, anchor.id)
    if (top !== null) {
      assert.ok(Math.abs(top - (anchor.top + moved)) <= 2,
        `Part ${anchor.id} moved with the scroll only (expected ${anchor.top + moved}, got ${top}) at step ${index}`)
    }
    const visible = await renderedParts(page, true)
    assertContiguous(visible, `step ${index}`)
    assert.ok((await renderedParts(page, false)).length < 400, "The mounted window stays bounded while scrolling")
    reachedStart = visible[0] === 0
  }
  assert.ok(reachedStart, "Scrolling up reaches the first part of the turn")

  // And back down: chunks below render in order without moving the reader.
  for (let index = 0; index < 40; index++) {
    const anchor = (await centerAnchor(page))!
    const moved = await page.evaluate((step) => {
      const stream = document.querySelector<HTMLElement>(".message-stream")!
      const before = stream.scrollTop
      stream.scrollTop += step
      return before - stream.scrollTop
    }, step)
    await settle(page)
    const top = await anchorTop(page, anchor.id)
    if (top !== null) assert.ok(Math.abs(top - (anchor.top + moved)) <= 2, `Downward step ${index} keeps ${anchor.id} stable`)
    assertContiguous(await renderedParts(page, true), `downward step ${index}`)
  }
}))

test("following the bottom while parts stream into a long turn", { timeout: 90_000 }, async () => withFixture("streaming", async page => {
  await page.waitForFunction(() => document.querySelector('[data-part-id="tool-2999"]'))
  await settle(page)
  assert.ok(await atBottom(page))
  for (let round = 0; round < 25; round++) {
    const last = await page.evaluate(() => (window as any).fixture.append(3) as string)
    await page.waitForFunction((id) => document.querySelector(`[data-part-id="${id}"]`), last)
    await settle(page)
    assert.ok(await atBottom(page), `Round ${round} keeps following the bottom`)
    assert.ok(await page.evaluate((id) => {
      const stream = document.querySelector<HTMLElement>(".message-stream")!.getBoundingClientRect()
      const rect = document.querySelector(`[data-part-id="${id}"]`)!.getBoundingClientRect()
      return rect.bottom > stream.top && rect.top < stream.bottom
    }, last), `Round ${round} shows the newest part`)
  }
  assert.ok((await renderedParts(page, false)).length < 400, "Streaming keeps the mounted window bounded")
}))

test("search navigation renders and reveals a far part inside the long turn", { timeout: 60_000 }, async () => withFixture("static", async page => {
  await page.waitForFunction(() => document.querySelector('[data-part-id="tool-2999"]'))
  await settle(page)
  assert.equal(await page.locator('[data-part-id="virtual-parts-message-text-1501"]').count(), 0, "The far part starts unrendered")
  await page.evaluate(() => (window as any).fixture.openSearch())
  await page.getByPlaceholder("Search current chat...").fill("FAR-TARGET")
  await page.locator('.markdown-body[data-part-id="virtual-parts-message-text-1501"]').waitFor({ state: "attached" })
  const revealed = () => page.evaluate(() => {
    const stream = document.querySelector<HTMLElement>(".message-stream")!.getBoundingClientRect()
    const ranges = [...(CSS.highlights?.get("codenomad-search-active") ?? [])] as Range[]
    const range = ranges[0]
    if (!range) return null
    const rect = range.getBoundingClientRect()
    return { text: range.toString(), inPart: Boolean(range.startContainer.parentElement?.closest('[data-part-id="virtual-parts-message-text-1501"]')),
      visible: rect.bottom > stream.top && rect.top < stream.bottom }
  })
  await page.waitForFunction(() => {
    const stream = document.querySelector<HTMLElement>(".message-stream")!.getBoundingClientRect()
    const range = [...(CSS.highlights?.get("codenomad-search-active") ?? [])][0] as Range | undefined
    const rect = range?.getBoundingClientRect()
    return Boolean(rect && rect.bottom > stream.top && rect.top < stream.bottom)
  })
  assert.deepEqual(await revealed(), { text: "FAR-TARGET", inPart: true, visible: true })
  // Neighboring chunks settle after the reveal without pushing the target away.
  await page.waitForTimeout(500)
  await settle(page)
  assert.deepEqual(await revealed(), { text: "FAR-TARGET", inPart: true, visible: true })
  assertContiguous(await renderedParts(page, true), "search target")
}))
