import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "interruptions-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/interruption-dock.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function fixture(width = 1100) {
  const page = await browser.newPage({ viewport: { width, height: 800 } })
  page.setDefaultTimeout(15000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).fixture?.snapshot().ids.length))
  return { page, errors }
}
const answer = (page: Page) => page.locator('.interruption-dock input[type="text"]:visible')

test("source navigation closes file previews and loads the source transcript", async () => {
  const { page, errors } = await fixture()
  try {
    await page.evaluate(() => { (window as any).fixture.ask(); (window as any).fixture.preview() })
    await page.waitForFunction(() => (window as any).fixture.hasPreview())
    await answer(page).fill("Preserved through preview")
    await page.getByRole("button", { name: "View in conversation" }).click()
    await page.locator('[data-interruption-reveal="true"]').waitFor()
    assert.equal(await page.evaluate(() => (window as any).fixture.hasPreview()), false)
    assert.equal(await answer(page).inputValue(), "Preserved through preview")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("explicit reveal invalidates the resident hidden permission tool's display cache", async () => {
  const { page, errors } = await fixture()
  try {
    await page.evaluate(() => (window as any).fixture.hiddenPermission())
    await page.getByRole("button", { name: "View in conversation" }).waitFor()
    assert.equal(await page.locator('.tool-call').count(), 0)
    await page.getByRole("button", { name: "View in conversation" }).click()
    await page.locator('[data-interruption-reveal="true"]').waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.windows), [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("source navigation dismisses the mission reader and restores an interactive transcript", async () => {
  const { page, errors } = await fixture()
  try {
    await page.evaluate(() => { (window as any).fixture.ask(); (window as any).fixture.missionReader() })
    await page.locator('.mission-transcript-content[inert]').waitFor({ state: "attached" })
    await page.getByRole("button", { name: "View in conversation" }).click()
    await page.locator('[data-interruption-reveal="true"]').waitFor()
    assert.equal(await page.evaluate(() => (window as any).fixture.hasMissionReader()), false)
    assert.equal(await page.locator('.mission-transcript-content').evaluate(element => element.hasAttribute("inert")), false)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("badge opens the dock independent of loaded history; source navigation and native answer receipt survive reload", async () => {
  const { page, errors } = await fixture()
  try {
    await page.locator(".prompt-input").fill("Keep my draft")
    await page.evaluate(() => (window as any).fixture.ask())
    await answer(page).waitFor()
    assert.equal(await page.locator('.message-stream .form-request').count(), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.snapshot().ids.includes("msg_0000")), false)
    await page.getByRole("button", { name: "Expand or collapse requests" }).click()
    await page.locator(".permission-center-trigger").click()
    await answer(page).fill("Use the dock")
    await page.getByRole("button", { name: "View in conversation" }).click()
    await page.locator('[data-interruption-reveal="true"]').waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.windows), [{ kind: "around", messageID: "msg_0000" }])
    assert.equal(await answer(page).inputValue(), "Use the dock")
    await page.locator('.interruption-dock button[type="submit"]').click()
    await page.locator(".interruption-dock").waitFor({ state: "detached" })
    assert.equal(await page.locator(".prompt-input").inputValue(), "Keep my draft")
    await page.evaluate(() => (window as any).fixture.rehydrate())
    await page.locator(".interruption-receipt dd").filter({ hasText: "Use the dock" }).waitFor()
    assert.equal(await page.locator(".interruption-receipt dt").innerText(), "Which approach?")
    assert.equal(await page.evaluate(() => (window as any).fixture.replies.length), 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a live native question becomes a durable transcript receipt after dock submission", async () => {
  const { page, errors } = await fixture()
  try {
    await page.evaluate(() => (window as any).fixture.liveAsk())
    await answer(page).fill("Native event answer")
    await page.locator('.interruption-dock button[type="submit"]').click()
    await page.locator(".interruption-dock").waitFor({ state: "detached" })
    await page.locator(".interruption-receipt dd").filter({ hasText: "Native event answer" }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("partial answers survive refresh, request navigation and session remount; failed sends stay retryable", async () => {
  const { page, errors } = await fixture()
  try {
    await page.evaluate(() => (window as any).fixture.ask())
    await answer(page).fill("Partial answer")
    await page.evaluate(() => { (window as any).fixture.refresh(); (window as any).fixture.other() })
    await page.getByRole("button", { name: "Next request", exact: true }).click()
    await answer(page).fill("Other answer")
    await page.evaluate(() => (window as any).fixture.switch("other"))
    assert.equal(await answer(page).inputValue(), "Other answer")
    await page.evaluate(() => (window as any).fixture.switch("s"))
    assert.equal(await answer(page).inputValue(), "Partial answer")
    await page.evaluate(() => (window as any).fixture.fail(true))
    await page.locator('.interruption-dock button[type="submit"]:visible').click()
    await page.getByText("Reply failed", { exact: true }).waitFor()
    assert.equal(await answer(page).inputValue(), "Partial answer")
    await page.evaluate(() => { (window as any).fixture.fail(false); (window as any).fixture.hold() })
    await page.locator('.interruption-dock button[type="submit"]:visible').click()
    assert.equal(await page.locator('.interruption-dock button[type="submit"]:visible').isDisabled(), true)
    await page.evaluate(() => (window as any).fixture.release())
    await page.waitForFunction(() => !(window as any).fixture.snapshot().forms.includes("question"))
    assert.equal(await answer(page).inputValue(), "Other answer")
    assert.equal(await page.evaluate(() => (window as any).fixture.replies.length), 2)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("mobile dock handles source-less permissions, global Forms and remote settlement", async () => {
  const { page, errors } = await fixture(393)
  try {
    await page.evaluate(() => { (window as any).fixture.ask(); (window as any).fixture.permission() })
    await page.evaluate(() => (window as any).fixture.focus("permission"))
    await page.getByRole("button", { name: "Allow Once", exact: true }).click()
    await answer(page).waitFor()
    await page.evaluate(() => (window as any).fixture.remoteReply())
    await page.locator(".interruption-dock").waitFor({ state: "detached" })
    await page.evaluate(() => (window as any).fixture.global())
    await page.getByText("Service request", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "View in conversation" }).count(), 0)
    await answer(page).fill("Global answer")
    await page.screenshot({ path: join(tmpdir(), "interruption-dock-mobile.png") })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    const bounds = await page.locator(".interruption-dock").boundingBox()
    assert.ok(bounds && bounds.height < 400 && bounds.y >= 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
