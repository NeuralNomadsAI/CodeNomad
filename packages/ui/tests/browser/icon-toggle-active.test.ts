import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { BUILT_IN_COLOR_SCHEMES } from "../../src/lib/theme-scheme"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { prepareInterruptionDock } from "./fixtures/interruption-dock-preparation"

const ENTRY = "/tests/browser/fixtures/header-windows.tsx"
let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>> | undefined
async function disposeFixture() {
  try { await browser?.close() }
  finally {
    if (server) await server.close()
    else await cache?.dispose()
  }
}
before(async () => {
  try {
    cache = await createFixtureCache()
    const shutdown = createFixtureShutdown(cache)
    server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
      cacheDir: cache.cacheDir,
      plugins: [shutdown.plugin, solid(), { name: "icon-toggle-fixture", configureServer(s) {
        s.middlewares.use("/fixture", async (_req, res) => {
          res.setHeader("Content-Type", "text/html")
          res.end(await s.transformIndexHtml("/fixture", `<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="${ENTRY}"></script></body></html>`))
        })
      } }], resolve: { dedupe: ["solid-js"] },
      optimizeDeps: { entries: [ENTRY.slice(1)], exclude: ["lucide-solid"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    })
    shutdown.own(server)
    await server.listen()
    await prepareInterruptionDock(server, ENTRY)
    url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  } catch (error) {
    try { await disposeFixture() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Icon toggle fixture setup and cleanup failed") }
    throw error
  }
})
after(disposeFixture)

type RGB = [number, number, number]
const linear = (v: number) => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 }
const luminance = (c: RGB) => .2126 * linear(c[0]) + .7152 * linear(c[1]) + .0722 * linear(c[2])
const contrast = (a: RGB, b: RGB) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + .05) / (y + .05) }
function oklab(c: RGB) {
  const [r, g, b] = c.map(linear)
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b)
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b)
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b)
  return [.2104542553 * l + .793617785 * m - .0040720468 * s, 1.9779984951 * l - 2.428592205 * m + .4505937099 * s, .0259040371 * l + .7827717662 * m - .808675766 * s]
}
// OKLab distance scaled to 100, as in palette-quality.test.ts.
const distance = (a: RGB, b: RGB) => Math.hypot(...oklab(a).map((v, i) => v - oklab(b)[i])) * 100

/** Composite the button's background over every ancestor's, as rendered. */
const sample = (page: Page) => page.locator('button[aria-controls^="session-search-"]').evaluate((button) => {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!
  const paint = (elements: Element[]) => {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, 1, 1)
    for (const element of elements) {
      ctx.fillStyle = getComputedStyle(element).backgroundColor
      ctx.fillRect(0, 0, 1, 1)
    }
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3)
  }
  const ancestors: Element[] = []
  for (let node = button.parentElement; node; node = node.parentElement) ancestors.unshift(node)
  ctx.fillStyle = getComputedStyle(button).color
  ctx.fillRect(0, 0, 1, 1)
  const icon = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3)
  return { surface: paint(ancestors), fill: paint([...ancestors, button]), icon, expanded: button.getAttribute("aria-expanded"),
    css: getComputedStyle(button).backgroundColor }
}) as Promise<{ surface: RGB; fill: RGB; icon: RGB; expanded: string | null; css: string }>

test("active header toggles carry a visible accent tint on every ready-made palette", { timeout: 120000 }, async (t) => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 700 } })
  page.setDefaultTimeout(15000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    // tsx keeps function names; the sampled page needs its helper.
    await page.addInitScript("window.__name = f => f")
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    // Keep the header wide enough for its inline actions, as in header-windows.test.ts.
    // Sample settled colours rather than ButtonBase's background transition.
    await page.addStyleTag({ content: ".session-center-column { flex: 0 0 1000px !important; min-width: 0 !important; } * { transition: none !important; }" })
    await page.locator(".session-header-expanded-actions").waitFor({ state: "visible" })
    const search = page.locator('button[aria-controls^="session-search-"]')
    const failures: string[] = []
    for (const scheme of BUILT_IN_COLOR_SCHEMES.filter(s => s.colors && s.id !== "custom")) {
      await page.evaluate(async (id) => {
        const { applyColorScheme, normalizeColorScheme } = await import("/src/lib/theme-scheme.ts")
        applyColorScheme(normalizeColorScheme(id))
      }, scheme.id)
      if (await search.getAttribute("aria-expanded") !== "true") await search.click()
      await page.mouse.move(1, 690)
      const active = await sample(page)
      await search.hover()
      const activeHover = await sample(page)
      await search.click()
      await search.hover()
      const idleHover = await sample(page)
      await page.mouse.move(1, 690)
      assert.equal(active.expanded, "true")
      assert.equal(idleHover.expanded, "false")
      const label = `${scheme.id}: surface ${active.surface} active ${active.fill} (${active.css})`
      // The previous neutral fill measured ΔE 0.4–1.2 on the soft light palettes;
      // the 40% accent tint measures at least ~10, and its 50% hover stays a step stronger.
      if (distance(active.fill, active.surface) < 8) failures.push(`${label} ΔE ${distance(active.fill, active.surface).toFixed(1)}`)
      if (distance(active.fill, idleHover.fill) < 6) failures.push(`${label} vs idle hover ${idleHover.fill}`)
      if (distance(activeHover.fill, active.fill) < 2) failures.push(`${label} vs active hover ${activeHover.fill}`)
      // Icons are non-text graphics (WCAG 1.4.11: 3:1), including on the stronger hover fill.
      for (const [state, sample] of [["active", active], ["active hover", activeHover]] as const) {
        if (contrast(sample.icon, sample.fill) < 3) failures.push(`${label} ${state} icon ${sample.icon} ${contrast(sample.icon, sample.fill).toFixed(2)}`)
      }
      t.diagnostic(`${scheme.id}: ΔE surface ${distance(active.fill, active.surface).toFixed(1)}, idle hover ${distance(active.fill, idleHover.fill).toFixed(1)}, active hover ${distance(activeHover.fill, active.fill).toFixed(1)}, icon ${contrast(active.icon, active.fill).toFixed(2)}:1, hover icon ${contrast(activeHover.icon, activeHover.fill).toFixed(2)}:1`)
    }
    assert.deepEqual(failures, [])

    // A disabled toggle keeps its own disabled treatment, not the active tint.
    await search.click()
    await page.mouse.move(1, 690)
    const enabled = await sample(page)
    await search.evaluate(button => (button as HTMLButtonElement).disabled = true)
    const disabled = await sample(page)
    assert.equal(disabled.expanded, "true")
    assert.deepEqual(disabled.fill, disabled.surface)
    assert.notDeepEqual(enabled.fill, enabled.surface)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
