import assert from "node:assert/strict"
import { test } from "node:test"
import { chromium, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

async function fixturePage(run: (page: Page, probes: string[]) => Promise<void>, relay = true, authority = false) {
  const fixture = await borrowFixture({ name: "backend-media-relay", routes: [{ path: "/fixture", html:
    '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/backend-media-routing.tsx"></script></body></html>' }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  const page = await browser.newPage(), probes: string[] = [], errors: string[] = []
  try {
    page.on("pageerror", error => errors.push(error.message))
    page.on("request", request => { if (request.url().includes("media-probe.png")) probes.push(request.url()) })
    await page.addInitScript({ content: 'window.EventSource = class extends EventTarget { close() {} }' })
    await page.route("**/api/**", async route => {
      if (route.request().url().includes("/session-media/")) return route.fulfill({ contentType: "image/png",
        body: Buffer.from((await page.evaluate(() => (window as any).media.data)).split(",")[1], "base64") })
      return route.fulfill({ json: {} })
    })
    await page.route("**/media-probe.png", route => route.fulfill({ status: 204 }))
    await page.goto(fixture.url + (relay ? `?relay=1${authority ? "&authority=1" : ""}` : ""))
    if (relay) await page.waitForFunction(() => !!(window as any).media && document.querySelectorAll('[data-owner="remote"] [data-consumer="html"] img, [data-owner="remote"] [data-consumer="html"] .markdown-local-image').length === 3)
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('[data-owner="local"] img')].filter(image => image.complete && image.naturalWidth === 8).length === 3)
    await run(page, probes)
    assert.deepEqual(errors, [])
  } finally { await page.unrouteAll({ behavior: "wait" }); await browser.close() }
}
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

test("relay preserves data and public HTTP sources without authenticated fetch", async () => fixturePage(async page => {
  const publicUrl = "https://public-images.example.invalid/image.png"
  const requests: Record<string, string>[] = []
  const malformed: string[] = []
  page.on("request", request => { if (/\/api\/backends\/lab\/(?:data:|https?:)/.test(request.url())) malformed.push(request.url()) })
  await page.context().addCookies([{ name: "sentinel", value: "local-only", url: new URL(page.url()).origin }])
  await page.route(publicUrl, async route => {
    requests.push(route.request().headers())
    await route.fulfill({ contentType: "image/png", body: Buffer.from((await page.evaluate(() => (window as any).media.data)).split(",")[1], "base64") })
  })
  for (const source of [await page.evaluate(() => (window as any).media.data), publicUrl]) {
    await page.evaluate(source => (window as any).media.external(source), source)
    await page.waitForFunction(() => (window as any).media.plainCalls.some((call: any) => /\/api\/backends\/lab\/(?:data:|https?:)/.test(call.url))
      || [...document.querySelectorAll<HTMLImageElement>('[data-owner="remote"] [data-consumer]:not([data-consumer="html"]) img')].filter(image => image.complete && image.naturalWidth === 8).length === 3)
    assert.deepEqual(await page.evaluate(() => (window as any).media.plainCalls.filter((call: any) => /\/api\/backends\/lab\/(?:data:|https?:)/.test(call.url))), [], "absolute sources must bypass relay URL resolution")
    assert.deepEqual(malformed, [], "absolute sources must never be prefixed with the relay path")
    assert.deepEqual(await page.evaluate(() => (window as any).media.calls.map((call: any) => call.url)), [], "absolute sources must bypass the relay")
    await page.waitForFunction(source => [...document.querySelectorAll<HTMLImageElement>('[data-owner="remote"] img')]
      .filter(image => image.complete && image.naturalWidth === 8 && (source.startsWith("data:") ? image.src.startsWith("blob:") : image.src === source)).length === 3, source)
  }
  assert.ok(requests.length > 0)
  assert.ok(requests.every(headers => !headers.authorization && !headers.cookie))
}))

test("remote relative HTML images stay inert on first render, warm cache and remount", async () => fixturePage(async (page, probes) => {
  for (let mount = 0; mount < 3; mount++) {
    await page.waitForFunction(() => document.querySelectorAll('[data-owner="remote"] [data-consumer="html"] .markdown-local-image').length === 3)
    await settle(page)
    assert.equal(await page.locator('[data-owner="remote"] [data-consumer="html"] img').count(), 0)
    assert.equal(await page.locator('[data-owner="remote"] [data-consumer="html"] .markdown-local-image').count(), 3)
    assert.deepEqual(probes, [], "remote HTML must stay inert before and after insertion")
    await page.evaluate(() => (window as any).media.unmount())
    await page.evaluate(() => (window as any).media.remount())
  }
  await page.evaluate(() => (window as any).media.localHtml())
  await page.waitForFunction(() => document.querySelectorAll('[data-owner="local"] [data-consumer="html"] img').length === 3)
  assert.deepEqual(await page.locator('[data-owner="local"] [data-consumer="html"] img').evaluateAll(images => images.map(image => image.getAttribute("src"))),
    ["/api/media-probe.png", "./media-probe.png", "../media-probe.png"])
}))

test("relay inline images retain all seven signature checks and canonical MIME types", async () => fixturePage(async page => {
  const text = (value: string) => [...Buffer.from(value)]
  const bmp = Array(26).fill(0); bmp.splice(0, 2, ...text("BM"))
  const ico = Array(22).fill(0); ico.splice(0, 6, 0, 0, 1, 0, 1, 0)
  const png = await page.evaluate(() => Array.from(Uint8Array.from(atob((window as any).media.data.split(",")[1]), char => char.charCodeAt(0))))
  for (const [bytes, type] of [[png, "image/png"], [[255, 216, 255], "image/jpeg"], [text("GIF89a"), "image/gif"],
    [text("RIFFxxxxWEBP"), "image/webp"], [bmp, "image/bmp"], [ico, "image/x-icon"], [[0, 0, 0, 16, ...text("ftypavif"), 0, 0, 0, 0], "image/avif"]] as const) {
    const before = await page.evaluate(() => (window as any).media.created.length)
    const source = "data:image/png;base64," + Buffer.from(bytes).toString("base64")
    await page.evaluate(source => (window as any).media.external(source), source)
    await page.waitForFunction(before => (window as any).media.created.length === before + 3, before)
    assert.deepEqual(await page.evaluate(before => (window as any).media.createdTypes.slice(before), before), Array(3).fill(type))
    assert.deepEqual(await page.evaluate(() => (window as any).media.calls), [])
  }
  const before = await page.evaluate(() => (window as any).media.created.length)
  await page.evaluate(() => (window as any).media.external("data:image/png;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg"></svg>')))
  await settle(page)
  assert.equal(await page.evaluate(() => (window as any).media.created.length), before)
  assert.equal(await page.locator('[data-owner="remote"] img[src]').count(), 0)
  const calls = await page.evaluate(() => (window as any).media.plainCalls.filter((call: any) => call.url.startsWith("data:")))
  assert.equal(calls.length, 24)
  assert.ok(calls.every((call: any) => call.credentials === "omit"))
}))

test("relay session media uses its owning fetch exactly once per consumer", async () => fixturePage(async page => {
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('[data-owner="remote"] img')]
    .filter(image => image.src.startsWith("blob:") && image.naturalWidth === 8).length === 3)
  const calls = await page.evaluate(() => (window as any).media.calls.map(({ url, credentials }: any) => ({ url, credentials })))
  assert.equal(calls.length, 3)
  assert.equal(new Set(calls.map((call: any) => call.url)).size, 3)
  assert.ok(calls.every((call: any) => call.url.startsWith(new URL("/api/backends/lab/api/workspaces/same/session-media/", page.url()).href) && call.credentials === "include"))
}))

test("authority-bound relay session media renders through its owning transport with the proof intact", async () => fixturePage(async page => {
  await settle(page)
  const calls = await page.evaluate(() => (window as any).media.calls)
  assert.equal(calls.length, 3, "all media consumers must reach the authority-bound transport")
  for (const call of calls) {
    const url = new URL(call.url)
    assert.ok(url.pathname.startsWith("/api/backends/lab/api/workspaces/same/session-media/"))
    assert.equal(url.searchParams.get("__codenomad_authority"), "a".repeat(43))
    assert.equal(call.authority, "a".repeat(43))
    assert.equal(call.credentials, "include")
  }
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('[data-owner="remote"] img')]
    .filter(image => image.src.startsWith("blob:") && image.naturalWidth === 8).length === 3)
}, true, true))

for (const relay of [true, false]) test(`remote absolute UI-origin sources outside the owner never reach any consumer (${relay ? "relay" : "direct"})`, async () => fixturePage(async page => {
  const requests: string[] = []
  page.on("request", request => { if (request.url().includes("/session-media/")) requests.push(request.url()) })
  await page.evaluate(() => (window as any).media.external(new URL((window as any).media.path("tool"), location.origin).href))
  await settle(page)
  assert.equal(await page.locator('[data-owner="remote"] [data-consumer]:not([data-consumer="html"]) img[src]').count(), 0)
  assert.deepEqual(await page.evaluate(() => (window as any).media.calls), [])
  assert.deepEqual(requests, [])
}, relay))
