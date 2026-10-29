import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { chromium, type Browser, type Locator, type Page } from "playwright"
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
    armFixtureNavigationBudget(browser)
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


type Sample = { surface: RGB; fill: RGB; icon: RGB; css: string }
/** Composite the toggle's background over every ancestor's, as rendered, including
 * solid overlay gradients such as list-selection hover (`linear-gradient(c, c)`). */
const sample = (target: Locator) => target.evaluate((button) => {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!
  const overlay = (element: Element) => {
    const gradient = /^linear-gradient\((.*)\)$/.exec(getComputedStyle(element).backgroundImage)?.[1]
    if (!gradient) return undefined
    let depth = 0
    for (let i = 0; i < gradient.length; i++) {
      if (gradient[i] === "(") depth++
      else if (gradient[i] === ")") depth--
      else if (gradient[i] === "," && depth === 0) return gradient.slice(0, i).trim()
    }
    return undefined
  }
  const paint = (elements: Element[]) => {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, 1, 1)
    for (const element of elements) {
      for (const color of [getComputedStyle(element).backgroundColor, overlay(element)]) {
        if (!color) continue
        ctx.fillStyle = color
        ctx.fillRect(0, 0, 1, 1)
      }
    }
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3)
  }
  const ancestors: Element[] = []
  for (let node = button.parentElement; node; node = node.parentElement) ancestors.unshift(node)
  ctx.fillStyle = getComputedStyle(button).color
  ctx.fillRect(0, 0, 1, 1)
  const icon = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3)
  return { surface: paint(ancestors), fill: paint([...ancestors, button]), icon, css: getComputedStyle(button).backgroundColor }
}) as Promise<Sample>

// Speech capabilities that let the real message cards render their SpeechActionButton.
const SPEECH = { available: true, configured: true, provider: "fixture", supportsStt: false, supportsTts: true, supportsStreamingTts: true,
  sttModel: "", ttsModel: "fixture", ttsVoice: "fixture", ttsFormats: ["mp3"], streamingTtsFormats: ["mp3"],
  separateProviders: true, sttConfigured: false, ttsConfigured: true }

/** Real hosts of an active `.icon-toggle`, named by the surface beneath them. Overlay
 * windows resolve to the same colour as the canvas (both --surface-shade-strong). */
const hosts = (page: Page) => ({
  sidebar: page.getByRole("button", { name: "Search sessions", exact: true }),
  "right panel tabs": page.getByRole("button", { name: "Customize right panel", exact: true }),
  "user card": page.locator('[data-message-id="hello"] .message-action-button.icon-toggle'),
  "assistant card": page.locator('[data-message-id="reply"] .message-action-button.icon-toggle'),
  "dock header": page.locator(".interruption-dock .interruption-toggle"),
  canvas: page.locator(".message-stream > .icon-toggle-probe"),
})

test("active toggles carry a visible accent tint on every real surface and ready-made palette", { timeout: 240000 }, async (t) => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 760 } })
  page.setDefaultTimeout(15000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await page.route("**/api/speech/capabilities", route => route.fulfill({ json: SPEECH }))
    // tsx keeps function names; the sampled page needs its helper.
    await page.addInitScript("window.__name = f => f")
    await page.goto(`${url}?assistant`)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    // Keep the header wide enough for its inline actions, as in header-windows.test.ts.
    // Sample settled colours rather than ButtonBase's background transition.
    await page.addStyleTag({ content: ".session-center-column { flex: 0 0 1000px !important; min-width: 0 !important; } * { transition: none !important; }" })
    await page.locator(".session-header-expanded-actions").waitFor({ state: "visible" })
    await page.evaluate(() => (window as any).fixture.askQuestion())
    const search = page.locator('button[aria-controls^="session-search-"]')
    const targets = hosts(page)
    await targets["assistant card"].waitFor()
    await page.locator(".message-stream").evaluate(stream => {
      const probe = document.createElement("button")
      probe.className = "icon-toggle icon-toggle-probe"
      probe.setAttribute("aria-pressed", "true")
      probe.style.cssText = "width: 26px; height: 26px; border: 0;"
      // A selected Mission past-run row: a text list selection on the same canvas
      // role as the Missions panel and reader, not an icon toggle.
      const run = document.createElement("button")
      run.className = "mission-past-run"
      run.setAttribute("aria-pressed", "true")
      run.textContent = "Oct 8, 2026, 8:15 AM · Completed"
      stream.append(probe, run)
    })
    const pastRun = page.locator(".message-stream > .mission-past-run")
    // Switch each host on through its own ARIA state, as the product does; Solid
    // rewrites it only when that state changes, which does not happen while sampling.
    for (const target of Object.values(targets)) await target.evaluate(button =>
      button.setAttribute(button.hasAttribute("aria-expanded") ? "aria-expanded" : "aria-pressed", "true"))

    const away = () => page.mouse.move(1, 750)
    const failures: string[] = []
    for (const scheme of BUILT_IN_COLOR_SCHEMES.filter(s => s.colors && s.id !== "custom")) {
      await page.evaluate(async (id) => {
        const { applyColorScheme, normalizeColorScheme } = await import("/src/lib/theme-scheme.ts")
        applyColorScheme(normalizeColorScheme(id))
      }, scheme.id)
      // The header search toggle is exercised through its real open/close behaviour.
      if (await search.getAttribute("aria-expanded") !== "true") await search.click()
      await away()
      const measured: Record<string, { active: Sample; hover: Sample }> = {}
      measured.header = { active: await sample(search), hover: await search.hover().then(() => sample(search)) }
      await search.click()
      await search.hover()
      const idleHover = await sample(search)
      assert.equal(await search.getAttribute("aria-expanded"), "false")
      for (const [name, target] of Object.entries(targets)) {
        await away()
        // Message actions only accept the pointer once their card is hovered; the
        // second move then reaches the revealed button, as a user's pointer does.
        const active = await sample(target)
        await target.hover({ force: true, position: { x: 8, y: 8 } })
        await target.hover({ force: true })
        measured[name] = { active, hover: await sample(target) }
      }
      await away()

      const notes: string[] = []
      for (const [name, { active, hover }] of Object.entries(measured)) {
        const label = `${scheme.id}/${name}: surface ${active.surface} active ${active.fill} (${active.css})`
        const tint = distance(active.fill, active.surface)
        // The previous neutral fill measured ΔE 0.4–1.2 on the soft light headers. The
        // header keeps a wider margin; muted cards sit closest to some accents.
        if (tint < (name === "header" ? 8 : 5)) failures.push(`${label} ΔE ${tint.toFixed(1)}`)
        // 40% → 50% is a smaller step where the ink sits close to the surface (muted cards).
        if (distance(hover.fill, active.fill) < 1.4) failures.push(`${label} vs active hover ${hover.fill}`)
        // Icons are non-text graphics (WCAG 1.4.11: 3:1), including on the stronger hover fill.
        for (const [state, value] of [["active", active], ["active hover", hover]] as const) {
          if (contrast(value.icon, value.fill) < 3) failures.push(`${label} ${state} icon ${value.icon} ${contrast(value.icon, value.fill).toFixed(2)}`)
        }
        notes.push(`${name} ΔE ${tint.toFixed(1)} step ${distance(hover.fill, active.fill).toFixed(1)} icon ${contrast(active.icon, active.fill).toFixed(2)}/${contrast(hover.icon, hover.fill).toFixed(2)}`)
      }
      const header = measured.header.active
      if (distance(header.fill, idleHover.fill) < 6) failures.push(`${scheme.id}/header: active ${header.fill} vs idle hover ${idleHover.fill}`)

      // Selected past-run text keeps normal-text contrast (WCAG 1.4.3: 4.5:1).
      const runText: string[] = []
      for (const state of ["selected", "selected hover"]) {
        if (state === "selected hover") await pastRun.hover({ force: true })
        else await away()
        const run = await sample(pastRun)
        if (contrast(run.icon, run.fill) < 4.5) failures.push(`${scheme.id}/past run ${state}: text ${run.icon} on ${run.fill} ${contrast(run.icon, run.fill).toFixed(2)}`)
        runText.push(contrast(run.icon, run.fill).toFixed(2))
      }
      await away()
      t.diagnostic(`${scheme.id}: idle-hover ΔE ${distance(header.fill, idleHover.fill).toFixed(1)}; ${notes.join("; ")}; past run text ${runText.join("/")}`)
    }
    assert.deepEqual(failures, [])

    // A disabled toggle keeps its own disabled treatment, not the active tint.
    await search.click()
    await away()
    const enabled = await sample(search)
    await search.evaluate(button => (button as HTMLButtonElement).disabled = true)
    const disabled = await sample(search)
    assert.equal(await search.getAttribute("aria-expanded"), "true")
    assert.deepEqual(disabled.fill, disabled.surface)
    assert.notDeepEqual(enabled.fill, enabled.surface)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})