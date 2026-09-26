import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

// Fail fast on a wrong expectation instead of burning the default 30s timeout
// on every wait in this file.
// The cold first paint of this fixture is slower than the interactions, so the
// short budget only applies once the selector is on screen.
const ACTION_TIMEOUT = 10_000

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

const gotoFixture = async (page: Page, query = "") => {
  await page.goto(`${url}${query}`)
  await page.locator("[data-model-selector-control] .selector-trigger").waitFor()
}

const openPicker = async (page: Page) => {
  await page.locator("[data-model-selector-control] .selector-trigger").click()
  await page.locator(".selector-listbox li").first().waitFor()
}

const closePicker = async (page: Page) => {
  await page.locator("[data-model-selector-control] .selector-trigger").click()
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
    await gotoFixture(page)

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
    assert.equal(await page.evaluate(() => (window as any).fixture.mounts()), 1)
    await page.locator("#remount").click()
    await page.waitForFunction(() => (window as any).fixture.mounts() === 2 && (window as any).fixture.cleanups() === 1)
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

test("a rapid double click alternates the mode instead of sticking", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await gotoFixture(page)
    await openPicker(page)

    // Both clicks land before the first write settles. The seeded value is
    // already "all models", so the persisted log is the only thing that can
    // prove the pair was written in order rather than skipped.
    await page.evaluate(() => (window as any).fixture.setLatency(150))
    await page.locator(".selector-favorites-toggle").click()
    await page.locator(".selector-favorites-toggle").click()
    assert.equal(await favoritesOnly(page), "false", "the second click is read, not swallowed")

    await page.waitForFunction(() => (window as any).fixture.applied().length === 2)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.applied()), [
      { models: { favoritesOnly: true } },
      { models: { favoritesOnly: false } },
    ], "an unserialized queue would persist the slow write last")
    assert.equal(await page.evaluate(() => (window as any).fixture.state().models.favoritesOnly), false)
    assert.equal(await page.evaluate(() => (window as any).fixture.mode()), false)
    assert.equal(await favoritesOnly(page), "false")
    assert.deepEqual(await listed(page), allModels)
  } finally { await page.close() }
})

test("a model hidden by provider visibility stays hidden and unselectable", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await gotoFixture(page)

    // Hide the active model, which is also a favorite, then look at both modes.
    await page.locator("#pick-favorite").click()
    await page.evaluate(() => (window as any).fixture.hideModel("openai", "gpt-6-astra"))
    await openPicker(page)
    assert.deepEqual(await listed(page), ["GPT-6 Sol", "Muse Spark", "Zen Other"])
    const hiddenOption = page.locator(".selector-listbox .selector-option", { hasText: "GPT-6 Astra" })
    assert.equal(await hiddenOption.count(), 0, "a hidden model is not offered again")

    await page.locator(".selector-favorites-toggle").click()
    await page.waitForFunction(() => document.querySelectorAll(".selector-listbox .selector-option-label").length === 1)
    assert.deepEqual(await listed(page), ["GPT-6 Sol"])
    assert.equal(await page.locator(".selector-listbox .selector-option", { hasText: "GPT-6 Astra" }).count(), 0)
  } finally { await page.close() }
})

test("a stored favorites mode without favorites stays visible and revocable", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await gotoFixture(page, "?favorites=none&mode=favorites")

    await openPicker(page)
    assert.deepEqual(await listed(page), allModels, "there is nothing to restrict the list to")
    assert.equal(await favoritesOnly(page), "true", "the stored mode is still reported")
    assert.equal(await page.locator(".selector-favorites-toggle").isDisabled(), false, "and can be turned off")

    // Adding a favorite applies the stored mode rather than silently keeping all models.
    await page.locator(".selector-listbox .selector-option", { hasText: "GPT-6 Astra" })
      .locator(".selector-option-star").click()
    await page.waitForFunction(() => document.querySelectorAll(".selector-listbox .selector-option-label").length === 2)
    assert.equal(await favoritesOnly(page), "true")

    await closePicker(page)
    await openPicker(page)
    assert.equal(await favoritesOnly(page), "true")
    assert.deepEqual(await listed(page), ["GPT-6 Astra", "Zen Other"], "the favorite plus the active model")
  } finally { await page.close() }
})

test("a three-click burst never lets a superseded write flip the shown mode", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await gotoFixture(page)
    await openPicker(page)

    await page.evaluate(() => (window as any).fixture.setLatency(150))
    const toggle = page.locator(".selector-favorites-toggle")
    await toggle.click()
    await toggle.click()
    await toggle.click()

    // Sample the rendered state while the burst is still settling: the newest
    // intent is "on", so neither the star nor the list may show the older value.
    const samples: string[] = []
    while (await page.evaluate(() => (window as any).fixture.applied().length) < 3) {
      samples.push(`${await toggle.getAttribute("aria-pressed")}/${await page.locator(".selector-listbox .selector-option-label").count()}`)
      await page.waitForTimeout(20)
    }
    assert.ok(samples.every((sample) => sample === "true/3"), `the shown mode never flips: ${samples.join(", ")}`)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.applied()), [
      { models: { favoritesOnly: true } },
      { models: { favoritesOnly: false } },
      { models: { favoritesOnly: true } },
    ])
    assert.equal(await page.evaluate(() => (window as any).fixture.state().models.favoritesOnly), true)
    assert.equal(await favoritesOnly(page), "true")
    assert.deepEqual(await listed(page), favoritesPlusNonFavorite)
  } finally { await page.close() }
})

test("a current model missing from the catalog stays listed as an unavailable row", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "{}" }))
  try {
    await gotoFixture(page, "?current=zen/retired-model")

    await openPicker(page)
    // Sorted into its own provider group by model name, not prepended.
    assert.deepEqual(await listed(page), ["GPT-6 Astra", "GPT-6 Sol", "Muse Spark", "retired-model (unavailable)", "Zen Other"])
    const unavailable = page.locator(".selector-listbox .selector-option", { hasText: "retired-model" })
    assert.equal(await unavailable.getAttribute("data-disabled"), "", "an unavailable model cannot be selected")
    assert.equal(await unavailable.locator(".selector-option-star").count(), 0, "and carries no favorite toggle")

    // Favorites-only keeps that placeholder next to the favorites.
    await page.locator(".selector-favorites-toggle").click()
    await page.waitForFunction(() => document.querySelectorAll(".selector-listbox .selector-option-label").length === 3)
    assert.deepEqual(await listed(page), ["GPT-6 Astra", "GPT-6 Sol", "retired-model (unavailable)"])
  } finally { await page.close() }
})
