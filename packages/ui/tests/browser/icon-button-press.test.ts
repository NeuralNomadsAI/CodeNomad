import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Locator, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"

let server: ViteDevServer, browser: Browser, url: string
let cache: Awaited<ReturnType<typeof createFixtureCache>>
before(async () => {
  cache = await createFixtureCache()
  server = await createServer({ configFile: false, cacheDir: cache.cacheDir, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "icon-button-press-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/icon-button-press.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close(); await cache?.dispose() })

const waves = (control: Locator) => control.locator(".MuiTouchRipple-ripple, .MuiTouchRipple-child").count()

async function press(page: Page, control: Locator) {
  const box = (await control.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(120)
  const count = await waves(control)
  await page.mouse.up()
  return count
}

test("SUID icon buttons and switches do not animate on press but keep the keyboard focus ripple", async () => {
  const page = await browser.newPage({ viewport: { width: 600, height: 200 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).iconButtonFixture))
    const button = page.getByRole("button", { name: "Header action" })
    const switchBase = page.locator(".MuiSwitch-switchBase")

    // Like the Message content trigger: pointer presses never start a ripple wave.
    assert.equal(await press(page, button), 0, "icon button press")
    assert.equal(await press(page, switchBase), 0, "switch press")

    // Keyboard focus still shows the focus ripple as the focus-visible cue.
    await page.locator("#before").focus()
    await page.keyboard.press("Tab")
    await page.waitForTimeout(150)
    assert.equal(await button.evaluate(el => el === document.activeElement && el.classList.contains("Mui-focusVisible")), true)
    assert.ok(await waves(button) > 0, "icon button keyboard focus ripple")
    await page.keyboard.press("Tab")
    await page.waitForTimeout(150)
    assert.equal(await switchBase.evaluate(el => el.classList.contains("Mui-focusVisible")), true)
    assert.ok(await waves(switchBase) > 0, "switch keyboard focus ripple")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
