import assert from "node:assert/strict"
import { test } from "node:test"
import { chromium, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

async function fixturePage(run: (page: Page) => Promise<void>) {
  const fixture = await borrowFixture({ name: "backend-media-routing", routes: [{ path: "/fixture", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/backend-media-routing.tsx"></script></body></html>' }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  const page = await browser.newPage(), errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: 'window.EventSource = class extends EventTarget { close() {} }' })
  await page.route("**/api/**", async route => {
    if (route.request().url().includes("/session-media/")) {
      const data = await page.evaluate(() => (window as any).media.data)
      return route.fulfill({ contentType: "image/png", body: Buffer.from(data.split(",")[1], "base64") })
    }
    return route.fulfill({ json: {} })
  })
  try {
    await page.goto(fixture.url)
    await decoded(page)
    await run(page)
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error("Media fixture failure", errors, await page.locator("body").innerText(),
      await page.locator("[data-owner] img").evaluateAll(images => images.map(image => image.outerHTML)),
      await page.evaluate(() => (window as any).media?.calls.map((call: any) => call.url)))
    throw error
  } finally { await browser.close() }
}

async function decoded(page: Page) {
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll<HTMLImageElement>("[data-owner] img")]
    return images.length === 6 && images.every(image => image.complete && image.naturalWidth === 8)
  })
}
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

test("tool, Markdown local images and attachment thumbnails use their backend, preserving exact local src", async () => fixturePage(async page => {
  for (const [index, kind] of ["tool", "markdown", "attachment"].entries()) {
    const path = `/api/workspaces/same/session-media/session/message/0/${index}/${"a".repeat(64)}`
    assert.equal(await page.locator(`[data-owner="local"] [data-consumer="${kind}"] img`).getAttribute("src"),
      kind === "attachment" ? path : new URL(path, page.url()).href)
    assert.match(await page.locator(`[data-owner="remote"] [data-consumer="${kind}"] img`).getAttribute("src") ?? "", /^blob:/)
  }
  const calls = await page.evaluate(() => (window as any).media.calls.map(({ url, credentials }: any) => ({ url, credentials })))
  assert.equal(calls.length, 3)
  assert.ok(calls.every((call: any) => call.url.startsWith("https://media.example.invalid/api/workspaces/same/session-media/") && call.credentials === "include"))
  await page.locator('[data-owner="remote"] .attachment-chip').hover()
  await page.locator(".attachment-image-popover img").waitFor()
  assert.match(await page.locator(".attachment-image-popover img").getAttribute("src") ?? "", /^blob:/)
}))

test("replacement and unmount revoke every backend-owned object URL", async () => fixturePage(async page => {
  const previous = await page.evaluate(() => [...(window as any).media.created])
  await page.evaluate(() => (window as any).media.replace())
  await decoded(page)
  await page.waitForFunction(previous => previous.every(url => (window as any).media.revoked.includes(url)), previous)
  await page.evaluate(() => (window as any).media.unmount())
  await page.waitForFunction(() => (window as any).media.created.every((url: string) => (window as any).media.revoked.includes(url)))
  assert.equal(await page.locator("[data-owner] img").count(), 0)
}))

for (const phase of ["fetch", "blob"] as const) {
  test(`detach during ${phase} fences media publication and reattachment recovers`, async () => fixturePage(async page => {
    await page.evaluate(phase => { (window as any).media.hold(phase); (window as any).media.replace() }, phase)
    await page.waitForFunction(() => (window as any).media.pending >= 3)
    await page.evaluate(() => (window as any).media.detach())
    await settle(page)
    assert.equal(await page.locator('[data-owner="remote"] img[src]').count(), 0)
    await page.evaluate(() => (window as any).media.release())
    await settle(page)
    assert.equal(await page.locator('[data-owner="remote"] img[src]').count(), 0)
    const state = await page.evaluate(() => ({ created: (window as any).media.created, revoked: (window as any).media.revoked }))
    assert.ok(state.created.every((url: string) => state.revoked.includes(url)))
    await page.evaluate(() => (window as any).media.reattach())
    await decoded(page)
  }))
}

test("a missing backend clears every media consumer without a local request fallback", async () => fixturePage(async page => {
  const localRequests: string[] = []
  page.on("request", request => { if (request.url().includes("/session-media/")) localRequests.push(request.url()) })
  const count = await page.evaluate(() => (window as any).media.calls.length)
  await page.evaluate(() => (window as any).media.missing())
  await settle(page)
  assert.equal(await page.locator('[data-owner="remote"] img[src]').count(), 0)
  assert.equal(await page.locator('[data-owner="local"] img').count(), 3)
  assert.equal(await page.evaluate(() => (window as any).media.calls.length), count)
  assert.deepEqual(localRequests, [])
}))

test("external tool, Markdown and attachment images never use an authenticated backend fetcher", async () => fixturePage(async page => {
  const external = "https://public-images.example.invalid/image.png"
  const requests: { url: string; authorization?: string }[] = []
  await page.route("https://public-images.example.invalid/**", async route => {
    requests.push({ url: route.request().url(), authorization: route.request().headers().authorization })
    const data = await page.evaluate(() => (window as any).media.data)
    await route.fulfill({ contentType: "image/png", body: Buffer.from(data.split(",")[1], "base64") })
  })
  await page.evaluate(url => (window as any).media.external(url), external)
  await page.waitForFunction(url => (window as any).media.calls.length > 0 || ["tool", "markdown", "attachment"].every(kind =>
    document.querySelector(`[data-owner="remote"] [data-consumer="${kind}"] img`)?.getAttribute("src") === url), external)
  assert.equal(await page.evaluate(() => (window as any).media.calls.length), 0, "backend.fetch must never receive an external image URL")
  await page.waitForFunction(url => ["tool", "markdown", "attachment"].every(kind => {
    const image = document.querySelector<HTMLImageElement>(`[data-owner="remote"] [data-consumer="${kind}"] img`)
    return image?.getAttribute("src") === url && image.complete && image.naturalWidth === 8
  }), external)
  assert.equal(await page.evaluate(() => (window as any).media.calls.length), 0, "backend.fetch must never receive an external image URL")
  assert.ok(requests.length > 0)
  assert.ok(requests.every(request => request.url === external && request.authorization === undefined))
  for (const kind of ["tool", "markdown", "attachment"]) {
    assert.equal(await page.locator(`[data-owner="remote"] [data-consumer="${kind}"] img`).getAttribute("src"), external)
  }
}))

test("credential-bearing external URLs are rejected by tool, Markdown and attachment consumers", async () => fixturePage(async page => {
  const requests: string[] = []
  await page.route("https://public-images.example.invalid/**", route => {
    requests.push(route.request().url())
    return route.fulfill({ status: 403, body: "refused" })
  })
  const previous = await page.evaluate(() => [...(window as any).media.created])
  await page.evaluate(() => (window as any).media.external("https://user:secret@public-images.example.invalid/image.png"))
  await page.waitForFunction(previous => previous.every(url => (window as any).media.revoked.includes(url))
    && !document.querySelector('[data-owner="remote"] img[src]'), previous)
  await settle(page)
  assert.equal(await page.evaluate(() => (window as any).media.calls.length), 0)
  assert.deepEqual(requests, [])
  for (const kind of ["tool", "markdown", "attachment"]) {
    assert.equal(await page.locator(`[data-owner="remote"] [data-consumer="${kind}"] img[src]`).count(), 0)
  }
}))

test("local tool, Markdown and attachment consumers preserve exact data and public HTTP image sources", async () => fixturePage(async page => {
  const publicUrl = "http://public-images.example.invalid/local.png?exact=a%2Fb&second=2"
  await page.route("http://public-images.example.invalid/**", async route => {
    const data = await page.evaluate(() => (window as any).media.data)
    await route.fulfill({ contentType: "image/png", body: Buffer.from(data.split(",")[1], "base64") })
  })
  const data = await page.evaluate(() => (window as any).media.data)
  const calls = await page.evaluate(() => (window as any).media.calls.length)
  for (const source of [data, publicUrl]) {
    await page.evaluate(url => (window as any).media.local(url), source)
    await page.waitForFunction(source => ["tool", "markdown", "attachment"].every(kind => {
      const image = document.querySelector<HTMLImageElement>(`[data-owner="local"] [data-consumer="${kind}"] img`)
      return image?.getAttribute("src") === source && image.complete && image.naturalWidth === 8
    }), source)
    for (const kind of ["tool", "markdown", "attachment"]) {
      assert.equal(await page.locator(`[data-owner="local"] [data-consumer="${kind}"] img`).getAttribute("src"), source)
    }
    assert.equal(await page.evaluate(() => (window as any).media.calls.length), calls)
  }
}))

test("remote attachment download reuses its resolved blob without another backend request", async () => fixturePage(async page => {
  const calls = await page.evaluate(() => (window as any).media.calls.length)
  const source = await page.locator('[data-owner="remote"] [data-consumer="attachment"] img').getAttribute("src")
  assert.match(source ?? "", /^blob:/)
  await page.locator('[data-owner="remote"] .attachment-download').click()
  assert.deepEqual(await page.evaluate(() => (window as any).media.downloads), [source])
  assert.equal(await page.evaluate(() => (window as any).media.calls.length), calls)
}))
