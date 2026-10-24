import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Locator, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"

// Optional: a directory receiving before/after screenshots of the reveal (dark theme).
const screenshots = process.env.CODENOMAD_REVEAL_SCREENSHOTS

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  try {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
      plugins: [shutdown.plugin, solid(), { name: "reveal-truncated-text-fixture", configureServer(s) {
        s.middlewares.use("/fixture", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/reveal-truncated-text.tsx"></script></body></html>'))
        })
      } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    })
    shutdown.own(server)
    await server.listen()
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  } catch (error) { if (server) await server.close(); else await cache.dispose(); throw error }
})
after(async () => { try { await browser?.close() } finally { await server?.close() } })

async function withFixture(run: (page: Page) => Promise<void>, query = "") {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: "en-US", colorScheme: "dark",
    permissions: ["clipboard-read", "clipboard-write"] })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(`${url}${query}`, { waitUntil: "domcontentloaded", timeout: 30_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => navigator.clipboard.writeText("clipboard sentinel"))
    await run(page)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
}

const longBlock = (page: Page) => page.locator('.message-stream-block[data-message-id="msg_a_long"]')
const TEXT_PART = '.message-stream-block[data-message-id="msg_a_long"] [data-part-type="text"]'
const textPart = (page: Page) => page.locator(TEXT_PART).first()
const readTool = (page: Page) => longBlock(page).locator('.tool-call[data-part-id="prt_long_read"]')
const taskTool = (page: Page) => longBlock(page).locator('.tool-call[data-part-id="prt_long_task"]')

/** Viewport offset of `label`'s first occurrence in the rendered text of `selector`, or null. */
function textOffset(page: Page, selector: string, label: string) {
  return page.evaluate(({ label, selector }) => {
    const stream = document.querySelector(".message-stream")!, bounds = stream.getBoundingClientRect()
    const walker = document.createTreeWalker(document.querySelector(`${selector} .markdown-body`)!, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const index = walker.currentNode.nodeValue!.indexOf(label)
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(walker.currentNode, index)
      range.setEnd(walker.currentNode, index + label.length)
      return range.getBoundingClientRect().top - bounds.top
    }
    return null
  }, { label, selector })
}

/**
 * Scrolls the transcript with real wheel gestures until `target` is mounted (upwards
 * first, then downwards from the top, since a restored position may lie on either side).
 */
async function scrollTo(page: Page, target: Locator) {
  const stream = page.locator(".message-stream")
  await stream.waitFor()
  const box = (await stream.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  let direction = -1
  for (let step = 0; step < 300 && await target.count() === 0; step++) {
    if (direction < 0 && await stream.evaluate(element => element.scrollTop <= 0)) direction = 1
    await page.mouse.wheel(0, direction * 1200)
    await page.waitForTimeout(30)
  }
  await target.first().scrollIntoViewIfNeeded()
}

async function scrollToBottom(page: Page) {
  const stream = page.locator(".message-stream")
  const box = (await stream.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let step = 0; step < 200; step++) {
    if (await stream.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop < 2)) break
    await page.mouse.wheel(0, 3000)
    await page.waitForTimeout(30)
  }
  await page.waitForTimeout(300)
}

async function shoot(page: Page, name: string, target: Locator) {
  if (!screenshots) return
  await mkdir(screenshots, { recursive: true })
  await target.screenshot({ path: join(screenshots, name) })
}

test("long text parts and tool outputs reveal in place, keep the reveal point and copy native text", { timeout: 120_000 }, async () => withFixture(async page => {
  const fixture = await page.evaluate(() => {
    const f = (window as any).fixture
    return { textHidden: f.textHidden as number, readHidden: f.readHidden as number, firstHidden: f.firstHiddenParagraph as string }
  })
  const textNotice = textPart(page).locator(".message-hidden-text")
  await scrollTo(page, textNotice)
  assert.equal(await textNotice.count(), 1)
  assert.match((await textNotice.textContent())!, new RegExp(`${fixture.textHidden.toLocaleString("en-US")} more characters hidden to keep this message responsive`))
  assert.ok(!(await textPart(page).textContent())!.includes("TEXT-TAIL-PROOF"))
  assert.equal(await textPart(page).getByText(/Output truncated for rendering/).count(), 0, "no copy-only suffix remains")

  // The reported case renders whole: prose uses the Markdown bound, not the tool-output one.
  await taskTool(page).getByText(/REPORT-TAIL-PROOF/).waitFor({ state: "attached" })
  assert.equal(await taskTool(page).locator(".message-hidden-text").count(), 0)
  if (screenshots) {
    const reportPane = taskTool(page).locator(".tool-call-task-section").last()
    await reportPane.scrollIntoViewIfNeeded()
    await reportPane.locator(".tool-call-markdown").evaluate(element => { element.scrollTop = element.scrollHeight })
    await shoot(page, "report-rendered-whole.png", reportPane)
  }

  const readNotice = readTool(page).locator(".message-hidden-text")
  await readNotice.waitFor({ state: "attached" })
  assert.match((await readNotice.textContent())!, new RegExp(`${fixture.readHidden.toLocaleString("en-US")} more characters hidden`))
  assert.ok(!(await readTool(page).textContent())!.includes("READ-TAIL-PROOF"))

  // Keyboard reveal of the text part: the reveal point stays where it was activated.
  await textNotice.scrollIntoViewIfNeeded()
  await page.locator(".message-stream").evaluate((stream, notice) => {
    const bounds = stream.getBoundingClientRect(), rect = notice!.getBoundingClientRect()
    stream.scrollTop += rect.top - bounds.top - stream.clientHeight * 0.6
  }, await textNotice.elementHandle())
  await page.waitForTimeout(200)
  const before = await textNotice.evaluate(notice => notice.getBoundingClientRect().top - notice.closest(".message-stream")!.getBoundingClientRect().top)
  await shoot(page, "text-before-reveal.png", page.locator(".message-stream"))
  const showAll = textNotice.getByRole("button", { name: "Show all", exact: true })
  await showAll.focus()
  await page.keyboard.press("Enter")
  await textPart(page).getByText(/TEXT-TAIL-PROOF/).waitFor({ state: "attached" })
  await textNotice.waitFor({ state: "detached" })
  await page.waitForTimeout(700)
  const boundary = await textOffset(page, TEXT_PART, fixture.firstHidden)
  assert.ok(boundary !== null && Math.abs(boundary - before) < 120, `The first revealed paragraph stays at the reveal point: ${JSON.stringify({ before, boundary })}`)
  await shoot(page, "text-after-reveal.png", page.locator(".message-stream"))
  assert.equal(await page.evaluate(selector => document.activeElement?.closest(selector) !== null
    && document.activeElement?.classList.contains("markdown-body"), TEXT_PART), true, "focus moves to the revealed text")
  await page.keyboard.press("Tab")
  assert.equal(await page.evaluate(selector => document.querySelector(`${selector} .markdown-body[tabindex]`), TEXT_PART), null,
    "the temporary programmatic focus target is released on blur")

  // The tool output reveals inside its own pane.
  await readNotice.scrollIntoViewIfNeeded()
  await shoot(page, "tool-before-reveal.png", readTool(page))
  await readNotice.getByRole("button", { name: "Show all", exact: true }).click()
  await readTool(page).getByText(/READ-TAIL-PROOF/).waitFor({ state: "attached" })
  assert.equal(await readNotice.count(), 0)
  await shoot(page, "tool-after-reveal.png", readTool(page))

  // Copy reads the native text, never the bounded projection.
  const header = readTool(page).locator(".tool-call-header")
  await header.hover()
  await header.getByRole("button", { name: "Copy tool output", exact: true }).click()
  await page.waitForFunction(async () => (await navigator.clipboard.readText()) !== "clipboard sentinel")
  assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"), await page.evaluate(() => (window as any).fixture.readOutput))
}))

test("revealing the latest message while following the bottom keeps the reveal point in view", { timeout: 120_000 }, async () => withFixture(async page => {
  const selector = '.message-stream-block[data-message-id="msg_c_long"] [data-part-type="text"]'
  const notice = page.locator(`${selector} .message-hidden-text`)
  await notice.waitFor()
  // No scrolling: the list settles at the bottom, where the reveal line is visible.
  await page.waitForFunction(() => {
    const stream = document.querySelector<HTMLElement>(".message-stream")
    const rect = document.querySelector(".message-hidden-text-button")?.getBoundingClientRect()
    return Boolean(stream && rect && rect.bottom > 0 && rect.top < innerHeight
      && stream.scrollHeight - stream.clientHeight - stream.scrollTop < 2)
  })
  const before = await notice.evaluate(element => element.getBoundingClientRect().top - element.closest(".message-stream")!.getBoundingClientRect().top)
  const firstHidden = await page.evaluate(() => (window as any).fixture.firstHiddenParagraph as string)
  await notice.getByRole("button", { name: "Show all", exact: true }).focus()
  await page.keyboard.press("Enter")
  await page.locator(selector).getByText(/TEXT-TAIL-PROOF/).waitFor({ state: "attached" })
  await page.waitForTimeout(900)
  const boundary = await textOffset(page, selector, firstHidden)
  const viewport = await page.locator(".message-stream").evaluate(element => element.clientHeight)
  assert.ok(boundary !== null && boundary >= 0 && boundary < viewport && Math.abs(boundary - before) < 120,
    `Bottom-following must not push the revealed text above the viewport: ${JSON.stringify({ before, boundary, viewport })}`)
}, "?session=reveal-c"))

test("reveals survive virtualization remounts and a session switch", { timeout: 120_000 }, async () => withFixture(async page => {
  const textNotice = textPart(page).locator(".message-hidden-text")
  await scrollTo(page, textNotice)
  await textNotice.getByRole("button", { name: "Show all", exact: true }).click()
  await textPart(page).getByText(/TEXT-TAIL-PROOF/).waitFor({ state: "attached" })
  const readNotice = readTool(page).locator(".message-hidden-text")
  await readNotice.scrollIntoViewIfNeeded()
  await readNotice.getByRole("button", { name: "Show all", exact: true }).click()
  await readTool(page).getByText(/READ-TAIL-PROOF/).waitFor({ state: "attached" })

  const assertRevealed = async (reason: string) => {
    await scrollTo(page, longBlock(page))
    await textPart(page).getByText(/TEXT-TAIL-PROOF/).waitFor({ state: "attached" })
    await readTool(page).getByText(/READ-TAIL-PROOF/).waitFor({ state: "attached" })
    assert.equal(await longBlock(page).locator(".message-hidden-text").count(), 0, `${reason}: no reveal line returns`)
  }

  await scrollToBottom(page)
  assert.equal(await longBlock(page).count(), 0, "the long message unmounts when scrolled away")
  await assertRevealed("virtualization remount")

  await page.evaluate(() => (window as any).fixture.switchTo("reveal-b"))
  await page.locator('.message-stream-block[data-message-id="msg_b_0000"]').waitFor()
  assert.equal(await longBlock(page).count(), 0)
  await page.evaluate(() => (window as any).fixture.switchTo("reveal-a"))
  await assertRevealed("session switch")
}))
