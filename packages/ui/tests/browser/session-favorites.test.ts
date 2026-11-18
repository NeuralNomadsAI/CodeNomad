import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import Fastify from "fastify"
import { chromium, type Page } from "playwright"
import { EventBus } from "../../../server/src/events/bus"
import { SettingsService } from "../../../server/src/settings/service"
import { resolveConfigLocation } from "../../../server/src/config/location"
import { createLogger } from "../../../server/src/logger"
import { registerSessionFavoritesRoutes } from "../../../server/src/server/routes/session-favorites"
import { registerSettingsRoutes } from "../../../server/src/server/routes/settings"
import { borrowFixture } from "./fixture-borrow"
import { fixtureEventStream } from "./fixture-event-stream"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

const row = (page: Page, id: string) => page.locator(`[data-session-id="ses_${id}"]`)
const actions = (page: Page, id: string) => row(page, id).getByRole("button", { name: "Plus d'actions" })
const menu = (page: Page) => page.getByRole("menu")
const first = (page: Page) => page.locator(".session-item-base").first()
const filters = (page: Page) => page.getByRole("button", { name: "Rechercher des sessions", exact: true })
const search = (page: Page) => page.getByRole("textbox", { name: "Rechercher des sessions", exact: true })
const hidden = (page: Page) => page.getByRole("button", { name: "Afficher 1 résultat masqué", exact: true })
const favoritesOnly = (page: Page) => page.getByRole("button", { name: "Favoris uniquement", exact: true })
const owner = "/api/workspaces/favorites-workspace/session-favorites"
const main = { path: "/bureau" }, unrelated = { path: "/unrelated" }
const logger = createLogger({ level: "error" })

test("favorites persist, keep requests first and synchronize over the real route and SSE", { timeout: 90_000 }, async () => {
  const { url } = await borrowFixture({ name: "session-favorites", routes: [{ path: "/fixture",
    html: '<html lang="fr" data-theme="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module" src="/tests/browser/fixtures/session-favorites.tsx"></script></body></html>' }] })
  const events = await fixtureEventStream(url)
  const tmp = await mkdtemp(path.join(tmpdir(), "codenomad-test-session-favorites-"))
  const app = Fastify(), bus = new EventBus(), cfg = resolveConfigLocation(tmp)
  const off = bus.onEvent(events.send)
  const serverSession = (sessionID: string) => ({ id: sessionID, parentID: sessionID === "ses_conseil" ? "ses_equipe" : undefined,
    location: { directory: sessionID === "ses_foreign" ? "/unrelated" : "/bureau" },
    metadata: { thirdParty: { verified: "leave alone" } } })
  const settings = new SettingsService(cfg, bus, logger)
  registerSettingsRoutes(app, { settings, logger })
  registerSessionFavoritesRoutes(app, { settings, eventBus: bus, workspaceManager: {
    get: (id: string) => id === "favorites-workspace" || id === "other-window" ? main : id === "unrelated" ? unrelated : undefined,
    getSharedServiceConnection: async () => ({ assertCurrent() {}, client: { session: {
      get: async ({ sessionID }: { sessionID: string }) => serverSession(sessionID),
      update: async () => assert.fail("must not change third-party metadata"),
    } } }),
    ownsLocation: async (id: string, location: { directory: string }) => id !== "unrelated" && location.directory === "/bureau",
  } as any })
  const setup = async (page: Page, duplicate = false) => {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await events.route(page)
    await page.route("**/api/workspaces/*/session-favorites**", async route => {
      let pathname = new URL(route.request().url()).pathname
      if (duplicate) pathname = pathname.replace("favorites-workspace", "other-window")
      const response = await app.inject({ method: route.request().method() as "GET" | "PUT", url: pathname,
        ...(route.request().method() === "PUT" ? { payload: route.request().postDataJSON() } : {}) })
      await route.fulfill({ status: response.statusCode, contentType: "application/json", body: response.body })
    })
    await page.route("**/fixture-native-delete", async route => {
      const sessionID = route.request().postData()!
      bus.publish({ type: "instance.event", instanceId: "favorites-workspace", event: {
        type: "session.deleted", id: "evt_deleted", created: 1, location: { directory: "/bureau" },
        data: { sessionID }, durable: { aggregateID: sessionID, seq: 1, version: 1 },
      } } as never)
      await route.fulfill({ status: 204 })
    })
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).favoriteFixture))
  }
  const selectFavorite = async (page: Page, id: string, add = true) => {
    await actions(page, id).click()
    await menu(page).getByRole("menuitem", { name: add ? "Ajouter aux favoris" : "Retirer des favoris" }).click()
    await (add ? row(page, id).locator(".session-item-favorite").first().waitFor()
      : row(page, id).locator(".session-item-favorite").first().waitFor({ state: "detached" }))
  }
  const chooseFavoriteWithKeyboard = async (page: Page, id: string, add = true) => {
    await actions(page, id).focus()
    await page.keyboard.press("Enter")
    await menu(page).getByRole("menuitem", { name: add ? "Ajouter aux favoris" : "Retirer des favoris" }).waitFor()
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-action-key") === "favorite")
    await page.keyboard.press("Enter")
  }
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
    armFixtureNavigationBudget(browser)
    const refused = await app.inject({ method: "PUT", url: `${owner}/ses_foreign`, payload: { favorite: true } })
    assert.equal(refused.statusCode, 403)
    assert.deepEqual((await app.inject({ url: owner })).json(), {})
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" })
    await setup(page)
    const before = await page.evaluate(() => (window as any).favoriteFixture.metadata())
    await page.getByText("Validation budget", { exact: true }).waitFor()
    await row(page, "validation").locator(".session-permission").waitFor()
    assert.equal(await first(page).getAttribute("data-session-id"), "ses_validation")
    await chooseFavoriteWithKeyboard(page, "dossier_56")
    await row(page, "dossier_56").locator(".session-item-favorite").waitFor()
    await page.waitForFunction(() => document.querySelectorAll(".session-item-base")[1]?.getAttribute("data-session-id") === "ses_dossier_56")
    await page.waitForFunction(() => document.activeElement?.closest("[data-session-id]")?.getAttribute("data-session-id") === "ses_dossier_56")
    await chooseFavoriteWithKeyboard(page, "dossier_56", false)
    await row(page, "dossier_56").locator(".session-item-favorite").waitFor({ state: "detached" })
    await page.waitForFunction(() => document.activeElement?.closest("[data-session-id]")?.getAttribute("data-session-id") === "ses_dossier_56")
    await filters(page).click()
    await search(page).fill("briefing")
    await row(page, "briefing").getByRole("button", { name: "Briefing du matin" }).waitFor()
    await row(page, "briefing").getByRole("button", { name: "Briefing du matin" }).focus()
    await page.keyboard.press("Tab")
    assert.equal(await actions(page, "briefing").evaluate(el => el === document.activeElement), true)
    await chooseFavoriteWithKeyboard(page, "briefing")
    await row(page, "briefing").locator(".session-item-favorite").waitFor()
    assert.equal(await actions(page, "briefing").evaluate(el => el === document.activeElement), true)
    await search(page).fill("conseil")
    const sort = page.getByRole("combobox").nth(0), worktree = page.getByRole("combobox").nth(1)
    await worktree.selectOption("/bureau-ventes")
    assert.equal(await hidden(page).count(), 0)
    await worktree.selectOption("/bureau")
    await hidden(page).press("Enter")
    assert.equal(await search(page).inputValue(), "conseil")
    assert.equal(await worktree.inputValue(), "/bureau")
    assert.equal(await search(page).evaluate(el => el === document.activeElement), true)
    await row(page, "conseil").waitFor()
    await selectFavorite(page, "conseil")
    await filters(page).click()
    await row(page, "equipe").locator(".session-item-favorite").waitFor()
    await row(page, "conseil").waitFor()
    assert.ok(await row(page, "conseil").evaluate(el => el.classList.contains("session-item-nested")))
    assert.equal(await first(page).getAttribute("data-session-id"), "ses_validation")
    await row(page, "equipe").locator('button[aria-expanded="true"]').first().click()
    await row(page, "conseil").waitFor({ state: "detached" })

    await filters(page).click()
    await search(page).fill("conseil")
    await row(page, "conseil").waitFor()
    await page.waitForFunction(() => (window as any).favoriteFixture.lists.some((query: any) => query.search === "conseil"))
    assert.equal(await page.locator(".session-item-base").count(), 1)
    await worktree.selectOption("/bureau-ventes")
    await row(page, "conseil").waitFor({ state: "detached" })
    await worktree.selectOption("/bureau")
    await row(page, "conseil").waitFor()
    await page.getByRole("switch").nth(0).uncheck()
    assert.equal(await row(page, "conseil").count(), 1)
    await page.getByRole("switch").nth(1).uncheck()
    await row(page, "conseil").waitFor({ state: "detached" })
    await page.getByRole("button", { name: "Réinitialiser" }).click()
    assert.equal(await search(page).inputValue(), "")
    assert.equal(await sort.inputValue(), "activity")
    await sort.selectOption("name")
    await row(page, "briefing").waitFor()
    assert.equal(await first(page).getAttribute("data-session-id"), "ses_briefing")
    await sort.selectOption("activity")
    assert.equal(await first(page).getAttribute("data-session-id"), "ses_dossier_60")
    assert.deepEqual(await page.evaluate(() => (window as any).favoriteFixture.metadata()), before)
    assert.deepEqual(new SettingsService(cfg, undefined, logger).getOwner("state", "sessionFavorites"),
      settings.getOwner("state", "sessionFavorites"))
    assert.equal((await app.inject({ url: "/api/storage/state/sessionFavorites" })).statusCode, 403)
    assert.equal((await app.inject({ method: "PATCH", url: "/api/storage/state", payload: { sessionFavorites: null } })).statusCode, 403)
    assert.equal(Object.hasOwn((await app.inject({ url: "/api/storage/state" })).json(), "sessionFavorites"), false)
    assert.deepEqual((await app.inject({ url: owner.replace("favorites-workspace", "unrelated") })).json(), {})

    const late = await app.inject({ method: "PUT", url: `${owner}/ses_dossier_01`, payload: { favorite: true } })
    assert.equal(late.statusCode, 200)
    await filters(page).click()
    await row(page, "dossier_01").locator(".session-item-favorite").waitFor()
    await row(page, "equipe").locator('button[aria-expanded="false"]').first().waitFor()
    assert.equal(await row(page, "conseil").count(), 0)
    const reopened = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" })
    await setup(reopened, true)
    await row(reopened, "dossier_01").locator(".session-item-favorite").waitFor()
    assert.ok(await reopened.evaluate(() => (window as any).favoriteFixture.gets.includes("ses_dossier_01")))
    assert.equal(await reopened.evaluate(() => (window as any).favoriteFixture.lists.some((query: any) => query.cursor)), false)
    await reopened.close()

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "dark" })
    await setup(mobile, true)
    assert.equal(Math.round((await mobile.locator("aside").boundingBox())!.width), 320)
    await row(mobile, "briefing").locator(".session-item-favorite").waitFor()
    assert.equal(await actions(mobile, "briefing").count(), 1)
    const target = (await actions(mobile, "briefing").boundingBox())!
    assert.ok(target.width >= 40 && target.height >= 40)
    await actions(mobile, "briefing").tap()
    await menu(mobile).getByRole("menuitem", { name: "Retirer des favoris" }).waitFor()
    assert.equal(await menu(mobile).getByRole("menuitem").count(), 6)
    await menu(mobile).getByRole("menuitem", { name: "Retirer des favoris" }).tap()
    await row(page, "briefing").locator(".session-item-favorite").waitFor({ state: "detached" })
    await page.waitForFunction(() => JSON.stringify((window as any).favoriteFixture.metadata()) === '{"thirdParty":{"verified":"leave alone"}}')
    await filters(page).click()
    await favoritesOnly(page).click()
    await row(page, "briefing").waitFor({ state: "detached" })
    await row(page, "conseil").waitFor()
    await chooseFavoriteWithKeyboard(page, "dossier_01", false)
    await row(page, "dossier_01").waitFor({ state: "detached" })
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-pressed") === "true"
      && document.activeElement.textContent?.trim() === "Favoris uniquement")
    assert.equal((await app.inject({ method: "PUT", url: `${owner}/ses_dossier_01`, payload: { favorite: true } })).statusCode, 200)
    await row(page, "dossier_01").locator(".session-item-favorite").waitFor()
    await page.getByRole("button", { name: "Réinitialiser" }).click()
    await search(page).fill("briefing")
    await selectFavorite(page, "briefing")
    await page.evaluate(() => (window as any).favoriteFixture.automatic())
    assert.deepEqual(await page.evaluate(() => (window as any).favoriteFixture.removes), [])
    await page.evaluate(() => { void (window as any).favoriteFixture.deep() })
    await page.getByRole("button", { name: "Continuer", exact: true }).click()
    await page.waitForFunction(() => (window as any).favoriteFixture.removes.includes("ses_dossier_02"))
    assert.deepEqual(await page.evaluate(() => (window as any).favoriteFixture.removes), ["ses_dossier_02"])
    await actions(page, "briefing").click()
    await menu(page).getByRole("menuitem", { name: "Supprimer la session" }).click()
    await page.getByText("Les favoris concernés seront aussi retirés.").waitFor()
    await page.getByRole("button", { name: "Supprimer", exact: true }).click()
    await row(page, "briefing").waitFor({ state: "detached" })
    assert.deepEqual((await app.inject({ url: owner })).json(), { ses_conseil: ["ses_equipe"], ses_dossier_01: [] })
    await writeFile(cfg.stateYamlPath, "sessionFavorites: [")
    assert.equal((await app.inject({ url: owner })).statusCode, 503)
    assert.equal((await app.inject({ method: "PUT", url: `${owner}/ses_conseil`, payload: { favorite: false } })).statusCode, 503)
  } finally {
    try { await browser?.close() } finally {
      off()
      await events.close()
      await app.close()
      await rm(tmp, { recursive: true, force: true })
    }
  }
})
