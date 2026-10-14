import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { createFixtureCache } from "./fixture-cache"

let cache: Awaited<ReturnType<typeof createFixtureCache>>, server: ViteDevServer, browser: Browser, url: string
before(async () => {
  cache = await createFixtureCache()
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), cacheDir: cache.cacheDir, logLevel: "error",
    plugins: [solid(), { name: "help-command-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/help-command.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { try { await browser?.close() } finally { try { await server?.close() } finally { await cache?.dispose() } } })

for (const [host, context] of [["web", "remote"], ["electron", "local"], ["tauri", "local"], ["electron", "remote"], ["tauri", "remote"]]) test(`${host}/${context}: native help command and palette open the live UI locale externally`, async () => {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.addInitScript({ content: `
    const host = ${JSON.stringify(host)}
    window.__CODENOMAD_RUNTIME_HOST__ = host
    window.__CODENOMAD_WINDOW_CONTEXT__ = ${JSON.stringify(context)}
    window.opened = []
    window.open = (...args) => { window.opened.push(args); return null }
     window.failOpen = false
     window.open = (...args) => { if(window.failOpen) throw new Error('opener failure'); window.opened.push(args); return null }
     if (host === "electron") window.electronAPI = { onMenuAction: handler => { window.deliverMenu = handler; return () => {} } }
     if (host === "tauri") {
       let callback, handler
       window.__TAURI_INTERNALS__ = {
         metadata: { currentWebview: { label: 'main' }, currentWindow: { label: 'main' } },
         transformCallback: fn => { callback = fn; return 1 },
         invoke: async (command, args) => {
           if (command === 'plugin:event|listen') { handler = args.handler; window.deliverMenu = payload => callback({payload}); return handler }
           if (command === 'plugin:opener|open_url') { if(window.failOpen) throw new Error('opener failure'); window.opened.push([command, args]) }
         },
       }
     }
  ` })
  await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
     await page.getByRole("button", { name: "Palette", exact: true }).waitFor()
     await page.getByRole("textbox", { name: "Draft" }).fill("Preserved unsent draft")
    await page.evaluate(() => (window as any).helpFixture.setLocale("fr"))
     if (context === "remote") {
       await page.getByRole("button", { name: "Palette" }).click()
       await page.getByText("Ouvrir l’aide", { exact: true }).click()
     } else await page.evaluate(() => (window as any).deliverMenu("open-help"))
    await page.waitForFunction(() => (window as any).opened.length === 1)
    const readUrl = () => page.evaluate(() => {
      const opened = (window as any).opened.at(-1)
      return opened[0] === "plugin:opener|open_url" ? opened[1].url : opened[0]
    })
     assert.equal(await readUrl(), "https://neuralnomadsai.github.io/CodeNomad/fr/")
     if (context === "local") {
       await page.evaluate(() => { (window as any).deliverMenu('new-instance'); (window as any).deliverMenu({invalid:'payload'}); (window as any).deliverMenu('unknown-action') })
       assert.equal(await page.evaluate(() => (window as any).newInstanceCount), 1, 'other commands keep their shared dispatch')
       assert.equal(await page.evaluate(() => (window as any).opened.length), 1, 'unknown menu payloads do nothing')
     }
    await page.evaluate(() => (window as any).helpFixture.setLocale("he"))
     await page.getByRole("button", { name: "Palette" }).click()
     await page.getByText("פתיחת עזרה", { exact: true }).click()
    await page.waitForFunction(() => (window as any).opened.length === 2)
    assert.equal(await readUrl(), "https://neuralnomadsai.github.io/CodeNomad/he/")
     assert.equal(page.url(), url, "help never replaces the renderer")
     assert.equal(await page.locator('textarea[aria-label="Draft"]').inputValue(), "Preserved unsent draft")
     assert.equal(await page.getByRole("dialog").count(), 0, "noopener null is not a failure")
     const screenshots = join(tmpdir(), "codenomad-help")
     await mkdir(screenshots, { recursive: true })
     await page.getByRole("button", { name: "Palette" }).click()
     await page.screenshot({ path: join(screenshots, `app-help-${host}-${context}-he.png`) })
     await page.evaluate(() => { (window as any).failOpen = true })
     await page.getByText("פתיחת עזרה", { exact: true }).click()
     await page.getByRole("dialog").waitFor()
     assert.ok((await page.getByRole("dialog").innerText()).includes("https://neuralnomadsai.github.io/CodeNomad/"))
     assert.equal(await page.evaluate(() => (window as any).opened.length), 2, "failed opening never replays")
     assert.equal(await page.locator('textarea[aria-label="Draft"]').inputValue(), "Preserved unsent draft")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
