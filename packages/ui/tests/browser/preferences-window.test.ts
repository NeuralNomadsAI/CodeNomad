import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "preferences-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root" style="height:100vh"></div><script type="module" src="/tests/browser/fixtures/preferences-window.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

test("Preferences restores section and scroll after recreation and flushes an immediate close", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: `{
    const w = window
    w.__CODENOMAD_RUNTIME_HOST__ = "electron"
    w.__CODENOMAD_WINDOW_CONTEXT__ = "preferences"
    w.electronAPI = {
      getPreferencesRequest: async () => JSON.parse(localStorage.getItem("fixture-preferences") ?? '{"section":"general"}'),
      acceptPreferencesRequest: async (request) => {
        w.savingRequest = request
        await new Promise(resolve => setTimeout(resolve, w.saveDelay ?? 30))
        localStorage.setItem("fixture-preferences", JSON.stringify(request))
      },
      preferencesReady: async () => { w.ready = true },
      onPreferencesSection: (listener) => { w.section = listener; return () => {} },
      onPreferencesCloseRequested: (listener) => { w.closePreferences = listener; return () => {} },
      onPreferencesTransitionRequested: () => () => {},
      closeWindow: async () => { w.fixtureClosed = true },
    }
  }` })
  await page.route("**/api/**", route => new URL(route.request().url()).pathname.startsWith("/api/")
    ? route.fulfill({ contentType: "application/json", body: "{}" })
    : route.continue())
  try {
    await page.goto(url)
    await page.waitForFunction(() => (window as any).ready)
    await page.getByRole("button", { name: "Chat", exact: true }).click()
    const scroll = page.locator(".settings-screen-scroll")
    await page.waitForFunction(() => document.querySelector(".settings-screen-scroll")!.scrollHeight > 1300)
    await scroll.hover()
    await page.mouse.wheel(0, 420)
    await page.waitForFunction(() => document.querySelector(".settings-screen-scroll")!.scrollTop >= 400)
    const top = await scroll.evaluate(e => Math.round(e.scrollTop))
    await page.evaluate(() => (window as any).closePreferences())
    await page.waitForFunction(() => (window as any).fixtureClosed)
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("fixture-preferences")!))
    assert.equal(saved.section, "chat")
    assert.equal(saved.scrollTop, top)
    await page.reload()
    await page.waitForFunction(() => (window as any).ready)
    await page.waitForFunction(top => Math.abs(document.querySelector(".settings-screen-scroll")!.scrollTop - top) < 2, top)
    assert.equal(await page.getByRole("button", { name: "Chat", exact: true }).getAttribute("aria-current"), "page")
    // A targeted entry point overrides the remembered section and resets scroll.
    await page.evaluate(() => (window as any).section({ section: "general" }))
    await page.waitForFunction(() => document.querySelector('.settings-nav-button[aria-current="page"]')?.textContent?.includes("General"))
    await page.waitForFunction(() => document.querySelector(".settings-screen-scroll")!.scrollTop === 0)

    // Closing while a section write is in flight must snapshot the accepted
    // section, not the old section that was visible when close was requested.
    await page.evaluate(() => { (window as any).saveDelay = 200; (window as any).fixtureClosed = false })
    await page.getByRole("button", { name: "Chat", exact: true }).click()
    await page.waitForFunction(() => (window as any).savingRequest?.section === "chat")
    await page.evaluate(() => (window as any).closePreferences())
    await page.waitForFunction(() => (window as any).fixtureClosed)
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("fixture-preferences")!).section), "chat")

    // Application shutdown drains the view before native state ownership is
    // released, even if the scroll debounce has not fired yet.
    await page.reload()
    await page.waitForFunction(() => (window as any).ready)
    await scroll.hover()
    await page.mouse.wheel(0, 520)
    await page.waitForFunction(() => document.querySelector(".settings-screen-scroll")!.scrollTop >= 500)
    const shutdownTop = await scroll.evaluate(e => Math.round(e.scrollTop))
    await page.evaluate(() => (window as any).__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__())
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("fixture-preferences")!).scrollTop), shutdownTop)
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error({ errors, content: (await page.locator("body").innerText()).slice(0, 1000) })
    throw error
  } finally { await page.close() }
})
