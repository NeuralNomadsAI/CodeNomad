import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string

before(async () => {
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("../..", import.meta.url)),
    logLevel: "error",
    plugins: [solid(), {
      name: "interruption-selection-fixture",
      configureServer(server) {
        server.middlewares.use("/fixture", async (_request, response) => {
          response.setHeader("Content-Type", "text/html")
          response.end(await server.transformIndexHtml("/fixture",
            '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/interruption-dock.tsx"></script></body></html>'))
        })
      },
    }],
    resolve: { dedupe: ["solid-js"] },
    optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})

after(async () => { await browser?.close(); await server?.close() })

test("a question stays selected and focused when the newly visited session receives a permission", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  page.setDefaultTimeout(15000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 })
    await page.waitForFunction(() => Boolean((window as any).fixture?.snapshot().ids.length), undefined, { timeout: 60000 })
    await page.evaluate(() => (window as any).fixture.ask())
    const answer = page.locator('.interruption-dock input[type="text"]:visible')
    await answer.fill("Draft before switching")

    // This session has no request: the same question remains visible after the pane remount.
    await page.evaluate(() => (window as any).fixture.switch("other"))
    assert.equal(await answer.inputValue(), "Draft before switching")
    await answer.fill("Continue the original answer")

    const pending = await page.evaluate(async modulePath => {
      const { addPermissionToQueue, getPermissionQueue } = await import(/* @vite-ignore */ modulePath)
      addPermissionToQueue("interruptions", {
        id: "permission-other", sessionID: "other", action: "bash", resources: ["git status"], metadata: {},
      })
      return getPermissionQueue("interruptions").map((request: { id: string; sessionID: string }) => ({
        id: request.id, sessionID: request.sessionID,
      }))
    }, "/src/stores/instances.ts")

    assert.deepEqual(pending, [{ id: "permission-other", sessionID: "other" }])
    assert.equal(await answer.inputValue(), "Continue the original answer")
    assert.equal(await answer.evaluate(element => element === document.activeElement), true)
    assert.equal(await page.locator(".interruption-session").innerText(), "Main session")
    assert.equal(await page.locator(".interruption-position").innerText(), "2 / 2")
    assert.equal(await page.getByRole("button", { name: "Previous request", exact: true }).isEnabled(), true)
    assert.equal(await page.getByRole("button", { name: "Next request", exact: true }).isDisabled(), true)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
