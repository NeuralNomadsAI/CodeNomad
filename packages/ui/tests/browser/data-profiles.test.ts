import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createFixtureCache } from "./fixture-cache"
import { createFixtureShutdown } from "./fixture-shutdown"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, origin: string
before(async () => {
  const cache = await createFixtureCache(), shutdown = createFixtureShutdown(cache)
  server = await createServer({
    configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error", cacheDir: cache.cacheDir,
    plugins: [shutdown.plugin, solid(), { name: "data-profiles", configureServer(s) {
      const page = (path: string, script: string) => s.middlewares.use(path, async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml(path, `<html><body><div id="root" style="height:100vh"></div><script type="module" src="${script}"></script></body></html>`))
      })
      page("/preferences", "/src/main.tsx")
      page("/inline", "/tests/browser/fixtures/data-profiles-inline.tsx")
    } }],
    resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  shutdown.own(server)
  await server.listen()
  origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close(); await server?.close() })

interface FixtureProfile {
  id: string; kind: string; name: string; otherConfiguration: boolean; sizeBytes: number; sizeComplete: boolean; status: string
  createdAt: number | null; lastUsedAt: number | null
}
const day = (date: number, hours = 0, minutes = 0) => Date.UTC(2026, 9, date, hours, minutes)
const profile = (id: string, name: string, sizeBytes: number, extra: Partial<FixtureProfile> = {}): FixtureProfile => ({
  id, kind: id === "default" ? "default" : id.startsWith("orphan:") ? "orphan" : "scope", name, otherConfiguration: false,
  sizeBytes, sizeComplete: true, status: "available", createdAt: day(1), lastUsedAt: day(2), ...extra,
})

const CURRENT = { name: "dev-v2", sizeBytes: 1_500_000_000, sizeComplete: true, createdAt: day(12), lastUsedAt: day(24, 10, 15) }
const SEVERAL = [
  profile("default", "default", 300_000_000, { status: "in-use", createdAt: day(1), lastUsedAt: day(21, 9) }),
  profile("scope:dev-0123456789abcdef", "dev", 20_000_000, { createdAt: null, lastUsedAt: day(23, 18, 30) }),
  profile("scope:team-fedcba9876543210", "team", 2_000_000, { otherConfiguration: true, lastUsedAt: null }),
]

interface HostOptions { current?: typeof CURRENT; nextLaunch?: string | null; pinned?: boolean; shared?: boolean; outcomes?: Record<string, unknown> }

// Simulates the host: it owns the listing, re-validates IDs and names, reports per-profile
// outcomes, remembers the next launch's profile and records restarts.
const HOST_SCRIPT = (profiles: FixtureProfile[], options: HostOptions) => `
  const w = window
  w.profileHost = {
    current: ${JSON.stringify(options.current ?? CURRENT)}, profiles: ${JSON.stringify(profiles)},
    nextLaunch: ${JSON.stringify(options.nextLaunch ?? null)}, pinned: ${options.pinned ?? false}, shared: ${options.shared ?? false},
    outcomes: ${JSON.stringify(options.outcomes ?? {})}, lists: 0, deletes: [], choices: [], relaunches: 0,
    async list() {
      const host = w.profileHost
      host.lists += 1
      return JSON.parse(JSON.stringify({ current: host.current, profiles: host.profiles, nextLaunch: host.nextLaunch, pinned: host.pinned, sharedWebKitStorage: host.shared }))
    },
    async remove(ids) {
      const host = w.profileHost
      host.deletes.push(ids)
      const results = ids.map(id => {
        const known = host.profiles.find(entry => entry.id === id)
        const outcome = host.outcomes[id] ?? { outcome: "deleted", remaining: [], kept: [] }
        if (outcome.outcome === "deleted") host.profiles = host.profiles.filter(entry => entry.id !== id)
        return { id, name: known ? known.name : id, remaining: [], kept: [], ...outcome }
      })
      return { results, choices: "unchanged" }
    },
    async setNext(name) {
      const host = w.profileHost
      host.choices.push(name)
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) return { outcome: "invalid" }
      const known = name === host.current.name || host.profiles.some(entry => entry.name === name && !entry.otherConfiguration)
      if (!known) host.profiles.push({ id: "scope:" + name + "-00000000000000aa", kind: "scope", name, otherConfiguration: false, sizeBytes: 0, sizeComplete: true, status: "available", createdAt: ${day(24, 11)}, lastUsedAt: null })
      host.nextLaunch = name
      return { outcome: "updated" }
    },
    async relaunch() { w.profileHost.relaunches += 1 },
  }
`

async function open(kind: "preferences" | "inline", host: "electron" | "tauri" | "web", profiles: FixtureProfile[], options: HostOptions = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, locale: "en-US", timezoneId: "UTC" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: `{
    ${HOST_SCRIPT(profiles, options)}
    if (${JSON.stringify(host)} !== "web") {
      w.__CODENOMAD_RUNTIME_HOST__ = ${JSON.stringify(host)}
      w.__CODENOMAD_WINDOW_CONTEXT__ = ${JSON.stringify(kind === "preferences" ? "preferences" : "local")}
    }
    const clientState = {
      claimClientStateAccess: async () => true,
      loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: null }),
      saveClientState: async () => true, setClientStateRestoreEnabled: async () => true, clearClientState: async () => true,
    }
    if (${JSON.stringify(host)} === "electron") w.electronAPI = {
      ...(${JSON.stringify(kind)} === "inline" ? clientState : {}),
      getPreferencesRequest: async () => ({ section: "general" }),
      acceptPreferencesRequest: async () => {},
      preferencesReady: async () => { w.fixtureReady = true },
      onPreferencesSection: () => () => {},
      onPreferencesCloseRequested: () => () => {},
      onPreferencesTransitionRequested: () => () => {},
      openerStartupState: async () => ({ epoch: 1, state: { isPrimary: true, restoreEnabled: true }, applied: false }),
      listOtherDataProfiles: () => w.profileHost.list(),
      deleteOtherDataProfiles: ids => w.profileHost.remove(ids),
      setNextLaunchDataProfile: name => w.profileHost.setNext(name),
      relaunchIntoNextDataProfile: () => w.profileHost.relaunch(),
    }
    if (${JSON.stringify(host)} === "tauri") {
      w.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
          if (command === "data_profiles_list_others") return w.profileHost.list()
          if (command === "data_profiles_delete_others") return w.profileHost.remove(args.ids)
          if (command === "data_profiles_set_next_launch") return w.profileHost.setNext(args.name)
          if (command === "data_profiles_relaunch") return w.profileHost.relaunch()
          if (command === "preferences_opener_startup_state") return { epoch: 1, state: { isPrimary: true, restoreEnabled: true }, applied: false }
          if (command === "preferences_get_request") return { section: "general" }
          if (command === "preferences_window_ready") w.fixtureReady = true
          return 1
        },
      }
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    }
  }` })
  await page.route("**/api/**", route => new URL(route.request().url()).pathname.startsWith("/api/")
    ? route.fulfill({ json: new URL(route.request().url()).pathname === "/api/storage/config/ui" ? { settings: { locale: "en" } } : {} })
    : route.continue())
  if (kind === "preferences") {
    await page.goto(`${origin}/preferences?preferences=general`)
    await page.waitForFunction(() => (window as any).fixtureReady)
  } else {
    await page.goto(`${origin}/inline`)
    await page.waitForFunction(() => (window as any).fixtureRendered)
  }
  await page.getByTestId("startup-state-settings").waitFor()
  return { page, errors }
}

const manager = (page: Page) => page.getByTestId("data-profiles-settings")
const entries = (page: Page) => page.getByTestId("data-profile-entry")
const hostState = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).profileHost)))
const dialogText = (page: Page) => page.getByRole("dialog").innerText()
async function unfold(page: Page) {
  await manager(page).waitFor()
  await manager(page).locator("summary").click()
  await entries(page).first().waitFor()
}

for (const host of ["electron", "tauri"] as const) {
  test(`${host} Preferences folds every profile under the open one, with size, creation and last use`, async () => {
    const { page, errors } = await open("preferences", host, SEVERAL)
    try {
      await manager(page).waitFor()
      assert.equal(await manager(page).locator("summary").innerText(), "Data profile: dev-v2")
      assert.equal(await manager(page).evaluate(details => (details as HTMLDetailsElement).open), false, "folded until asked")
      assert.equal(await entries(page).first().isVisible(), false)
      const [clearBox, managerBox] = await Promise.all([
        page.getByRole("button", { name: "Clear saved startup state", exact: true }).boundingBox(),
        manager(page).boundingBox(),
      ])
      assert.ok(managerBox!.y - (clearBox!.y + clearBox!.height) >= 4, "the clear button keeps off the separator")
      await unfold(page)
      // The open profile first, then the others by last use.
      assert.deepEqual(await entries(page).allInnerTexts(), [
        "dev-v2open\n1.5 GB · created Oct 12, 2026 · last used Oct 24, 2026, 10:15 AM",
        "dev\n20 MB · last used Oct 23, 2026, 6:30 PM",
        "Default\n300 MB · created Oct 1, 2026 · last used Oct 21, 2026, 9:00 AM",
        "team (other configuration)\n2 MB · created Oct 1, 2026 · never used",
      ])
      const radios = entries(page).locator("input[type=radio]")
      assert.deepEqual(await radios.evaluateAll(inputs => inputs.map(input => [(input as HTMLInputElement).checked, (input as HTMLInputElement).disabled])),
        [[true, false], [false, false], [false, false], [false, true]], "the open profile is the next launch's; other configurations cannot be chosen")
      // The open profile cannot be deleted, an open one neither.
      assert.equal(await entries(page).nth(0).getByRole("button").count(), 0)
      assert.equal(await entries(page).nth(2).getByRole("button", { name: "Delete Default" }).isDisabled(), true)
      assert.equal(await page.getByRole("button", { name: /^Restart in/ }).count(), 0)
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })

  test(`${host} Preferences chooses a profile for the next launch and restarts into it`, async () => {
    const { page, errors } = await open("preferences", host, SEVERAL)
    try {
      await unfold(page)
      await entries(page).nth(2).getByRole("radio").check()
      await page.getByRole("button", { name: "Restart in Default", exact: true }).waitFor()
      assert.match(await entries(page).nth(2).innerText(), /^Defaultnext launch/)
      assert.deepEqual((await hostState(page)).choices, ["default"])
      await page.getByRole("button", { name: "Restart in Default", exact: true }).click()
      await page.waitForFunction(() => (window as any).profileHost.relaunches === 1)
      // Choosing the open profile again cancels.
      await entries(page).nth(0).getByRole("radio").check()
      await page.getByRole("button", { name: /^Restart in/ }).waitFor({ state: "detached" })
      assert.deepEqual((await hostState(page)).choices, ["default", "dev-v2"])
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
}

test("a folder the alias made under another profile's name is listed but cannot be chosen", async () => {
  const alias = profile("scope:default-0011223344556677", "default", 5_000_000, { lastUsedAt: day(22) })
  const { page, errors } = await open("preferences", "electron", [...SEVERAL, alias])
  try {
    await unfold(page)
    const aliasEntry = entries(page).filter({ has: page.locator('input[data-key="scope:default-0011223344556677"]') })
    assert.match(await aliasEntry.innerText(), /^default\n5 MB/, "named as stored, never as the default profile")
    assert.equal(await aliasEntry.getByRole("radio").isDisabled(), true, "\"default\" would open the default profile instead")
    assert.equal(await entries(page).filter({ has: page.locator('input[data-key="default"]') }).getByRole("radio").isDisabled(), false)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a restart follows another window's later choice instead of the stale one", async () => {
  const { page, errors } = await open("preferences", "tauri", SEVERAL)
  try {
    await unfold(page)
    await entries(page).nth(2).getByRole("radio").check()
    const stale = page.getByRole("button", { name: "Restart in Default", exact: true })
    await stale.waitFor()
    await page.evaluate(() => { (window as any).profileHost.nextLaunch = "dev" })
    await stale.click()
    await page.getByRole("button", { name: "Restart in dev", exact: true }).waitFor()
    assert.equal((await hostState(page)).relaunches, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("choosing with the keyboard keeps focus on the chosen profile", async () => {
  const { page, errors } = await open("preferences", "electron", SEVERAL)
  try {
    await unfold(page)
    await entries(page).nth(1).getByRole("radio").focus()
    await page.keyboard.press("Space")
    await page.getByRole("button", { name: "Restart in dev", exact: true }).waitFor()
    await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset.key === "scope:dev-0123456789abcdef")
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a new profile needs a valid name and becomes the next launch's", async () => {
  const { page, errors } = await open("preferences", "electron", SEVERAL)
  try {
    await unfold(page)
    await page.getByRole("button", { name: "New profile", exact: true }).click()
    const name = page.getByRole("textbox", { name: "Profile name" })
    await name.fill("QA team")
    await page.getByRole("button", { name: "Create", exact: true }).click()
    await page.getByRole("alert").getByText(/^Use 1 to 64 lowercase letters/).waitFor()
    assert.deepEqual((await hostState(page)).choices, [], "an invalid name never reaches the host")
    await name.fill("  QA.Team ")
    await page.getByRole("button", { name: "Create", exact: true }).click()
    await page.getByRole("button", { name: "Restart in qa.team", exact: true }).waitFor()
    assert.deepEqual((await hostState(page)).choices, ["qa.team"])
    assert.match(await entries(page).filter({ hasText: "qa.team" }).innerText(), /^qa\.teamnext launch\n0 byte · created Oct 24, 2026 · never used$/)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("deleting a profile asks first and deletes only that one", async () => {
  const remaining = "C:\\Users\\a\\AppData\\Local\\ai.neuralnomads.codenomad.client-v2\\scopes\\dev-0123456789abcdef"
  const { page, errors } = await open("preferences", "tauri", SEVERAL, { outcomes: { "scope:dev-0123456789abcdef": { outcome: "incomplete", remaining: [remaining] } } })
  try {
    await unfold(page)
    await page.getByRole("button", { name: "Delete dev", exact: true }).click()
    const text = await dialogText(page)
    assert.match(text, /Delete the profile dev\?/)
    assert.match(text, /dev — 20 MB/)
    assert.match(text, /Conversations in OpenCode are not affected\./)
    await page.getByRole("button", { name: "Delete profile", exact: true }).click()
    await page.getByText("Some profiles were not fully deleted").waitFor()
    assert.ok((await dialogText(page)).includes(`dev: still present: ${remaining}`))
    assert.deepEqual((await hostState(page)).deletes, [["scope:dev-0123456789abcdef"]])
    await page.waitForFunction(() => (window as any).profileHost.lists === 2)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("on macOS the confirmation says Tauri's shared WebKit storage is kept", async () => {
  const { page, errors } = await open("preferences", "tauri", SEVERAL, { shared: true })
  try {
    await unfold(page)
    await page.getByRole("button", { name: "Delete dev", exact: true }).click()
    const text = await dialogText(page)
    assert.match(text, /On macOS, web storage, sign-ins and cache that the Tauri app keeps in the system WebKit store are shared by all profiles and are not deleted\./)
    await page.getByRole("button", { name: "Cancel" }).click()
    assert.deepEqual((await hostState(page)).deletes, [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a launch pinned by CODENOMAD_PROFILE shows the profiles without choosing one", async () => {
  const { page, errors } = await open("inline", "electron", SEVERAL, { pinned: true })
  try {
    await unfold(page)
    await page.getByText("CODENOMAD_PROFILE or a development run sets the profile of every launch.").waitFor()
    assert.ok(await entries(page).locator("input[type=radio]").evaluateAll(inputs => inputs.every(input => (input as HTMLInputElement).disabled)))
    assert.equal(await page.getByRole("button", { name: "New profile", exact: true }).isDisabled(), true)
    // Deleting the others still works.
    assert.equal(await page.getByRole("button", { name: "Delete dev", exact: true }).isDisabled(), false)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a plain browser never shows or queries profiles", async () => {
  const { page, errors } = await open("inline", "web", SEVERAL)
  try {
    await page.waitForTimeout(200)
    assert.equal(await manager(page).count(), 0)
    assert.equal((await hostState(page)).lists, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
