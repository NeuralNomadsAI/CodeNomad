import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Locator, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "full-source-copy-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/full-source-copy.tsx"></script></body></html>'))
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
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: "en-US",
    hasTouch: false, isMobile: false, permissions: ["clipboard-read", "clipboard-write"] })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(`${url}?scenario=${scenario}`, { waitUntil: "domcontentloaded", timeout: 30_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    assert.equal(await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches), true)
    await page.evaluate(() => navigator.clipboard.writeText("clipboard sentinel"))
    await run(page)
    assert.deepEqual(errors, [])
    assert.ok(await page.evaluate(() => (window as any).fixture.requests.length > 0))
  } catch (error) {
    console.error("Full-source fixture failure", scenario, errors, (await page.locator("main").textContent())?.slice(0, 2000))
    throw error
  } finally { await context.close() }
}

async function copyWithPointer(page: Page, button: Locator): Promise<string> {
  await button.scrollIntoViewIfNeeded()
  await button.hover()
  assert.deepEqual(await button.evaluate(element => {
    const style = getComputedStyle(element)
    return { opacity: style.opacity, pointerEvents: style.pointerEvents }
  }), { opacity: "1", pointerEvents: "auto" }, "Body actions must remain visible and pointer-accessible on desktop")
  // Real hit testing: no forced click, DOM event dispatch, or CSS overrides.
  await button.click()
  await page.waitForFunction(async () => (await navigator.clipboard.readText()) !== "clipboard sentinel")
  return page.evaluate(() => navigator.clipboard.readText())
}

for (const scenario of ["diagnostics-many", "diagnostics-long"]) {
  test(`${scenario}: desktop body copy retains original diagnostics beyond the bounded preview`, { timeout: 45_000 }, async () => withFixture(scenario, async page => {
    await page.locator(".tool-call-diagnostics-heading").click()
    const region = page.locator(".tool-call-diagnostics")
    const rows = region.getByRole("listitem")
    assert.equal(await rows.count(), scenario === "diagnostics-many" ? 100 : 1)
    const lengths = await rows.locator(".tool-call-diagnostic-message").evaluateAll(elements => elements.map(element => element.textContent!.length))
    assert.ok(lengths.every(length => length <= 2000))
    if (scenario === "diagnostics-long") assert.equal(lengths[0], 2000)
    const original = await page.evaluate(() => (window as any).fixture.diagnostics)
    const before = await region.locator("*").count()
    const copied = await copyWithPointer(page, region.getByRole("button", { name: "Copy tool output", exact: true }))
    assert.deepEqual(JSON.parse(copied), original)
    assert.equal(await region.locator("*").count(), before, "Copy must not expand the preview DOM")
    assert.ok(before < 1000)
  }))
}

test("message parts beyond the display limit reveal in place at the omission", { timeout: 90_000 }, async () => withFixture("parts", async page => {
  const block = page.locator('.message-stream-block[data-message-id="full-source-message"]')
  const gap = block.locator(".message-hidden-parts")
  await gap.waitFor()
  const paragraphs = async () => (await block.textContent())!.match(/Paragraph \d{4}/g) ?? []
  const rendered = await paragraphs()
  assert.equal(rendered.length, 1000)
  assert.ok(rendered.includes("Paragraph 0000") && rendered.includes("Paragraph 1236"))
  assert.ok(!rendered.includes("Paragraph 0618"), "The omitted middle must not render before it is revealed")
  assert.match((await gap.textContent())!, /238 items hidden/)
  assert.equal(await block.locator(".tool-call-diagnostic-message").count(), 0, "No copy-only truncation footer remains")
  assert.equal(await block.locator('.tool-call-message[data-part-id="hidden-range-tool"]').count(), 0)
  const timeline = page.locator("[data-segment-count]")
  assert.equal(await timeline.getAttribute("data-segment-count"), "1", "The omitted tool has no timeline marker yet")

  // The placeholder sits exactly where the omitted parts belong.
  const order = await block.evaluate((element) => {
    const text = element.textContent!
    const marker = element.querySelector(".message-hidden-parts")!.textContent!
    return { head: text.indexOf("Paragraph 0499"), gap: text.indexOf(marker), tail: text.indexOf("Paragraph 0737") }
  })
  assert.ok(order.head >= 0 && order.head < order.gap && order.gap < order.tail, JSON.stringify(order))

  // Keyboard activation: the placeholder unmounts, so focus must stay in the message.
  const button = gap.getByRole("button", { name: "Show 238 more", exact: true })
  await button.scrollIntoViewIfNeeded()
  await button.focus()
  await page.keyboard.press("Enter")
  await gap.waitFor({ state: "detached" })
  const revealed = await paragraphs()
  assert.equal(revealed.length, 1237)
  assert.deepEqual(revealed, Array.from({ length: 1237 }, (_, index) => `Paragraph ${String(index).padStart(4, "0")}`))
  await block.locator('.tool-call-message[data-part-id="hidden-range-tool"]').waitFor({ state: "attached" })
  await page.waitForFunction(() => document.querySelector("[data-segment-count]")?.getAttribute("data-segment-count") === "3")
  // Focus lands on the first revealed part, not after text merged into the preceding row.
  await page.waitForFunction(() => document.activeElement?.closest('.message-stream-block[data-message-id="full-source-message"]')
    && document.activeElement.closest("[data-part-id]")?.textContent?.includes("Paragraph 0500"))
  await page.keyboard.press("Tab")
  assert.equal(await page.evaluate(() => document.querySelector("[tabindex='-1'][data-part-id]")), null,
    "The temporary programmatic focus target is released on blur")
}))

for (const { scenario, firstRevealed } of [{ scenario: "parts-group", firstRevealed: "group-read-0" }, { scenario: "parts-merge", firstRevealed: "merge-read-1" }]) {
  test(`${scenario}: revealing into a collapsed tool group focuses its toggle at the reveal point`, { timeout: 90_000 }, async () => withFixture(scenario, async page => {
    const block = page.locator('.message-stream-block[data-message-id="full-source-message"]')
    const gap = block.locator(".message-hidden-parts")
    await gap.waitFor()
    const button = gap.getByRole("button", { name: "Show 240 more", exact: true })
    await button.scrollIntoViewIfNeeded()
    await button.focus()
    await page.keyboard.press("Enter")
    await gap.waitFor({ state: "detached" })
    const group = block.locator(`.message-exploration-group[data-group-part-ids~="${firstRevealed}"]`)
    await group.waitFor({ state: "attached" })
    assert.equal(await block.locator(`[data-part-id="${firstRevealed}"]`).count(), 0, "The group starts collapsed")
    // Its members render no part elements, so focus must not skip past it.
    await page.waitForFunction((id) => document.activeElement?.matches(".message-technical-group-toggle")
      && document.activeElement.closest("[data-group-part-ids]")?.getAttribute("data-group-part-ids")?.split(" ").includes(id), firstRevealed)
  }))
}

test("tool-error body copies the complete error beyond the 10000-character preview", { timeout: 45_000 }, async () => withFixture("error", async page => {
  const body = page.locator(".tool-call-error-content")
  await body.waitFor()
  const original = await page.evaluate(() => (window as any).fixture.error as string)
  assert.ok(original.length > 10_000)
  assert.ok((await body.textContent())!.length < 10_200)
  assert.ok(!(await body.textContent())!.includes("END-ERROR"))
  const before = await body.locator("*").count()
  const copied = await copyWithPointer(page, body.getByRole("button", { name: "Copy tool output", exact: true }))
  // Chromium's real Windows clipboard normalizes LF to CRLF on readback.
  assert.equal(copied.replace(/\r\n/g, "\n"), original)
  assert.equal(await body.locator("*").count(), before)
  assert.ok(before < 20)
}))

test("todo overflow footer copies every original todo while rendering at most 200 rows", { timeout: 45_000 }, async () => withFixture("todo", async page => {
  const region = page.locator(".tool-call-todo-region")
  await region.waitFor()
  assert.equal(await region.getByRole("listitem").count(), 200)
  assert.ok(!(await region.textContent())!.includes("Task 236"))
  const before = await region.locator("*").count()
  const copied = await copyWithPointer(page, region.getByRole("button", { name: "Copy tool output", exact: true }))
  assert.deepEqual(JSON.parse(copied), await page.evaluate(() => (window as any).fixture.todos))
  assert.equal(await region.getByRole("listitem").count(), 200)
  assert.equal(await region.locator("*").count(), before)
  assert.ok(before < 2500)
}))

test("oversized tool input copies complete JSON from its inner IO header, independently of output", { timeout: 45_000 }, async () => withFixture("input", async page => {
  const inputSection = page.locator(".tool-call-io-section").first()
  await inputSection.waitFor()
  const original = await page.evaluate(() => (window as any).fixture.input)
  assert.ok(JSON.stringify(original).length > 20_000)
  const preview = await inputSection.locator(".tool-call-io-body").textContent()
  assert.ok(preview!.length < 1000, "Oversized input must render a bounded omission placeholder")
  assert.match(preview!, /Structured output omitted from rendering/)
  assert.ok(!preview!.includes("INPUT-END"))
  const before = await inputSection.locator("*").count()
  const copied = await copyWithPointer(page, inputSection.getByRole("button", { name: "Copy tool input", exact: true }))
  assert.deepEqual(JSON.parse(copied), original)
  assert.ok(await inputSection.locator("*").count() < 100, "Highlighting and copy must retain the bounded placeholder DOM")
  assert.match((await inputSection.locator(".tool-call-io-body").textContent())!, /Structured output omitted from rendering/)
  assert.ok(before < 100)

  // The outer header's alternate copy route is output-only, so it cannot
  // substitute for the input button when the arguments have been omitted.
  await page.evaluate(() => navigator.clipboard.writeText("clipboard sentinel"))
  const header = page.locator(".tool-call > .tool-call-header")
  await header.hover()
  await header.getByRole("button", { name: "Copy tool output", exact: true }).click()
  await page.waitForFunction(async () => (await navigator.clipboard.readText()) !== "clipboard sentinel")
  const output = await page.evaluate(() => navigator.clipboard.readText())
  assert.equal(output, await page.evaluate(() => (window as any).fixture.output))
  assert.notEqual(output, copied)
}))
