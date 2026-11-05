import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdir } from "node:fs/promises"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { mediaFixture } from "../../../server/src/server/routes/session-media-fixture"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "upload-destination", routes: [{ path: "/fixture", html:
    '<html><body><div id="root" style="display:flex;height:700px;width:100%"></div><script type="module" src="/tests/browser/fixtures/device-upload.tsx"></script></body></html>' },
    { path: "/unknown", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/upload-destination-unknown.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

async function setup(locale = "en", execution = "A", unknown = false) {
  const page = await browser.newPage({ viewport: { width: 320, height: 800 }, deviceScaleFactor: 2 })
  const prompts: any[] = [], errors: string[] = [], unexpected: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(() => { (window as any).__name = Object })
  await page.route("**/*", route => {
    const target = new URL(route.request().url())
    if (target.origin === new URL(url).origin) return route.fallback()
    unexpected.push(target.origin)
    return route.fulfill({ status: 418, body: "No egress" })
  })
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/prompt")) prompts.push(route.request().postDataJSON())
    // Settings may begin loading during module evaluation, before the fixture's stub.
    if (path.endsWith("/storage/config/server")) return route.fulfill({ json: { opencodeServers: [
      { id: "A", kind: "explicit", label: "Shared lab" }, { id: "B", kind: "explicit", label: "Shared lab" },
    ] } })
    return route.fulfill({ json: path.endsWith("/prompt") ? { data: {} } : {} })
  })
  await page.goto(`${unknown ? url.replace(/\/fixture$/, "/unknown") : url}?locale=${locale}${execution ? `&execution=${execution}` : ""}`, { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => Boolean((window as any).fixture))
  return { page, prompts, errors, unexpected }
}

async function selectFile(page: Page, label: string, name = "device.txt") {
  await page.locator(".prompt-actions-menu-trigger").focus()
  await page.keyboard.press("Enter")
  const item = page.getByRole("menuitem", { name: label, exact: true })
  await item.focus()
  const choosing = page.waitForEvent("filechooser")
  await page.keyboard.press("Enter")
  const chooser = await choosing
  await chooser.setFiles({ name, mimeType: "text/plain", buffer: Buffer.from("bytes from this device") })
}

// prototype-1236: the composer carries no destination notice; the upload flow is unchanged.
const noNotice = async (page: Page) => assert.equal(await page.locator(".prompt-upload-notice, [role=note]").count(), 0)

test("ten locales: no destination notice, and user-selected bytes send normally", async () => {
  for (const locale of ["en", "fr", "de", "es", "he", "ja", "ne", "ru", "tr", "zh-Hans"]) {
    const copy = (await import(`../../src/lib/i18n/messages/${locale}/messaging.ts`)).messagingMessages
    const { page, prompts, errors, unexpected } = await setup(locale)
    try {
      const field = page.locator("textarea:visible").first()
      await field.waitFor()
      await noNotice(page)
      await field.fill("Keep my draft")
      await selectFile(page, copy["promptInput.attachFiles.title"])
      await page.waitForFunction(() => (window as any).fixture.attachments().length === 1)
      assert.equal(await field.inputValue(), "Keep my draft")
      assert.equal(await field.evaluate(field => document.activeElement === field), true)
      const metrics = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth, direction: document.documentElement.dir }))
      assert(metrics.page <= metrics.viewport)
      assert.equal(metrics.direction, locale === "he" ? "rtl" : "ltr")
      if (["en", "he"].includes(locale)) for (const appearance of ["dark", "light"] as const) {
        await page.emulateMedia({ colorScheme: appearance })
        await page.waitForFunction(appearance => document.documentElement.dataset.theme === appearance, appearance)
        assert.equal(await field.evaluate(field => document.activeElement === field), true)
        const directory = process.env.CODENOMAD_UPLOAD_DESTINATION_CAPTURES
        if (directory) {
          await mkdir(directory, { recursive: true })
          await page.screenshot({ path: `${directory}/${locale}-${appearance}-320-dpr2.png` })
        }
      }
      await page.getByRole("button", { name: copy["promptInput.send.ariaLabel"], exact: true }).click()
      await page.waitForFunction(() => (window as any).fixture.attachments().length === 0)
      assert.equal(prompts.length, 1)
      assert.deepEqual(prompts[0].files, [{ name: "device.txt", uri: `data:text/plain;base64,${Buffer.from("bytes from this device").toString("base64")}` }])
      assert.deepEqual(errors, []); assert.deepEqual(unexpected, [])
    } finally { await page.close() }
  }
})

test("source composer keeps its own destination across global tab changes and updates A/B at identical paths without touching draft, attachments or focus", async () => {
  const { page, errors } = await setup()
  try {
    const field = page.locator("textarea:visible").first()
    await field.fill("resident draft")
    await selectFile(page, "Attach file…")
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 1)
    const before = await page.evaluate(() => (window as any).fixture.attachments())
    await field.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(2, 5))
    await page.locator("#outside").focus()
    await page.evaluate(() => (window as any).fixture.globalTarget("another-project"))
    await noNotice(page)
    await page.evaluate(() => (window as any).fixture.bind("B"))
    assert.equal(await field.inputValue(), "resident draft")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.attachments()), before)
    assert.deepEqual(await field.evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd]), [2, 5])
    assert.equal(await page.evaluate(() => document.activeElement?.id), "outside")
    await page.evaluate(() => (window as any).fixture.bind("missing-label"))
    await page.evaluate(() => (window as any).fixture.bind("A", false))
    await noNotice(page)
    await page.evaluate(() => (window as any).fixture.forget())
    // SessionView retires its composer when its source occurrence disappears.
    await page.waitForFunction(() => !document.querySelector("textarea"))
    assert.equal(await page.evaluate(() => document.activeElement?.id), "outside")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("an unowned real composer shows no destination notice", async () => {
  const { page, errors } = await setup("en", "", true)
  try {
    await page.locator("textarea").first().waitFor()
    await noNotice(page)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

for (const roundtrip of [false, true]) test(`pending device read retires on same-directory binding change${roundtrip ? " A→B→A" : " A→B"}`, async () => {
  const { page, errors } = await setup()
  try {
    await page.evaluate(() => {
      const read = File.prototype.arrayBuffer
      File.prototype.arrayBuffer = function () {
        if (this.name !== "held.txt") return read.call(this)
        return new Promise(resolve => { (window as any).releaseRead = async () => { resolve(await read.call(this)); (window as any).finished = true } })
      }
    })
    await selectFile(page, "Attach file…", "held.txt")
    await page.waitForFunction(() => Boolean((window as any).releaseRead))
    await page.evaluate(() => (window as any).fixture.bind("B"))
    if (roundtrip) await page.evaluate(() => (window as any).fixture.bind("A"))
    await page.locator("#outside").focus()
    await page.evaluate(() => (window as any).releaseRead())
    await page.waitForFunction(() => (window as any).finished)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.attachments()), [])
    assert.equal(await page.evaluate(() => document.activeElement?.id), "outside")
    await selectFile(page, "Attach file…", "fresh.txt")
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("picker opened for an old same-directory binding cannot populate its replacement", async () => {
  const { page } = await setup()
  try {
    await page.locator(".prompt-actions-menu-trigger").click()
    const choosing = page.waitForEvent("filechooser")
    await page.getByRole("menuitem", { name: "Attach file…", exact: true }).click()
    const chooser = await choosing
    await page.evaluate(() => (window as any).fixture.bind("B"))
    await page.locator("#outside").focus()
    await chooser.setFiles({ name: "old.txt", mimeType: "text/plain", buffer: Buffer.from("stale") })
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.attachments()), [])
    assert.equal(await page.evaluate(() => document.activeElement?.id), "outside")
  } finally { await page.close() }
})

test("shared-local composer sends a device file without a destination notice", async () => {
  const { page, prompts, errors } = await setup("en", "")
  try {
    await page.locator("textarea").first().waitFor()
    await noNotice(page)
    await selectFile(page, "Attach file…")
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 1)
    await page.getByRole("button", { name: "Send message", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.attachments().length === 0)
    assert.equal(prompts.length, 1)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("the real media route's PNG decodes in Chromium after official-client ownership and digest reads", async t => {
  const f = await mediaFixture(t)
  const origin = await f.app.listen({ host: "127.0.0.1", port: 0 })
  const page = await browser.newPage()
  const requests: string[] = []
  await page.route("**/*", route => {
    requests.push(route.request().url())
    return new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 418, body: "No egress" })
  })
  try {
    await page.setContent(`<img id="served" src="${origin}${f.url()}">`)
    await page.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>("#served")
      return image?.complete && image.naturalWidth === 1 && image.naturalHeight === 1
    })
    assert.deepEqual(requests, [origin + f.url()])
    assert.equal(f.calls.filter(call => call.target === "A" && call.path === "/api/session/s").length, 2)
    assert.equal(f.calls.filter(call => call.target === "A" && call.path === "/api/session/s/message/m").length, 1)
  } finally { await page.close() }
})
