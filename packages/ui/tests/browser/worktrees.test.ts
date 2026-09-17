import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "worktree-fixture", configureServer(s) {
      s.middlewares.use("/worktree-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/worktree-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/worktrees.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/worktree-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function prepare(page: Page) {
  page.on("pageerror", error => console.error(error))
  await page.addInitScript(`
    window.nativeCalls = [];
    window.__TAURI__ = { core: { invoke: async (...args) => { window.nativeCalls.push(args) } } };
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async text => { window.copied = text } } });
  `)
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  page.setDefaultTimeout(5000)
}

test("worktree actions use click/keyboard/touch without selecting or moving the session", async () => {
  const context = await browser.newContext({ hasTouch: true })
  const page = await context.newPage()
  try {
    await prepare(page)
    const trigger = page.locator(".selector-trigger")
    await trigger.click()
    const feature = page.getByRole("option", { name: /feature/ })
    await feature.getByRole("button", { name: "Copy path" }).click()
    assert.equal(await page.evaluate(() => (window as any).copied), "/repo/.codenomad/worktrees/feature")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls), [])
    await trigger.click()
    const open = page.getByRole("option", { name: /feature/ }).getByRole("button", { name: "Open in file manager" })
    await open.focus()
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => (window as any).nativeCalls.length > 0)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls), [])
    await trigger.tap()
    await page.getByRole("option", { name: /feature/ }).getByRole("button", { name: "Delete worktree", exact: true }).tap()
    await page.getByRole("dialog").waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls), [])
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(await page.evaluate(() => (window as any).fixture.location()), "/repo")
  } finally { await context.close() }
})

test("creation uses the selected source and the returned stable worktree ID", async () => {
  const page = await browser.newPage()
  try {
    await prepare(page)
    const trigger = page.locator(".selector-trigger")
    await trigger.click()
    await page.getByRole("option", { name: /feature/ }).locator(".selector-option-label").click()
    await page.waitForFunction(() => (window as any).fixture.calls.length === 1)
    await trigger.click()
    await page.getByRole("option", { name: /Create worktree/ }).click()
    await page.getByRole("textbox").fill("new-feature")
    await page.getByRole("button", { name: "Create and use worktree", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.calls.length === 3)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.calls), [
      { move: "stable-feature-id" }, { create: { slug: "new-feature", fromSlug: "stable-feature-id" } }, { move: "created-stable-id" },
    ])
  } finally { await page.close() }
})
