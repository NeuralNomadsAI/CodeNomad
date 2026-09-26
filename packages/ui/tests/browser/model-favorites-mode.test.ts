import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, url: string
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "model-favorites-fixture", configureServer(s) {
      s.middlewares.use("/model-favorites-fixture", async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml("/model-favorites-fixture", '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/model-favorites-mode.tsx"></script></body></html>'))
      })
    } }], resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/model-favorites-fixture`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

const openPicker = async (page: Page) => {
  await page.locator("[data-model-selector-control] .selector-trigger").click()
  await page.locator(".selector-listbox li").first().waitFor()
}

const closePicker = async (page: Page) => {
  await page.keyboard.press("Escape")
  await page.locator(".selector-favorites-toggle").waitFor({ state: "hidden" })
}

const listed = async (page: Page) =>
  (await page.locator(".selector-listbox .selector-option-label").allInnerTexts()).map((text) => text.trim())

const favoritesOnly = async (page: Page) => page.locator(".selector-favorites-toggle").getAttribute("aria-pressed")

const selectModel = async (page: Page, label: string) => {
  await page.locator(".selector-listbox .selector-option", { hasText: label }).first().click()
  await page.locator(".selector-favorites-toggle").waitFor({ state: "hidden" })
  assert.match(await page.locator(".selector-trigger-primary").innerText(), new RegExp(label))
}

const allModels = ["GPT-6 Astra", "GPT-6 Sol", "Muse Spark", "Zen Other"]
const favoritesPlusNonFavorite = ["GPT-6 Astra", "GPT-6 Sol", "Zen Other"]

test("the favorites mode persists and always keeps the current model listed", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await page.goto(url)
    await page.locator("[data-model-selector-control] .selector-trigger").waitFor()

    // The catalog starts in the stored "all" mode with a non-favorite current model.
    await openPicker(page)
    assert.equal(await favoritesOnly(page), "false")
    assert.deepEqual(await listed(page), allModels)

    // Favorites-only narrows the list but keeps the non-favorite current model.
    await page.locator(".selector-favorites-toggle").click()
    await page.waitForFunction(() => document.querySelectorAll(".selector-listbox .selector-option-label").length === 3)
    assert.equal(await favoritesOnly(page), "true")
    assert.deepEqual(await listed(page), favoritesPlusNonFavorite)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.writes()), [{ models: { favoritesOnly: true } }])

    // Choosing a favorite model does not widen the stored mode on reopen, and a
    // favorite selection is the whole list.
    await selectModel(page, "GPT-6 Astra")
    await openPicker(page)
    assert.equal(await favoritesOnly(page), "true")
    assert.deepEqual(await listed(page), ["GPT-6 Astra", "GPT-6 Sol"])

    // An externally driven change to a non-favorite model keeps the stored mode too.
    await closePicker(page)
    await page.locator("#pick-non-favorite").click()
    await openPicker(page)
    assert.equal(await favoritesOnly(page), "true")
    assert.deepEqual(await listed(page), favoritesPlusNonFavorite)

    // A fresh selector instance reads the stored mode rather than a per-open guess.
    await closePicker(page)
    await page.locator("#remount").click()
    await openPicker(page)
    assert.equal(await favoritesOnly(page), "true")
    assert.deepEqual(await listed(page), favoritesPlusNonFavorite)

    // Search filters within the chosen mode and never silently widens it.
    await page.locator(".selector-search-input").fill("zen")
    await page.waitForFunction(() => document.querySelectorAll(".selector-listbox .selector-option-label").length === 1)
    assert.deepEqual(await listed(page), ["Zen Other"])
    await page.locator(".selector-search-input").fill("")
    await page.waitForFunction(() => document.querySelectorAll(".selector-listbox .selector-option-label").length === 3)
    assert.equal(await favoritesOnly(page), "true")

    // Turning the mode off restores the full catalog and persists that choice.
    await page.locator(".selector-favorites-toggle").click()
    await page.waitForFunction(() => document.querySelectorAll(".selector-listbox .selector-option-label").length === 4)
    assert.equal(await favoritesOnly(page), "false")
    assert.deepEqual(await listed(page), allModels)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.writes()), [
      { models: { favoritesOnly: true } },
      { models: { favoritesOnly: false } },
    ])
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.state()), {
      models: {
        favorites: [{ providerId: "openai", modelId: "gpt-6-astra" }, { providerId: "openai", modelId: "gpt-6-sol" }],
        favoritesOnly: false,
      },
    })
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
