import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "badge-fixture", configureServer(s) {
      s.middlewares.use("/badge-fixture", async (req, res) => {
        res.setHeader("Content-Type", "text/html")
        const icons = req.url?.includes("no-icon") ? "" : '<link rel="icon" href="/original.ico" type="image/x-icon"><link rel="shortcut icon" href="/alternate.png">'
        res.end(await s.transformIndexHtml("/badge-fixture", `<html><head>${icons}</head><body><script type="module" src="/tests/browser/fixtures/notification-icon-badge.ts"></script></body></html>`))
      })
    } }], resolve: { dedupe: ["solid-js"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/badge-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function prepare(page: Page, query = "") {
  await page.addInitScript('window.badgeCalls = []; window.electronAPI = { setNotificationBadge: async count => { window.badgeCalls.push(count) } }')
  await page.goto(url + query)
  await page.waitForFunction(() => Boolean((window as any).badgeFixture))
}

test("favicon and native count follow additions, reads, deletion, clearing and cleanup", async () => {
  const page = await browser.newPage()
  try {
    await prepare(page)
    const ids = await page.evaluate(() => [(window as any).badgeFixture.add(), (window as any).badgeFixture.add()])
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')].every(link => link.href.startsWith("data:image/png")))
    const badged = await page.locator('link[rel="icon"]').getAttribute("href")
    assert.ok(badged?.startsWith("data:image/png"))
    // Check the actual generated image, not a reimplementation of its rendering.
    const pixel = await page.evaluate(async () => {
      const image = new Image(); image.src = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href
      await image.decode()
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 32
      const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0)
      return [...ctx.getImageData(25, 7, 1, 1).data]
    })
    assert.deepEqual(pixel, [220, 38, 38, 255])
    await page.evaluate(id => (window as any).badgeFixture.read(id), ids[0])
    assert.equal(await page.locator('link[rel="icon"]').getAttribute("href"), badged)
    await page.evaluate(id => (window as any).badgeFixture.remove(id), ids[1])
    assert.equal(await page.locator('link[rel="icon"]').getAttribute("href"), "/original.ico")
    assert.equal(await page.locator('link[rel="shortcut icon"]').getAttribute("href"), "/alternate.png")
    assert.equal(await page.locator('link[rel="icon"]').getAttribute("type"), "image/x-icon")
    await page.evaluate(() => {
      const f = (window as any).badgeFixture
      f.add(); f.readAll(); f.add(); f.clear(); f.add(); f.stop(); f.add()
    })
    assert.deepEqual(await page.evaluate(() => (window as any).badgeCalls), [0, 1, 2, 1, 0, 1, 0, 1, 0, 1, 0])
    assert.equal(await page.locator('link[rel="icon"]').getAttribute("href"), "/original.ico")
  } finally { await page.close() }
})

test("creates a fallback favicon and bounds history at 50", async () => {
  const page = await browser.newPage()
  try {
    await prepare(page, "?no-icon")
    await page.evaluate(() => { for (let i = 0; i < 60; i++) (window as any).badgeFixture.add() })
    await page.waitForFunction(() => document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href.startsWith("data:image/png"))
    assert.equal(await page.evaluate(() => (window as any).badgeFixture.count()), 50)
    assert.equal(await page.evaluate(() => (window as any).badgeCalls.at(-1)), 50)
    await page.evaluate(() => (window as any).badgeFixture.stop())
    assert.equal(await page.locator('link[rel~="icon"]').count(), 0)
    assert.equal(await page.evaluate(() => (window as any).badgeCalls.at(-1)), 0)
  } finally { await page.close() }
})

test("unavailable native bridge does not prevent favicon updates", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).badgeFixture))
    await page.evaluate(() => (window as any).badgeFixture.add())
    await page.waitForFunction(() => document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href.startsWith("data:image/png"))
    await page.evaluate(() => (window as any).badgeFixture.readAll())
    assert.equal(await page.locator('link[rel="icon"]').getAttribute("href"), "/original.ico")
  } finally { await page.close() }
})

test("Tauri forwards count-only calls and failed native badges leave the favicon working", async () => {
  const page = await browser.newPage()
  try {
    await page.addInitScript(`window.badgeCalls = []; window.__TAURI__ = { core: {} };
      window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
        window.badgeCalls.push({ command, args }); throw new Error('Unsupported platform');
      } }`)
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).badgeFixture))
    await page.evaluate(() => (window as any).badgeFixture.add())
    await page.waitForFunction(() => document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href.startsWith("data:image/png"))
    await page.evaluate(() => (window as any).badgeFixture.clear())
    assert.deepEqual(await page.evaluate(() => (window as any).badgeCalls), [
      { command: "notification_badge_set", args: { count: 0 } },
      { command: "notification_badge_set", args: { count: 1 } },
      { command: "notification_badge_set", args: { count: 0 } },
    ])
    assert.equal(await page.locator('link[rel="icon"]').getAttribute("href"), "/original.ico")
  } finally { await page.close() }
})

test("disposal before the source image loads cannot restore a stale badge", async () => {
  const page = await browser.newPage()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    await page.route("**/CodeNomad-Icon.png", async route => { await held; await route.continue() })
    await page.goto(url, { waitUntil: "domcontentloaded" })
    await page.waitForFunction(() => Boolean((window as any).badgeFixture))
    await page.evaluate(() => { const f = (window as any).badgeFixture; f.add(); f.stop() })
    release()
    await page.waitForLoadState("load")
    assert.equal(await page.locator('link[rel="icon"]').getAttribute("href"), "/original.ico")
  } finally { release(); await page.close() }
})

test("async native updates retain FIFO through failure, rapid clearing and cleanup", async () => {
  const page = await browser.newPage()
  try {
    await page.addInitScript(`window.badgeCalls = []; window.badgeRelease = [];
      window.__TAURI__ = { core: {} }; window.__TAURI_INTERNALS__ = {
        invoke: (command, args) => new Promise((resolve, reject) => {
          window.badgeCalls.push(args.count); window.badgeRelease.push({ resolve, reject });
        })
      }`)
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).badgeFixture))
    await page.evaluate(() => { const f = (window as any).badgeFixture; f.add(); f.clear(); f.stop() })
    assert.deepEqual(await page.evaluate(() => (window as any).badgeCalls), [0])
    await page.evaluate(() => (window as any).badgeRelease.shift().reject(new Error("unsupported")))
    await page.waitForFunction(() => (window as any).badgeCalls.length === 2)
    assert.deepEqual(await page.evaluate(() => (window as any).badgeCalls), [0, 1])
    await page.evaluate(() => (window as any).badgeRelease.shift().resolve())
    await page.waitForFunction(() => (window as any).badgeCalls.length === 3)
    assert.deepEqual(await page.evaluate(() => (window as any).badgeCalls), [0, 1, 0])
    await page.evaluate(() => (window as any).badgeRelease.shift().resolve())
    await page.waitForFunction(() => (window as any).badgeCalls.length === 4)
    assert.deepEqual(await page.evaluate(() => (window as any).badgeCalls), [0, 1, 0, 0])
    await page.evaluate(() => (window as any).badgeRelease.shift().resolve())
  } finally { await page.close() }
})
