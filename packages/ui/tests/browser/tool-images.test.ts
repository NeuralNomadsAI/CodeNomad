import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { mkdir } from "node:fs/promises"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
      name: "tool-images",
      routes: [
        { path: "/fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/tests/browser/fixtures/tool-images.tsx\"></script></body></html>" },
      ],
    })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

async function withPage(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 }, deviceScaleFactor: 2, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(() => {
    ;(window as any).__name = Object
    const intents: string[] = []
    ;(window as any).mediaIntents = intents
    const check = (name: string, value: string) => {
      if (!value) return
      if (name === "style" && !/url|\\|@import/i.test(value)) return
      if (name === "src" && (/^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(value) || /^(?:https?:\/\/[^/]+)?\/api\/workspaces\/media-[AB]\/session-media\//.test(value))) return
      intents.push(`${name}:${value.slice(0, 200)}`)
    }
    const inspect = (node: Node) => {
      if (!(node instanceof Element)) return
      for (const element of [node, ...node.querySelectorAll("*")]) for (const name of ["src", "srcset", "poster", "data", "style"]) {
        const value = element.getAttribute(name)
        if (value) check(name, value)
      }
    }
    const setter = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!
    Object.defineProperty(Element.prototype, "innerHTML", { ...setter, set(value: string) {
      if (!(this instanceof HTMLTemplateElement)) {
        const template = document.createElement("template")
        setter.set!.call(template, value)
        for (const child of template.content.children) inspect(child)
      }
      setter.set!.call(this, value)
    } })
    const attribute = Element.prototype.setAttribute
    Element.prototype.setAttribute = function(name, value) {
      if (["src", "srcset", "poster", "data", "style"].includes(name.toLowerCase())) check(name.toLowerCase(), value)
      return attribute.call(this, name, value)
    }
    const source = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!
    Object.defineProperty(HTMLImageElement.prototype, "src", { ...source, set(value: string) { check("src", value); source.set!.call(this, value) } })
  })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.route("**/*", route => new URL(route.request().url()).origin === new URL(url).origin ? route.fallback()
    : route.fulfill({ status: 418, body: "External request refused by deterministic fixture" }))
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await run(page)
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error("Image fixture failure", errors, await page.locator("main").innerText(),
      await page.locator(".tool-call-output-images").evaluateAll(elements => elements.map(el => el.outerHTML.slice(0, 1500))))
    throw error
  } finally { await page.close() }
}

/** Event-driven projections coalesce onto the next animation frame. */
const frames = (page: Page) => page.evaluate(() =>
  new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

async function decodedImages(page: Page, count: number) {  await page.waitForFunction(count => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(".tool-call-output-images img"))
    return images.length === count && images.every(img => img.complete && img.naturalWidth === 800)
  }, count)
  assert.equal((await page.locator("main").innerText()).includes("base64"), false)
}

test("MCP images render with text on native live completion and historical reload", async () => withPage(async page => {
  await page.evaluate(() => (window as any).fixture.start())
  assert.equal(await page.locator(".tool-call-output-images img").count(), 0)
  await page.evaluate(() => (window as any).fixture.finish())
  await decodedImages(page, 2)
  await page.getByText("Generated 2 images. Saved successfully.", { exact: true }).waitFor()
  assert.equal(await page.getByRole("img", { name: "generated.png", exact: true }).count(), 1)
  assert.equal(await page.getByRole("img", { name: "Image 2", exact: true }).count(), 1)
  await page.evaluate(() => (window as any).fixture.reload())
  await decodedImages(page, 2)
  await page.setViewportSize({ width: 380, height: 1000 })
  assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth), true)
  if (process.env.CODENOMAD_IMAGE_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_IMAGE_CAPTURE, fullPage: true })
}))

async function assertNoUnownedMedia(page: Page) {
  assert.deepEqual(await page.evaluate(() => (window as any).mediaIntents), [], "no unauthorized source assignment, including before first insertion")
  assert.equal(await page.locator("audio,video,source,iframe,object,embed,[srcset],[onerror]").count(), 0)
}

test("explicit generic/specialized tools, Markdown, attachments and aside reject passive external content before DOM", async () => withPage(async page => {
  const network: string[] = []
  page.on("request", request => { if (new URL(request.url()).origin !== new URL(url).origin || request.url().includes("/api/previews")) network.push(request.url()) })
  const hostile = '<img src="https://denied.invalid/pixel"><img srcset="//denied.invalid/a 1x"><picture><source srcset="https://denied.invalid/b"></picture><audio src="https://denied.invalid/audio"></audio><video poster="https://denied.invalid/poster"><source src="https://denied.invalid/video"></video><iframe src="https://denied.invalid/frame"></iframe><object data="https://denied.invalid/object"></object><embed src="https://denied.invalid/embed"><div style="background:u\\72l(https://denied.invalid/css)">CSS</div> x <code><img/src=https://denied.invalid/malformed onerror=alert(1)></code> ![markdown](https://denied.invalid/md) [Local link](http://127.0.0.1:4321/app) [File](file:///tmp/secret) [Bad](javascript:alert%281%29)'
  for (const name of ["mcp_fixture", "skill", "read", "execute"]) {
    await page.evaluate(({ text, name }) => (window as any).fixture.media({ uri: "https://denied.invalid/tool", text, name }), { text: hostile, name })
    await page.locator(".media-markdown a").first().waitFor()
    await page.getByText("Unable to display this image.", { exact: true }).first().waitFor()
    await assertNoUnownedMedia(page)
    assert.equal(await page.locator(".media-policy img").count(), 0)
    assert.equal(await page.locator(".media-attachment button.attachment-download").count(), 0)
  }
  await page.evaluate(() => (window as any).fixture.aside())
  await page.locator(".session-aside-answer a").first().waitFor()
  await assertNoUnownedMedia(page)
  assert.equal(await page.locator(".session-aside-answer img").count(), 0)
  const link = page.locator(".media-markdown a").filter({ hasText: "Local link" })
  assert.equal(await link.getAttribute("data-preview-link-title"), null)
  assert.equal(await link.getAttribute("target"), "_blank")
  assert.equal(await page.locator('.media-markdown a[href^="file:"],.media-markdown a[href^="javascript:"]').count(), 0)
  assert.deepEqual(network, [])
  // Explicit text navigation is a genuine gesture, served entirely by this fixture.
  await page.keyboard.press("Escape")
  await page.locator(".session-aside-answer").waitFor({ state: "hidden" })
  await page.context().route("http://127.0.0.1:4321/**", route => route.fulfill({ body: "External text link" }))
  const popup = page.waitForEvent("popup")
  await link.click()
  const external = await popup
  await external.waitForLoadState("domcontentloaded")
  assert.equal(external.url(), "http://127.0.0.1:4321/app")
  await external.close()
  assert.ok(network.every(value => !value.includes("/api/previews")))
}))

test("explicit caches, owner switches, local resolution and failed downloads reauthorize held native media", async () => withPage(async page => {
  const media = { ...await page.evaluate(() => (window as any).fixture.deferred()), path: `/api/workspaces/media-A/session-media/same/same-message/0/0/${"c".repeat(64)}` }
  const reads: string[] = []
  await page.route("**/session-media/**", route => {
    reads.push(new URL(route.request().url()).pathname)
    return route.fulfill({ contentType: "image/png", body: Buffer.from(media.base64, "base64") })
  })
  await page.evaluate(path => (window as any).fixture.media({ uri: path, text: "![held](/fixture/held.png)" }), media.path)
  await page.locator(".media-markdown img.markdown-local-image").waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".media-policy img")].every(image => image.complete && image.naturalWidth > 0))
  await page.locator(".media-attachment").scrollIntoViewIfNeeded()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await page.mouse.move(880, 980)
  await page.locator(".media-attachment .attachment-chip-image").hover()
  await page.locator(".attachment-image-popover img").waitFor()
  await assertNoUnownedMedia(page)
  for (const cache of ["local", "global"]) {
    await page.evaluate(({ path, cache }) => (window as any).fixture.media({ uri: path, text: `<img src="https://denied.invalid/cache"><img src="${path}"><video src="https://denied.invalid/video"></video>`, cache }), { path: media.path, cache })
    await page.locator(".media-markdown img").waitFor()
    await page.locator(`.media-markdown [data-media-cache="${cache}"]`).waitFor()
    await assertNoUnownedMedia(page)
    await page.evaluate(() => (window as any).fixture.owner("media-B"))
    await page.waitForFunction(() => !document.querySelector(".media-markdown img") && [...document.querySelectorAll<HTMLImageElement>(".media-policy img")].every(image => image.src.includes("/workspaces/media-B/")))
    await assertNoUnownedMedia(page)
    await page.evaluate(() => (window as any).fixture.owner("media-A"))
    await page.locator(".media-markdown img").waitFor()
  }
  await page.evaluate(() => (window as any).fixture.hideMedia())
  await page.evaluate(() => (window as any).fixture.showMedia())
  await page.locator(".media-markdown img").waitFor()
  await assertNoUnownedMedia(page)
  await page.route("**/session-media/**", route => route.fulfill({ status: 404, body: "missing" }))
  const opened: string[] = []
  page.on("popup", popup => { opened.push(popup.url()); void popup.close() })
  await page.locator(".attachment-download").click()
  await page.locator(".media-attachment p[role=status]").waitFor()
  assert.deepEqual(opened, [], "failed downloads have no original-URL navigation fallback")
  await page.evaluate(() => (window as any).fixture.missing())
  await page.waitForFunction(() => document.querySelectorAll(".media-policy img").length === 0)
  await assertNoUnownedMedia(page)
  assert.ok(reads.every(path => path === media.path || path === media.path.replace("/media-A/", "/media-B/")))
}))

test("nested task media uses the real child session and rebind revokes native references", async () => withPage(async page => {
  const media = await page.evaluate(() => (window as any).fixture.deferred())
  const reads: string[] = []
  await page.route("**/session-media/**", route => {
    reads.push(new URL(route.request().url()).pathname)
    return route.fulfill({ contentType: "image/png", body: Buffer.from(media.base64, "base64") })
  })
  await page.evaluate(() => (window as any).fixture.media({ nested: true }))
  const child = page.locator('.tool-call[data-session-id="child"]')
  await child.locator(".tool-call-header-toggle").click()
  await child.locator("img").waitFor()
  assert.ok(reads.length > 0)
  assert.ok(reads.every(path => path.includes("/session-media/child/same-message-child/0/0/")))
  await assertNoUnownedMedia(page)
  await page.evaluate(() => (window as any).fixture.rebind("media-B"))
  await page.waitForFunction(() => document.querySelector('.tool-call[data-session-id="child"] img') === null)
  await assertNoUnownedMedia(page)
}))

test("explicit cached content stays restricted after local replacement, cache clearing and remount", async () => withPage(async page => {
  const network: string[] = []
  page.on("request", request => { if (new URL(request.url()).origin !== new URL(url).origin) network.push(request.url()) })
  await page.evaluate(() => (window as any).fixture.media({ uri: "https://denied.invalid/tool", text: 'x <code><img/src=https://denied.invalid/cache-owner onerror=alert(1)></code> y' }))
  await page.locator(".media-markdown code").waitFor()
  await assertNoUnownedMedia(page)
  await page.evaluate(() => (window as any).fixture.rebindLocal())
  await page.evaluate(() => (window as any).fixture.hideMedia())
  await page.evaluate(() => (window as any).fixture.showMedia())
  await page.locator(".media-markdown code").waitFor()
  await assertNoUnownedMedia(page)
  assert.equal(await page.locator(".media-policy img").count(), 0)
  await page.evaluate(() => (window as any).fixture.clearMediaCaches())
  await page.evaluate(() => (window as any).fixture.hideMedia())
  await page.evaluate(() => (window as any).fixture.showMedia())
  await page.locator(".media-markdown code").waitFor()
  await assertNoUnownedMedia(page)
  assert.equal(await page.locator(".media-policy img").count(), 0)
  assert.deepEqual(network, [])
}))

test("genuinely trusted non-project Markdown retains local HTTP images on a warm cache and remount", async () => withPage(async page => {
  const media = await page.evaluate(() => (window as any).fixture.deferred())
  await page.route("**/trusted-image.png", route => route.fulfill({ contentType: "image/png", body: Buffer.from(media.base64, "base64") }))
  await page.evaluate(() => (window as any).fixture.trusted(true))
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>(".fixture-trusted img")?.naturalWidth === 800)
  assert.equal(await page.evaluate(() => (window as any).fixture.trustedCache().mediaOwnerKey), "trusted-nonproject")
  await page.evaluate(() => (window as any).fixture.trusted(false))
  await page.evaluate(() => (window as any).fixture.trusted(true))
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>(".fixture-trusted img")?.naturalWidth === 800)
  assert.match(await page.locator(".fixture-trusted img").getAttribute("src") ?? "", /\/trusted-image\.png$/)
}))

test("an attachment download cannot publish after connection rotation or view closure", async () => withPage(async page => {
  const media = await page.evaluate(() => (window as any).fixture.deferred())
  const path = `/api/workspaces/media-A/session-media/same/same-message/0/0/${"c".repeat(64)}`
  let release = () => {}, started = () => {}
  let gate = Promise.resolve()
  let requested = Promise.resolve()
  await page.route("**/session-media/**", async route => {
    if (route.request().resourceType() === "fetch") { started(); await gate }
    await route.fulfill({ contentType: "image/png", body: Buffer.from(media.base64, "base64") })
  })
  await page.evaluate(() => {
    ;(window as any).downloadPublications = 0
    const create = URL.createObjectURL
    URL.createObjectURL = function(blob) { (window as any).downloadPublications++; return create.call(this, blob) }
  })
  for (const action of ["rotate", "hideMedia"]) {
    await page.evaluate(path => (window as any).fixture.media({ uri: path }), path)
    gate = new Promise<void>(resolve => { release = resolve })
    requested = new Promise<void>(resolve => { started = resolve })
    await page.locator(".attachment-download").click()
    await requested
    await page.evaluate(action => (window as any).fixture[action](), action)
    const response = page.waitForResponse(response => response.url().includes("/session-media/") && response.request().resourceType() === "fetch")
    release()
    await response
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    assert.equal(await page.evaluate(() => (window as any).downloadPublications), 0)
    await assertNoUnownedMedia(page)
  }
}))

test("a successful keyboard retry clears attachment failure without moving focus", async () => withPage(async page => {
  const media = await page.evaluate(() => (window as any).fixture.deferred())
  const path = `/api/workspaces/media-A/session-media/same/same-message/0/0/${"c".repeat(64)}`
  let fails = true
  await page.route("**/session-media/**", route => fails ? route.fulfill({ status: 404, body: "missing" })
    : route.fulfill({ contentType: "image/png", body: Buffer.from(media.base64, "base64") }))
  await page.evaluate(path => (window as any).fixture.media({ uri: path }), path)
  const button = page.locator(".media-attachment .attachment-download")
  const popups: string[] = []
  page.on("popup", popup => { popups.push(popup.url()); void popup.close() })
  await button.click()
  await page.locator(".media-attachment p[role=status]").waitFor()
  assert.deepEqual(popups, [], "a real failed read never navigates to its original URL")
  fails = false
  await button.focus()
  const downloaded = page.waitForEvent("download")
  await page.keyboard.press("Enter")
  const download = await downloaded
  assert.equal(download.suggestedFilename(), "attachment.bin")
  const capture = process.env.CODENOMAD_MEDIA_FIX_CAPTURE_DIR
  if (capture) {
    await mkdir(capture, { recursive: true })
    await download.saveAs(`${capture}/successful-retry.bin`)
    await page.screenshot({ path: `${capture}/successful-retry.png`, fullPage: true })
  } else await download.cancel()
  assert.equal(await button.evaluate(element => element === document.activeElement), true)
  assert.equal(await page.locator(".media-attachment p[role=status]").count(), 0, "successful retry retires stale failure feedback")
  await assertNoUnownedMedia(page)
}))

async function queuedDownloads(page: Page) {
  const media = await page.evaluate(() => (window as any).fixture.deferred())
  const path = `/api/workspaces/media-A/session-media/same/same-message/0/0/${"c".repeat(64)}`
  type Reply = (status: number) => Promise<void>
  const arrivals: Array<(reply: Reply) => void> = []
  await page.route("**/session-media/**", async route => {
    if (route.request().resourceType() !== "fetch") return route.fulfill({ contentType: "image/png", body: Buffer.from(media.base64, "base64") })
    await new Promise<void>(resolve => arrivals.shift()!(async status => {
      await route.fulfill({ status, contentType: status === 200 ? "image/png" : "text/plain", body: status === 200 ? Buffer.from(media.base64, "base64") : "missing" })
      resolve()
    }))
  })
  await page.evaluate(path => (window as any).fixture.media({ uri: path }), path)
  await page.locator(".media-attachment .attachment-download").waitFor()
  return { button: page.locator(".media-attachment .attachment-download"),
    async start() {
      const next = new Promise<Reply>(resolve => arrivals.push(resolve))
      await page.locator(".media-attachment .attachment-download").click()
      return next
    },
  }
}

const settleDownloads = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

test("an older successful download cannot clear a newer failure or publish a stale file", async () => withPage(async page => {
  const queue = await queuedDownloads(page)
  const older = await queue.start(), newer = await queue.start()
  let downloads = 0
  page.on("download", download => { downloads++; void download.cancel() })
  await newer(404)
  await page.locator(".media-attachment p[role=status]").waitFor()
  await older(200)
  await settleDownloads(page)
  assert.equal(downloads, 0)
  assert.equal(await page.locator(".media-attachment p[role=status]").count(), 1)
  await assertNoUnownedMedia(page)
}))

test("an older failed download cannot install feedback after a newer success", async () => withPage(async page => {
  const queue = await queuedDownloads(page)
  const older = await queue.start(), newer = await queue.start()
  const downloaded = page.waitForEvent("download")
  await newer(200)
  await (await downloaded).cancel()
  await older(404)
  await settleDownloads(page)
  assert.equal(await page.locator(".media-attachment p[role=status]").count(), 0)
  await assertNoUnownedMedia(page)
}))

test("download failures stay fenced after rebind, owner switch, rotation and close", async () => {
  for (const action of ["rebind", "owner", "rotate", "hideMedia"]) await withPage(async page => {
    const queue = await queuedDownloads(page)
    const reply = await queue.start()
    await page.evaluate(action => (window as any).fixture[action]("media-B"), action)
    await reply(404)
    await settleDownloads(page)
    assert.equal(await page.locator(".media-attachment p[role=status]").count(), 0, action)
    await assertNoUnownedMedia(page)
  })
})

test("failure feedback belongs to its source and a current data URI still downloads", async () => withPage(async page => {
  const media = await page.evaluate(() => (window as any).fixture.deferred())
  const path = `/api/workspaces/media-A/session-media/same/same-message/0/0/${"c".repeat(64)}`
  let fetches = 0
  await page.route("**/session-media/**", route => {
    if (route.request().resourceType() === "fetch") fetches++
    return route.fulfill({ status: 404, body: "missing" })
  })
  await page.evaluate(path => (window as any).fixture.media({ uri: path }), path)
  await page.locator(".media-attachment .attachment-download").click()
  await page.locator(".media-attachment p[role=status]").waitFor()
  await page.evaluate(uri => (window as any).fixture.media({ uri }), `data:image/png;base64,${media.base64}`)
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>(".media-attachment img")?.naturalWidth === 800)
  assert.equal(await page.locator(".media-attachment p[role=status]").count(), 0)
  const downloaded = page.waitForEvent("download")
  await page.locator(".media-attachment .attachment-download").focus()
  await page.keyboard.press("Enter")
  await (await downloaded).cancel()
  assert.equal(fetches, 1)
  await assertNoUnownedMedia(page)
}))

test("non-image native files stay labels and explicit downloads without a media player or byte projection", async () => withPage(async page => {
  for (const mime of ["application/pdf", "audio/mpeg", "video/mp4"]) {
    await page.evaluate(mime => (window as any).fixture.media({ mime, uri: `data:${mime};base64,AA==`, name: "mcp_fixture" }), mime)
    await page.locator(".tool-call-output-image button.attachment-download").waitFor()
    assert.equal(await page.locator(".media-policy img").count(), 0)
    assert.equal((await page.locator("main").innerText()).includes("base64"), false)
    const downloaded = page.waitForEvent("download")
    await page.locator(".media-attachment .attachment-download").focus()
    await page.keyboard.press("Enter")
    const download = await downloaded
    assert.equal(download.suggestedFilename(), "attachment.bin")
    await download.cancel()
    await assertNoUnownedMedia(page)
  }
}))

test("a window ending inside an inline image keeps its native bytes out of the fallback text", async () => withPage(async page => {
  const text = `![large](data:image/png;base64,${"A".repeat(100000)})`
  await page.evaluate(text => (window as any).fixture.media({ text }), text)
  await page.locator(".media-markdown").getByText("Unable to display this image.", { exact: true }).waitFor()
  assert.ok((await page.locator(".media-markdown").innerText()).length < 1000)
  assert.equal(await page.evaluate(() => (window as any).fixture.sourceLength()), text.length)
  await assertNoUnownedMedia(page)
}))

test("reveal preserves sanitation, generated math/code actions and narrow keyboard/RTL fallbacks", async () => withPage(async page => {
  await page.evaluate(() => (window as any).fixture.media({ text: "A".repeat(50010) + '\n\n<img src="https://denied.invalid/reveal" srcset="https://denied.invalid/set 2x">' }))
  await page.locator(".media-markdown").getByRole("button", { name: "Show all", exact: true }).click()
  await page.locator(".media-markdown [role=status]").waitFor()
  await assertNoUnownedMedia(page)
  await page.evaluate(() => (window as any).fixture.media({ text: '```js\nconst value = 1\n```\n\n$ x^2 $\n\n![blocked](https://denied.invalid/blocked)' }))
  await page.locator(".media-markdown .code-block-copy").waitFor()
  await page.locator(".media-markdown .katex").first().waitFor()
  await page.locator(".media-markdown .code-block-wrap").focus()
  const before = await page.locator(".media-markdown .code-block-wrap").getAttribute("aria-pressed")
  await page.keyboard.press("Enter")
  assert.notEqual(await page.locator(".media-markdown .code-block-wrap").getAttribute("aria-pressed"), before)
  await page.setViewportSize({ width: 320, height: 900 })
  const directory = fileURLToPath(new URL("../../../../.tmp/media-policy/screenshots/", import.meta.url))
  await mkdir(directory, { recursive: true })
  for (const locale of ["en", "he"]) for (const theme of ["light", "dark"]) {
    await page.evaluate(({ locale, theme }) => (window as any).fixture.settings({ locale, theme }), { locale, theme })
    await page.locator(".media-markdown [data-media-unavailable]").filter({ hasText: locale === "he" ? "לא ניתן להציג את התמונה הזו." : "Unable to display this image." }).waitFor()
    await page.emulateMedia({ colorScheme: theme as "light" | "dark" })
    await page.locator(".media-markdown .code-block-wrap").focus()
    await page.screenshot({ path: `${directory}/${locale}-${theme}-320-dpr2.png`, fullPage: true })
  }
  await page.evaluate(() => { for (const sheet of [...document.styleSheets]) sheet.disabled = true })
  await page.screenshot({ path: `${directory}/he-no-css-320-dpr2.png`, fullPage: true })
  await assertNoUnownedMedia(page)
}))

test("a Markdown image of a local file shows the transcript's image of that path, never a broken image", async () => withPage(async page => {
  const answer = page.locator(".fixture-answer")
  const label = answer.locator('span.markdown-local-image[title="C:/Users/me/Temp/images/sheep.png"]')
  await page.evaluate(() => (window as any).fixture.localImageAnswer("none"))
  await answer.getByText("Un petit mouton", { exact: true }).waitFor()
  assert.equal(await answer.locator("img").count(), 0, "without a transcript image the alt text stays")
  assert.equal(await answer.locator('span.markdown-local-image[title="C:/Users/me/missing.png"]').innerText(), "Absent")

  // Malformed held bytes are refused before assigning a source.
  await page.evaluate(() => (window as any).fixture.localImageAnswer("broken"))
  await label.waitFor()
  assert.equal(await answer.locator('[data-failed-source="data:image/png;base64,broken"]').count(), 0)
  assert.equal(await answer.locator("img").count(), 0)
  assert.equal(await label.innerText(), "Un petit mouton")

  // The read tool's image of that path arrives: the same rendered answer resolves it.
  await page.evaluate(() => (window as any).fixture.localImageAnswer("valid"))
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>(".fixture-answer img.markdown-local-image")
    return Boolean(image?.complete && image.naturalWidth === 800 && image.alt === "Un petit mouton")
  })
  assert.match(await answer.locator("img.markdown-local-image").getAttribute("src") ?? "", /^data:image\/png;base64,/)
  assert.equal(await answer.locator("span.markdown-local-image").innerText(), "Absent", "an unmatched path keeps its alt text")
  // Removing the read result removes its image from the answer too.
  await page.evaluate(() => (window as any).fixture.localImageAnswer("none"))
  await label.waitFor()
  assert.equal(await answer.locator("img").count(), 0)
  assert.equal(await label.innerText(), "Un petit mouton")
  await page.evaluate(() => (window as any).fixture.localImageAnswer("valid"))
  await answer.locator("img.markdown-local-image").waitFor()
  await page.setViewportSize({ width: 380, height: 1000 })
  assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth), true)
  if (process.env.CODENOMAD_LOCAL_IMAGE_CAPTURE) await answer.screenshot({ path: process.env.CODENOMAD_LOCAL_IMAGE_CAPTURE })
}))

test("image-only output works for generic and specialized tools and obeys collapse", async () => withPage(async page => {
  for (const name of ["forge-painter_txt2img", "read"]) {
    await page.evaluate(name => (window as any).fixture.history("only", name), name)
    await decodedImages(page, 1)
    const header = page.locator(".tool-call-header").first()
    await header.click()
    assert.equal(await page.locator(".tool-call-output-images img").count(), 0)
    await header.click()
    await decodedImages(page, 1)
  }
  await page.evaluate(() => (window as any).fixture.history("empty"))
  await page.getByText("Text-only result", { exact: true }).waitFor()
  assert.equal(await page.locator(".tool-call-output-images").count(), 0)
}))

test("failed and unsupported image sources have a fallback and a later replacement recovers", async () => withPage(async page => {
  for (const kind of ["broken", "unsafe"]) {
    await page.evaluate(kind => (window as any).fixture.history(kind), kind)
    await page.getByText("Unable to display this image.", { exact: true }).waitFor()
    assert.equal(await page.locator(".tool-call-output-images img").count(), 0)
    assert.equal((await page.locator("main").innerText()).includes("base64"), false)
    await page.evaluate(() => (window as any).fixture.history("only"))
    await decodedImages(page, 1)
  }
  assert.equal(await page.evaluate(() => (window as any).unexpectedNavigation), undefined)
}))

test("a tool image deferred by its transcript page loads from CodeNomad's session-media route", async () => withPage(async page => {
  const { path, base64 } = await page.evaluate(() => (window as any).fixture.deferred()) as { path: string; base64: string }
  const requested: string[] = []
  await page.route("**/session-media/**", route => {
    const pathname = new URL(route.request().url()).pathname
    requested.push(pathname)
    return pathname === path ? route.fulfill({ contentType: "image/png", body: Buffer.from(base64, "base64") })
      : route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
  })
  await page.evaluate(() => (window as any).fixture.history("deferred", "read"))
  await decodedImages(page, 1)
  assert.deepEqual(requested, [path])
  assert.equal(await page.getByRole("img", { name: "generated.png", exact: true }).count(), 1)
  // An image CodeNomad can no longer serve (pruned, undone) gets the fallback.
  await page.evaluate(() => (window as any).fixture.history("deferred-missing", "read"))
  await page.getByText("Unable to display this image.", { exact: true }).waitFor()
  assert.equal(requested.length, 2)
}))

test("Code Mode renders native progress, nested errors, script, images and historical output", async () => withPage(async page => {
  await page.evaluate(() => (window as any).fixture.execute("running"))
  await page.locator(".execute-calls").waitFor()
  assert.equal(await page.locator('.execute-call-status[data-status="running"]').count(), 2)
  const firstCall = page.locator(".execute-calls summary").first()
  await firstCall.click()
  await firstCall.focus()
  await page.evaluate(() => (window as any).fixture.execute("progress"))
  await frames(page)
  assert.equal(await page.locator(".execute-calls li").count(), 3)
  assert.equal(await page.locator(".execute-calls details").first().getAttribute("open"), "")
  assert.equal(await firstCall.evaluate(el => el === document.activeElement), true)
  await page.evaluate(() => (window as any).fixture.execute("complete"))
  await decodedImages(page, 2)
  await page.locator('.execute-call-status[data-status="completed"]').waitFor()
  assert.equal(await page.locator('.execute-calls [data-status="error"]').count(), 1)
  await page.locator(".execute-calls summary").first().click()
  await page.getByText('"sky"', { exact: false }).first().waitFor()
  assert.match(await page.locator(".tool-call-execute").innerText(), /Promise\.all/)
  assert.match(await page.locator(".tool-call-execute").innerText(), /\/fixture\/output.txt/)
  await page.evaluate(() => (window as any).fixture.execute("history"))
  await decodedImages(page, 2)
  assert.equal(await page.locator('.execute-calls [data-status="error"]').count(), 1)
  await page.setViewportSize({ width: 380, height: 1000 })
  assert.equal(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth), true)
  if (process.env.CODENOMAD_EXECUTE_CAPTURE) await page.screenshot({ path: process.env.CODENOMAD_EXECUTE_CAPTURE, fullPage: true })
}))
