import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"

let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  cache = await createFixtureCache()
  server = await createServer({ configFile: false, cacheDir: cache.cacheDir, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "brand-logo-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/brand-logo.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close(); await cache?.dispose() })

function merge(target: any, patch: any): any {
  const result = structuredClone(target)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key]
    else result[key] = typeof value === "object" && !Array.isArray(value) ? merge(result[key] ?? {}, value) : value
  }
  return result
}

/** Which hexagon each logo shows, by the image file it displays, with its rendered height. */
async function shownLogos(page: Page) {
  return page.locator(".brand-logo").evaluateAll((logos) => logos.map((logo) => {
    const shown = [...logo.querySelectorAll("img")].filter((image) => image.getBoundingClientRect().height > 0)
    return { shown: shown.map((image) => /OnLight/.test(image.src) ? "black" : "white"), height: logo.getBoundingClientRect().height }
  }))
}

test("the logo turns black on light palettes and white on dark ones", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(`
    window.electronAPI = { getZoomFactor() { return 1 } }
    window.__CODENOMAD_RUNTIME_HOST__ = "electron"
    window.__CODENOMAD_WINDOW_CONTEXT__ = "local"
  `)
  // The palette lives in the "ui" state owner: keep it, so palette changes apply.
  let state: any = {}
  await page.route("**/api/**", async route => {
    const request = route.request()
    const ui = request.url().includes("/storage/state/ui")
    if (ui && request.method() === "PATCH") state = merge(state, request.postDataJSON())
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(ui ? state : {}) })
  })
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).brandFixture))
    const apply = (id: string) => page.evaluate((value) => (window as any).brandFixture.apply(value), id)

    await apply("light")
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light")
    // The title bar's logo, then the home page's, which follows its text-3xl title.
    assert.deepEqual(await shownLogos(page), [{ shown: ["black"], height: 20 }, { shown: ["black"], height: 64 }])

    await apply("classic")
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark")
    assert.deepEqual((await shownLogos(page)).map(({ shown }) => shown), [["white"], ["white"]])

    // Following the system, the logo follows the system's appearance.
    await apply("system")
    await page.emulateMedia({ colorScheme: "light" })
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light")
    assert.deepEqual((await shownLogos(page)).map(({ shown }) => shown), [["black"], ["black"]])
    await page.emulateMedia({ colorScheme: "dark" })
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark")
    assert.deepEqual((await shownLogos(page)).map(({ shown }) => shown), [["white"], ["white"]])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
