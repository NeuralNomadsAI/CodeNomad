import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHfoAAAAASUVORK5CYII="
before(async () => {
  const fixture = await borrowFixture({ name: "media-workspace-owner", routes: [{ path: "/fixture",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/media-workspace-owner.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

async function withPage(delayed: boolean, run: (page: Page, requests: string[]) => Promise<void>) {
  const page = await browser.newPage()
  const errors: string[] = [], requests: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(() => {
    ;(window as any).__name = Object
    ;(window as any).restrictedMedia = false
    ;(window as any).forbiddenMediaIntents = []
    const check = (value: string) => {
      if ((window as any).restrictedMedia && /^https?:/i.test(value)) (window as any).forbiddenMediaIntents.push(value)
    }
    const html = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!
    Object.defineProperty(Element.prototype, "innerHTML", { ...html, set(value: string) {
      if (!(this instanceof HTMLTemplateElement)) {
        const template = document.createElement("template")
        html.set!.call(template, value)
        for (const image of template.content.querySelectorAll("img[src]")) check(image.getAttribute("src")!)
      }
      html.set!.call(this, value)
    } })
    const attribute = Element.prototype.setAttribute
    Element.prototype.setAttribute = function(name, value) { if (name.toLowerCase() === "src") check(value); return attribute.call(this, name, value) }
    const source = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!
    Object.defineProperty(HTMLImageElement.prototype, "src", { ...source, set(value: string) { check(value); source.set!.call(this, value) } })
  })
  await page.route("**/*", route => {
    const request = route.request().url()
    if (new URL(request).origin === new URL(url).origin) return route.fallback()
    requests.push(request)
    return request === "http://127.0.0.1:4333/project-image.png"
      ? route.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") })
      : route.fulfill({ status: 418, body: "No real egress" })
  })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url + (delayed ? "?delayed=1" : ""), { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForFunction(() => (window as any).workspaceReview?.reads() === 1)
    await run(page, requests)
    assert.deepEqual(errors, [])
    assert.equal(await page.evaluate(() => (window as any).workspaceReview.reads()), 1)
    assert.equal(await page.evaluate(() => (window as any).workspaceReview.explicitReads()), 0)
    assert.deepEqual(await page.evaluate(() => (window as any).forbiddenMediaIntents), [])
  } finally { await page.close() }
}

test("resident project Markdown revokes its local HTTP image on explicit loopback rebind", () => withPage(false, async (page, requests) => {
  await page.waitForFunction(() => ["workspace-caller", "owner-control"].every(id => document.querySelector<HTMLImageElement>(`#${id} img`)?.naturalWidth === 1))
  assert.ok(requests.length > 0, "the local reader and owned control really decode the fixture PNG")
  const before = requests.length
  await page.evaluate(() => { (window as any).restrictedMedia = true; (window as any).workspaceReview.rebind() })
  await page.waitForFunction(() => !document.querySelector("#owner-control img"))
  assert.equal(await page.locator("#workspace-caller img").count(), 0)
  assert.equal(requests.length, before, "rebind starts no additional image request")
}))

test("a retained local file reply cannot authorize its first image after explicit rebind", () => withPage(true, async (page, requests) => {
  assert.deepEqual(requests, [])
  await page.evaluate(() => { (window as any).restrictedMedia = true; (window as any).workspaceReview.rebind(); (window as any).workspaceReview.release() })
  await page.locator("#workspace-caller .markdown-body p").waitFor()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  assert.deepEqual(requests, [], "the rendered reply has zero unauthorized image requests")
  assert.equal(await page.locator("#workspace-caller img").count(), 0)
}))
