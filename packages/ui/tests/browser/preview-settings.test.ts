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
    plugins: [solid(), { name: "preview-settings-fixture", configureServer(s) {
      s.middlewares.use("/fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/preview-settings.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close(); await cache?.dispose() })

async function open(page: Page): Promise<void> {
  await page.goto(url)
  await page.locator("#fixture-status[data-config-loaded='true']").waitFor({ state: "attached" })
}

const patches = (page: Page): Promise<Array<{ owner: string; patch: any }>> =>
  page.evaluate(() => (window as any).fixture.patches)

test("custom origin validation blocks invalid and app origins, then saves the policy", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await open(page)
    const origin = page.getByLabel("Origin", { exact: true })
    await origin.selectOption("custom")
    const input = page.getByLabel("Preview origin", { exact: true })
    await input.waitFor()

    await input.fill("not an origin")
    await page.getByRole("button", { name: "Save origin", exact: true }).click()
    await page.getByText("Enter an absolute http:// or https:// origin without a path, query, fragment or credentials.", { exact: true }).waitFor()
    assert.deepEqual(await patches(page), [])

    await input.fill(await page.evaluate(() => location.origin))
    await page.getByRole("button", { name: "Save origin", exact: true }).click()
    await page.getByText("This is the origin CodeNomad itself is served from. Choose a different hostname.", { exact: true }).waitFor()
    assert.deepEqual(await patches(page), [])

    await input.fill("https://preview.example.test/")
    await page.getByRole("button", { name: "Save origin", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.patches.length === 1)
    const [saved] = await patches(page)
    assert.equal(saved.owner, "server")
    assert.equal(saved.patch.preview.originMode, "custom")
    assert.equal(saved.patch.preview.customOrigin, "https://preview.example.test")
    assert.deepEqual(saved.patch.preview.sandbox, { forms: true, modals: true, popups: true, downloads: true })
    assert.deepEqual(saved.patch.preview.features, {
      camera: false, microphone: false, clipboardRead: false, clipboardWrite: false,
      geolocation: false, fullscreen: false,
    })
    assert.equal(await input.inputValue(), "https://preview.example.test")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("sandbox and browser feature toggles save immediately and always keep scripts", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await open(page)
    const scripts = page.getByLabel("Scripts", { exact: true })
    assert.equal(await scripts.isDisabled(), true)
    assert.equal(await scripts.isChecked(), true)

    await page.getByLabel("Forms", { exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.patches.length === 1)
    let logged = await patches(page)
    assert.equal(logged[0].patch.preview.originMode, "opaque")
    assert.deepEqual(logged[0].patch.preview.sandbox, { forms: false, modals: true, popups: true, downloads: true })

    await page.getByLabel("Camera", { exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.patches.length === 2)
    logged = await patches(page)
    assert.deepEqual(logged[1].patch.preview.sandbox, { forms: false, modals: true, popups: true, downloads: true })
    assert.deepEqual(logged[1].patch.preview.features, {
      camera: true, microphone: false, clipboardRead: false, clipboardWrite: false,
      geolocation: false, fullscreen: false,
    })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("CodeNomad same-origin asks for confirmation before saving", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await open(page)
    const origin = page.getByLabel("Origin", { exact: true })

    await origin.selectOption("app")
    const dialog = page.getByRole("dialog")
    await dialog.waitFor()
    await dialog.getByText("Share the CodeNomad origin?", { exact: true }).waitFor()
    assert.match(await dialog.innerText(), /read and change CodeNomad storage, transcript and DOM/)
    assert.deepEqual(await patches(page), [])

    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await dialog.waitFor({ state: "detached" })
    assert.equal(await origin.inputValue(), "opaque")
    assert.deepEqual(await patches(page), [])

    await origin.selectOption("app")
    const confirmation = page.getByRole("dialog")
    await confirmation.waitFor()
    await confirmation.getByRole("button", { name: "Use same-origin", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.patches.length === 1)
    const [saved] = await patches(page)
    assert.equal(saved.patch.preview.originMode, "app")
    await page.getByText("Service workers use the CodeNomad origin and can control CodeNomad pages and persist after the preview closes. The same-origin confirmation covers this risk.", { exact: true }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
