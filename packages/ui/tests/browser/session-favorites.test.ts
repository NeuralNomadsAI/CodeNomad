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
import { registerSessionCleanupRoute } from "../../../server/src/server/routes/session-cleanup"
import { SessionCleanupFence } from "../../../server/src/server/session-cleanup-fence"
import { WorktreeDeletionFence } from "../../../server/src/workspaces/worktree-session-evacuation"
import { registerSettingsRoutes } from "../../../server/src/server/routes/settings"
import { borrowFixture } from "./fixture-borrow"
import { fixtureEventStream } from "./fixture-event-stream"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

const row = (page: Page, id: string) => page.locator(`[data-session-id="ses_${id}"]`)
const actions = (page: Page, id: string) => row(page, id).getByRole("button", { name: "Plus d'actions" })
const inlineFavorite = (page: Page, id: string) => row(page, id).locator(".session-item-inline-actions [data-action-key=favorite]")
const favoriteRow = (page: Page, id: string) => page.locator(`[data-session-id="ses_${id}"][data-favorite="true"]`)
const resizeSidebar = (page: Page, width: number) => page.locator("aside").evaluate((panel, px) => {
  panel.style.flexBasis = `${px}px`
}, width)
const menu = (page: Page) => page.getByRole("menu")
const first = (page: Page) => page.locator(".session-item-base").first()
const focusedInView = (page: Page, id: string, selector: string) => page.waitForFunction(({ id, selector }) => {
  const focused = document.activeElement
  if (!focused?.matches(`[data-session-id="ses_${id}"] ${selector}`)) return false
  const bounds = focused.closest(".session-item-base")!.getBoundingClientRect()
  const list = focused.closest(".session-list")!.getBoundingClientRect()
  return bounds.top >= list.top && bounds.bottom <= list.bottom
}, { id, selector }, { timeout: 5_000 })
const star = ".session-item-inline-actions [data-action-key='favorite']"
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
  const removed: string[] = []
  let holdRemoval: (() => Promise<void>) | undefined
  const serverSession = (sessionID: string) => ({ id: sessionID, projectID: "bureau", time: { created: 1, updated: 1 }, parentID: ["ses_conseil", "ses_conseil_notes"].includes(sessionID) ? "ses_equipe" : undefined,
    location: { directory: sessionID === "ses_foreign" ? "/unrelated" : sessionID === "ses_dossier_01" ? "/bureau/ventes-alias" : "/bureau" },
    metadata: { thirdParty: { verified: "leave alone" } } })
  const settings = new SettingsService(cfg, bus, logger)
  registerSettingsRoutes(app, { settings, logger })
  const connection = { assertCurrent() {}, client: {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => serverSession(sessionID),
      update: async () => assert.fail("must not change third-party metadata"),
      list: async () => ({ data: [], cursor: {} }),
      inbox: { list: async () => [] }, active: async () => ({}),
      form: { list: async () => [] },
      remove: async ({ sessionID }: { sessionID: string }) => { await holdRemoval?.(); removed.push(sessionID) },
    },
    message: { list: async ({ sessionID }: { sessionID: string }) =>
      ({ data: sessionID === "ses_dossier_02" ? [] : [{ type: "user" }], cursor: {} }) },
    permission: { request: { list: async ({ location }: { location: { directory: string } }) => ({ location, data: [] }) } },
  } }
  const workspaceManager = {
    get: (id: string) => id === "favorites-workspace" || id === "other-window" ? main : id === "unrelated" ? unrelated : undefined,
    getSharedServiceConnection: async () => connection,
    getExistingSharedServiceConnection: () => connection,
    getWorktreeIdentityForPath: async () => "/bureau",
    ownsLocation: async (id: string, location: { directory: string }) =>
      id !== "unrelated" && ["/bureau", "/bureau/ventes-alias"].includes(location.directory),
  } as any
  const cleanup = new SessionCleanupFence()
  const isProtected = registerSessionFavoritesRoutes(app, { settings, eventBus: bus, workspaceManager, cleanup })
  registerSessionCleanupRoute(app, { workspaceManager, isProtected, cleanup, worktreeDeletionFence: new WorktreeDeletionFence() })
  let failRefresh = false
  let holdFavorite: ((pathname: string) => Promise<void>) | undefined
  const setup = async (page: Page, duplicate = false) => {
    await page.route("**/api/**", route => route.fulfill({ json: {} }))
    await events.route(page)
    await page.route(/\/api\/workspaces\/[^/]+\/session-(?:favorites|cleanup)(?:\/|[?]|$)/, async route => {
      const url = new URL(route.request().url())
      let pathname = url.pathname + url.search
      if (failRefresh && pathname.includes("session-favorites") && route.request().method() === "GET") {
        await route.fulfill({ status: 503 })
        return
      }
      if (duplicate) pathname = pathname.replace("favorites-workspace", "other-window")
      if (route.request().method() === "PUT") await holdFavorite?.(pathname)
      const response = await app.inject({ method: route.request().method() as "GET" | "PUT" | "POST", url: pathname,
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
    await row(page, id).hover()
    await actions(page, id).click()
    await menu(page).getByRole("menuitem", { name: add ? "Ajouter aux favoris" : "Retirer des favoris" }).click()
    await favoriteRow(page, id).waitFor({ state: add ? "visible" : "detached" })
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
    assert.deepEqual((await app.inject({ url: owner })).json().records, {})
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" })
    await setup(page)
    const before = await page.evaluate(() => (window as any).favoriteFixture.metadata())
    await page.getByText("Validation budget", { exact: true }).waitFor()
    await row(page, "validation").locator(".session-permission").waitFor()
    assert.equal(await first(page).getAttribute("data-session-id"), "ses_validation")
    const viewport = page.viewportSize()
    await resizeSidebar(page, 520)
    const wideRow = row(page, "dossier_56")
    await page.mouse.move(800, 500)
    await inlineFavorite(page, "dossier_56").waitFor()
    const strip = wideRow.locator(".session-item-actions")
    assert.equal(await strip.evaluate(el => getComputedStyle(el).opacity), "0")
    await wideRow.hover()
    assert.equal(await strip.evaluate(el => getComputedStyle(el).opacity), "1")
    assert.equal(await inlineFavorite(page, "dossier_56").getAttribute("aria-label"), "Ajouter aux favoris")
    assert.equal(await inlineFavorite(page, "dossier_56").locator("svg").getAttribute("fill"), "none")
    assert.equal(await wideRow.locator(".session-item-inline-actions button").count(), 6)
    assert.equal(await actions(page, "dossier_56").count(), 0)
    await row(page, "validation").locator(".session-permission").waitFor()
    failRefresh = true
    await page.mouse.move(800, 500)
    await wideRow.locator(".session-item-select").focus()
    await page.keyboard.press("Tab")
    assert.equal(await inlineFavorite(page, "dossier_56").evaluate(el => el === document.activeElement), true)
    await page.keyboard.press("Enter")
    await favoriteRow(page, "dossier_56").waitFor()
    await page.waitForFunction(() => document.querySelectorAll(".session-item-base")[1]?.getAttribute("data-session-id") === "ses_dossier_56")
    await page.waitForFunction(() => document.activeElement?.matches('[data-session-id="ses_dossier_56"] [data-action-key="favorite"]'))
    assert.equal(await inlineFavorite(page, "dossier_56").getAttribute("aria-label"), "Retirer des favoris")
    await page.getByRole("button", { name: "Bureau", exact: true }).focus()
    assert.equal(await wideRow.locator("svg.lucide-star").count(), 1)
    assert.equal(await inlineFavorite(page, "dossier_56").locator("svg").getAttribute("fill"), "currentColor")
    assert.equal(await inlineFavorite(page, "dossier_56").evaluate(el => getComputedStyle(el).opacity), "1")
    await page.waitForFunction(() => {
      const rename = document.querySelector('[data-session-id="ses_dossier_56"] .session-item-inline-actions [data-action-key="rename"]')
      return rename && getComputedStyle(rename).opacity === "0"
    })
    await inlineFavorite(page, "dossier_56").focus()
    await resizeSidebar(page, 200)
    await actions(page, "dossier_56").waitFor()
    await wideRow.locator(".session-item-favorite").waitFor()
    await page.waitForFunction(() => document.activeElement?.matches('[data-session-id="ses_dossier_56"] .action-overflow-trigger'))
    for (let run = 0; run < 6; run++) {
      await resizeSidebar(page, 200)
      await actions(page, "dossier_56").press("Enter")
      await menu(page).getByRole("menuitem", { name: "Retirer des favoris" }).waitFor()
      await page.waitForFunction(() => !!document.activeElement?.closest('[role="menu"]'))
      await resizeSidebar(page, 520)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await page.keyboard.press("Escape")
      await menu(page).waitFor({ state: "detached" })
      await focusedInView(page, "dossier_56", star)
    }
    assert.deepEqual(page.viewportSize(), viewport)
    await resizeSidebar(page, 200)
    await page.evaluate(() => (window as any).favoriteFixture.navigate("session-next", "ses_validation"))
    await page.waitForFunction(() => (window as any).favoriteFixture.selected() === "ses_dossier_56")
    await page.getByRole("button", { name: "Bureau", exact: true }).click()
    await row(page, "dossier_56").waitFor({ state: "detached" })
    await page.evaluate(() => (window as any).favoriteFixture.navigate("session-next", "ses_validation"))
    assert.equal(await page.evaluate(() => (window as any).favoriteFixture.selected()), "ses_dossier_56")
    await page.getByRole("button", { name: "Bureau", exact: true }).click()
    await favoriteRow(page, "dossier_56").waitFor()
    await resizeSidebar(page, 200)
    failRefresh = false
    const refreshed = page.waitForResponse(response => response.ok() && response.url().includes("/session-favorites")
      && response.request().method() === "GET")
    events.send({ type: "storage.stateChanged", owner: "sessionFavorites", value: {} })
    await refreshed
    await page.locator("aside").evaluate(panel => { panel.style.height = "180px" })
    const resizeDuringFavorite = async (id: string, add: boolean, moveFocus = false) => {
      const putReceived = Promise.withResolvers<string>(), releasePut = Promise.withResolvers<void>()
      holdFavorite = async pathname => {
        putReceived.resolve(pathname)
        await releasePut.promise
      }
      const direct = inlineFavorite(page, id), compact = actions(page, id)
      const start = add ? direct : compact, end = add ? compact : direct
      const selector = add ? ".action-overflow-trigger" : star
      try {
        if (add) await direct.press("Enter")
        else await chooseFavoriteWithKeyboard(page, id, false)
        assert.equal(await putReceived.promise, `${owner}/ses_${id}`)
        assert.equal(await start.evaluate(el => el === document.activeElement), true)
        await resizeSidebar(page, add ? 200 : 520)
        await end.waitFor()
        await focusedInView(page, id, selector)
        if (moveFocus) {
          const outside = page.getByRole("button", { name: "Bureau", exact: true })
          await outside.focus()
          await outside.blur()
        }
      } finally {
        holdFavorite = undefined
        releasePut.resolve()
      }
      await favoriteRow(page, id).waitFor({ state: add ? "visible" : "detached" })
      if (moveFocus) {
        assert.equal(await page.evaluate(() => document.activeElement?.tagName), "BODY")
        return
      }
      await focusedInView(page, id, selector)
    }
    await resizeDuringFavorite("dossier_56", false)
    await resizeSidebar(page, 200)
    assert.equal((await app.inject({ method: "PUT", url: `${owner}/ses_dossier_04`, payload: { favorite: true } })).statusCode, 200)
    await favoriteRow(page, "dossier_04").waitFor()
    for (let run = 0; run < 4; run++) {
      await resizeDuringFavorite("dossier_04", false)
      await resizeDuringFavorite("dossier_04", true)
    }
    await resizeDuringFavorite("dossier_04", false, true)
    await page.locator("aside").evaluate(panel => { panel.style.height = "" })
    await resizeSidebar(page, 200)
    await filters(page).click()
    await search(page).fill("projet secret")
    await row(page, "search_only").waitFor()
    await filters(page).click()
    assert.equal(await row(page, "search_only").count(), 0)
    await filters(page).click()
    await selectFavorite(page, "search_only")
    await filters(page).click()
    await favoriteRow(page, "search_only").waitFor()
    assert.equal(await page.evaluate(() => (window as any).favoriteFixture.gets.includes("ses_search_only")), false)
    await selectFavorite(page, "search_only", false)
    await filters(page).click()
    await search(page).fill("briefing")
    await row(page, "briefing").getByRole("button", { name: "Briefing du matin" }).waitFor()
    await row(page, "briefing").getByRole("button", { name: "Briefing du matin" }).focus()
    await page.keyboard.press("Tab")
    assert.equal(await actions(page, "briefing").evaluate(el => el === document.activeElement), true)
    await chooseFavoriteWithKeyboard(page, "briefing")
    await favoriteRow(page, "briefing").waitFor()
    assert.equal(await actions(page, "briefing").evaluate(el => el === document.activeElement), true)
    await search(page).fill("préparer conseil")
    const sort = page.getByRole("combobox").nth(0), worktree = page.getByRole("combobox").nth(1)
    await worktree.selectOption("/bureau-ventes")
    assert.equal(await hidden(page).count(), 0)
    await worktree.selectOption("/bureau")
    await hidden(page).press("Enter")
    assert.equal(await search(page).inputValue(), "préparer conseil")
    assert.equal(await worktree.inputValue(), "/bureau")
    assert.equal(await search(page).evaluate(el => el === document.activeElement), true)
    await row(page, "conseil").waitFor()
    await filters(page).click()
    const rootOrder = () => page.locator(".session-item-base:not(.session-item-nested)")
      .evaluateAll(rows => rows.slice(0, 6).map(el => el.getAttribute("data-session-id")))
    const rootsBefore = await rootOrder()
    assert.ok(rootsBefore.indexOf("ses_dossier_60") < rootsBefore.indexOf("ses_equipe"))
    await filters(page).click()
    await selectFavorite(page, "conseil")
    await filters(page).click()
    const expander = row(page, "equipe").locator("button.session-item-expander")
    assert.equal(await expander.getAttribute("aria-expanded"), "false")
    assert.equal(await row(page, "conseil").count(), 0)
    assert.deepEqual(await rootOrder(), rootsBefore)
    assert.equal(await favoriteRow(page, "equipe").count(), 0)
    assert.equal(await row(page, "equipe").locator(".session-item-badges svg, .session-item-favorite").count(), 0)
    assert.equal(await row(page, "equipe").locator(".session-item-select").getAttribute("aria-description"), null)
    await expander.click()
    await row(page, "conseil").waitFor()
    const siblingOrder = () => page.locator('.session-item-base[data-session-id^="ses_conseil"]').evaluateAll(rows => rows.map(el => el.getAttribute("data-session-id")))
    assert.deepEqual(await siblingOrder(), ["ses_conseil", "ses_conseil_notes"])
    assert.deepEqual(await rootOrder(), rootsBefore)
    assert.ok(await row(page, "conseil").evaluate(el => el.classList.contains("session-item-nested")))
    assert.equal(await first(page).getAttribute("data-session-id"), "ses_validation")
    await actions(page, "conseil").waitFor()
    await resizeSidebar(page, 520)
    await row(page, "conseil").hover()
    await inlineFavorite(page, "conseil").waitFor()
    assert.equal(await actions(page, "conseil").count(), 0)
    await inlineFavorite(page, "conseil").click()
    await favoriteRow(page, "conseil").waitFor({ state: "detached" })
    assert.deepEqual(await siblingOrder(), ["ses_conseil_notes", "ses_conseil"])
    assert.ok(await row(page, "briefing").getAttribute("data-favorite"))
    await inlineFavorite(page, "conseil").click()
    await favoriteRow(page, "conseil").waitFor()
    assert.deepEqual(await siblingOrder(), ["ses_conseil", "ses_conseil_notes"])
    assert.deepEqual(await rootOrder(), rootsBefore)
    await resizeSidebar(page, 200)
    await actions(page, "conseil").waitFor()
    assert.deepEqual(page.viewportSize(), viewport)
    await expander.click()
    await row(page, "conseil").waitFor({ state: "detached" })

    await filters(page).click()
    await search(page).fill("conseil")
    await row(page, "conseil").waitFor()
    await page.waitForFunction(() => (window as any).favoriteFixture.lists.some((query: any) => query.search === "conseil"))
    await row(page, "conseil_notes").waitFor()
    assert.equal(await row(page, "equipe").count(), 0)
    assert.deepEqual(await siblingOrder(), ["ses_conseil", "ses_conseil_notes"])
    await sort.selectOption("name")
    assert.deepEqual(await siblingOrder(), ["ses_conseil_notes", "ses_conseil"])
    await sort.selectOption("worktree")
    assert.deepEqual(await siblingOrder(), ["ses_conseil_notes", "ses_conseil"])
    await sort.selectOption("activity")
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
    assert.deepEqual((await rootOrder()).slice(0, 3), ["ses_validation", "ses_briefing", "ses_dossier_60"])
    assert.deepEqual(await page.evaluate(() => (window as any).favoriteFixture.metadata()), before)
    assert.deepEqual(new SettingsService(cfg, undefined, logger).getOwner("state", "sessionFavorites"),
      settings.getOwner("state", "sessionFavorites"))
    assert.equal((await app.inject({ url: "/api/storage/state/sessionFavorites" })).statusCode, 403)
    assert.equal((await app.inject({ method: "PATCH", url: "/api/storage/state", payload: { sessionFavorites: null } })).statusCode, 403)
    assert.equal(Object.hasOwn((await app.inject({ url: "/api/storage/state" })).json(), "sessionFavorites"), false)
    assert.deepEqual((await app.inject({ url: owner.replace("favorites-workspace", "unrelated") })).json().records, {})

    const late = await app.inject({ method: "PUT", url: `${owner}/ses_dossier_01`, payload: { favorite: true } })
    assert.equal(late.statusCode, 200)
    await filters(page).click()
    await favoriteRow(page, "dossier_01").waitFor()
    await row(page, "equipe").locator('button[aria-expanded="false"]').first().waitFor()
    assert.equal(await row(page, "conseil").count(), 0)
    const reopened = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" })
    await setup(reopened, true)
    await favoriteRow(reopened, "dossier_01").waitFor()
    assert.ok(await reopened.evaluate(() => (window as any).favoriteFixture.gets.includes("ses_dossier_01")))
    assert.deepEqual(await reopened.evaluate(() => (window as any).favoriteFixture.placement("ses_dossier_01")),
      { location: "/bureau/ventes-alias", slug: "ventes" })
    assert.equal(await reopened.evaluate(() => (window as any).favoriteFixture.lists.some((query: any) => query.cursor)), false)
    await reopened.close()

    const mobile = await browser.newPage({ viewport: { width: 820, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "dark" })
    await setup(mobile, true)
    assert.equal(Math.round((await mobile.locator("aside").boundingBox())!.width), 320)
    await favoriteRow(mobile, "briefing").waitFor()
    await row(mobile, "equipe").locator("button.session-item-expander").tap()
    await resizeSidebar(mobile, 620)
    await inlineFavorite(mobile, "conseil").waitFor()
    const inlineTarget = (await inlineFavorite(mobile, "conseil").boundingBox())!
    assert.ok(inlineTarget.width >= 40 && inlineTarget.height >= 40)
    await inlineFavorite(mobile, "conseil").tap()
    await favoriteRow(mobile, "conseil").waitFor({ state: "detached" })
    await inlineFavorite(mobile, "conseil").tap()
    await favoriteRow(mobile, "conseil").waitFor()
    await resizeSidebar(mobile, 320)
    await actions(mobile, "briefing").waitFor()
    assert.equal(await actions(mobile, "briefing").count(), 1)
    const target = (await actions(mobile, "briefing").boundingBox())!
    assert.ok(target.width >= 40 && target.height >= 40)
    await actions(mobile, "briefing").tap()
    await menu(mobile).getByRole("menuitem", { name: "Retirer des favoris" }).waitFor()
    assert.equal(await menu(mobile).getByRole("menuitem").count(), 6)
    await menu(mobile).getByRole("menuitem", { name: "Retirer des favoris" }).tap()
    await favoriteRow(page, "briefing").waitFor({ state: "detached" })
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
    await favoriteRow(page, "dossier_01").waitFor()
    await page.getByRole("button", { name: "Réinitialiser" }).click()
    await search(page).fill("briefing")
    await selectFavorite(page, "briefing")
    await page.evaluate(() => (window as any).favoriteFixture.automatic())
    assert.deepEqual(removed, [])
    let startRemoval!: () => void, resumeRemoval!: () => void
    const nativeStarted = new Promise<void>(resolve => { startRemoval = resolve })
    const nativeResume = new Promise<void>(resolve => { resumeRemoval = resolve })
    holdRemoval = async () => { startRemoval(); await nativeResume }
    await page.evaluate(() => { void (window as any).favoriteFixture.deep() })
    await page.getByRole("button", { name: "Continuer", exact: true }).click()
    try {
      await nativeStarted
      await page.evaluate(() => (window as any).favoriteFixture.draftDuringCleanup("ses_dossier_02"))
    } finally { resumeRemoval() }
    // The detached initiating request may never receive the 204; the native event is enough.
    await page.evaluate(() => (window as any).favoriteFixture.deleteEvent("ses_dossier_02"))
    const recovered = page.locator("[data-recovered-composer]")
    await recovered.locator("textarea").waitFor()
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("[data-recovered-composer] textarea")?.value === "À relire demain")
    await recovered.getByText("@note.txt", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).favoriteFixture.recoveredBytes()), [[98, 111, 110]])
    await favoriteRow(page, "briefing").waitFor()
    await search(page).fill("Dossier 02")
    await page.waitForFunction(() => !(window as any).favoriteFixture.has("ses_dossier_02"))
    assert.deepEqual(removed, ["ses_dossier_02"])
    holdRemoval = undefined
    await search(page).fill("briefing")
    await row(page, "briefing").hover()
    await actions(page, "briefing").click()
    await menu(page).getByRole("menuitem", { name: "Supprimer la session" }).click()
    await page.getByText("Les favoris concernés seront aussi retirés.").waitFor()
    await page.getByRole("button", { name: "Supprimer", exact: true }).click()
    await row(page, "briefing").waitFor({ state: "detached" })
    assert.deepEqual((await app.inject({ url: owner })).json().records, { ses_conseil: [], ses_dossier_01: [] })
    for (const mode of ["direct", "point-read", "early-deletion", "closed-tab"] as const) {
      const draftPage = await browser.newPage({ viewport: { width: 1280, height: 800 } })
      try {
        await setup(draftPage)
        await draftPage.evaluate(async mode => {
          const f = (window as any).favoriteFixture
          f.prepareDrafts(mode === "direct")
          if (mode === "early-deletion") f.restoreWithEarlyDeletion()
          if (mode === "closed-tab") {
            f.clearFixtureDraft()
            await f.simulateTabReopen()
          }
          await f.saveDrafts()
        }, mode)
        await draftPage.reload()
        await draftPage.waitForFunction(() => Boolean((window as any).favoriteFixture))
        const composer = draftPage.locator("[data-recovered-composer]")
        const picker = composer.getByRole("combobox", { name: "Changer de brouillon", exact: true })
        const textarea = composer.locator("textarea")
        assert.equal(await textarea.inputValue(), "a".repeat(32000))
        await picker.locator("option").nth(1).waitFor({ state: "attached" })
        assert.equal(await picker.locator("option").count(), 2, mode)
        await composer.getByText("@main.txt", { exact: true }).waitFor()
        assert.deepEqual(await draftPage.evaluate(() => (window as any).favoriteFixture.recoveredBytes()), [[1]])
        const saved = await picker.locator("option").nth(1).getAttribute("value")
        assert.ok(saved)
        await picker.selectOption(saved)
        assert.equal(await textarea.inputValue(), "b".repeat(2000))
        await composer.getByText("@second.txt", { exact: true }).waitFor()
        assert.deepEqual(await draftPage.evaluate(() => (window as any).favoriteFixture.recoveredBytes()), [[2, 3]])
        await draftPage.evaluate(() => (window as any).favoriteFixture.readSaved())
        assert.equal(await picker.locator("option").count(), 2)
        assert.equal(await textarea.inputValue(), "b".repeat(2000))
        await picker.selectOption(saved)
        assert.equal(await textarea.inputValue(), "a".repeat(32000))
        if (mode === "early-deletion" || mode === "closed-tab") {
          await draftPage.evaluate(() => (window as any).favoriteFixture.saveDrafts())
          await draftPage.reload()
          await draftPage.waitForFunction(() => Boolean((window as any).favoriteFixture))
          assert.equal(await textarea.inputValue(), "a".repeat(32000))
          await picker.locator("option").nth(1).waitFor({ state: "attached" })
          assert.equal(await picker.locator("option").count(), 2)
          await picker.selectOption(saved)
          assert.equal(await textarea.inputValue(), "b".repeat(2000))
          assert.deepEqual(await draftPage.evaluate(() => (window as any).favoriteFixture.recoveredBytes()), [[2, 3]])
          await draftPage.evaluate(async () => {
            const f = (window as any).favoriteFixture
            f.clearRecoveredComposer()
            await f.readSaved()
          })
          await picker.selectOption(saved)
          assert.equal(await textarea.inputValue(), "a".repeat(32000))
          assert.equal(await picker.count(), 0)
        }
      } finally { await draftPage.close() }
    }
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
