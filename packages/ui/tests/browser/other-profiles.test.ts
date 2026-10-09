import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"

let server: ViteDevServer, browser: Browser, origin: string
before(async () => {
  server = await createServer({
    configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), logLevel: "error",
    plugins: [solid(), { name: "other-profiles", configureServer(s) {
      const page = (path: string, script: string) => s.middlewares.use(path, async (_req, res) => {
        res.setHeader("Content-Type", "text/html")
        res.end(await s.transformIndexHtml(path, `<html><body><div id="root" style="height:100vh"></div><script type="module" src="${script}"></script></body></html>`))
      })
      page("/preferences", "/src/main.tsx")
      page("/inline", "/tests/browser/fixtures/other-profiles-inline.tsx")
    } }],
    resolve: { dedupe: ["solid-js"] }, optimizeDeps: { exclude: ["lucide-solid"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  })
  await server.listen()
  origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

interface FixtureProfile { id: string; kind: string; name: string; otherConfiguration: boolean; sizeBytes: number; sizeComplete: boolean; status: string }
const profile = (id: string, name: string, sizeBytes: number, extra: Partial<FixtureProfile> = {}): FixtureProfile =>
  ({ id, kind: id === "default" ? "default" : "scope", name, otherConfiguration: false, sizeBytes, sizeComplete: true, status: "available", ...extra })

const SEVERAL = [
  profile("default", "default", 300_000_000, { status: "in-use" }),
  profile("scope:dev-v2-0123456789abcdef", "dev-v2", 1_500_000_000),
  profile("scope:team-fedcba9876543210", "team", 2_000_000, { otherConfiguration: true }),
]

// Simulates the host: it owns the listing, re-validates IDs and reports per-profile outcomes.
const HOST_SCRIPT = (profiles: FixtureProfile[], outcomes: Record<string, unknown>) => `
  const w = window
  w.profileHost = {
    profiles: ${JSON.stringify(profiles)}, outcomes: ${JSON.stringify(outcomes)}, lists: 0, deletes: [], clientStateCalls: [],
    async list() { w.profileHost.lists += 1; return { profiles: JSON.parse(JSON.stringify(w.profileHost.profiles)) } },
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
  }
`

async function open(kind: "preferences" | "inline", host: "electron" | "tauri" | "web", profiles: FixtureProfile[], outcomes: Record<string, unknown> = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript({ content: `{
    ${HOST_SCRIPT(profiles, outcomes)}
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
    }
    if (${JSON.stringify(host)} === "tauri") {
      w.__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command, args) => {
          if (command === "data_profiles_list_others") return w.profileHost.list()
          if (command === "data_profiles_delete_others") return w.profileHost.remove(args.ids)
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

const row = (page: Page) => page.getByTestId("other-profiles-settings")
const hostState = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).profileHost)))
const dialogText = (page: Page) => page.getByRole("dialog").innerText()

for (const host of ["electron", "tauri"] as const) {
  test(`${host} Preferences hides the row without other profiles`, async () => {
    const { page, errors } = await open("preferences", host, [])
    try {
      await page.waitForFunction(() => (window as any).profileHost.lists === 1)
      await page.waitForTimeout(100)
      assert.equal(await row(page).count(), 0)
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })

  test(`${host} Preferences lists, confirms and deletes other profiles, then refreshes`, async () => {
    const remaining = "C:\\Users\\a\\AppData\\Local\\ai.neuralnomads.codenomad.client-v2\\scopes\\team-fedcba9876543210"
    const { page, errors } = await open("preferences", host, SEVERAL, {
      "scope:team-fedcba9876543210": { outcome: "incomplete", remaining: [remaining] },
    })
    try {
      await row(page).waitFor()
      assert.equal(await page.getByTestId("other-profiles-summary").innerText(), "3 profiles, 1.8 GB")
      await page.getByRole("button", { name: "Delete…" }).click()
      const text = await dialogText(page)
      assert.match(text, /Delete other saved profiles\?/)
      assert.match(text, /• dev-v2 — 1\.5 GB/)
      assert.match(text, /• team \(other configuration\) — 2 MB/)
      assert.match(text, /Open in CodeNomad or in an unknown state, so they will be skipped:\n• default \(in use\)/)
      assert.match(text, /Conversations in OpenCode are not affected\./)
      assert.match(text, /tabs, drafts, window layout and web storage, sign-ins and cache are deleted/)
      await page.getByRole("button", { name: "Delete 2 profiles" }).click()

      await page.getByText("Some profiles were not fully deleted").waitFor()
      const report = await dialogText(page)
      assert.match(report, /Deleted 1 profile\./)
      assert.ok(report.includes(`team (other configuration): still present: ${remaining}`), report)
      const state = await hostState(page)
      assert.deepEqual(state.deletes, [["scope:dev-v2-0123456789abcdef", "scope:team-fedcba9876543210"]], "in-use profiles are never requested")
      await page.waitForFunction(() => (window as any).profileHost.lists === 2)
      await page.getByTestId("other-profiles-summary").getByText("2 profiles, 302 MB").waitFor()
      assert.deepEqual(errors, [])
    } catch (error) {
      console.error({ host, errors, body: (await page.locator("body").innerText()).slice(0, 1200) })
      throw error
    } finally { await page.close() }
  })
}

test("profiles that are all in use are reported, not offered for deletion", async () => {
  const { page, errors } = await open("preferences", "electron", [
    profile("scope:dev-0123456789abcdef", "dev", 10, { status: "in-use" }),
    profile("default", "default", 5, { status: "unknown" }),
  ])
  try {
    await row(page).waitFor()
    await page.getByRole("button", { name: "Delete…" }).click()
    const text = await dialogText(page)
    assert.match(text, /Profiles in use/)
    assert.match(text, /• dev \(in use\)\n• default \(state unknown\)/)
    assert.equal(await page.getByRole("button", { name: /Delete \d/ }).count(), 0)
    assert.deepEqual((await hostState(page)).deletes, [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("inline settings in a desktop window delete through the host and hide the row once none remain", async () => {
  const { page, errors } = await open("inline", "electron", [profile("scope:dev-v2-0123456789abcdef", "dev-v2", 1_234, { sizeComplete: false })])
  try {
    await row(page).waitFor()
    assert.equal(await page.getByTestId("other-profiles-summary").innerText(), "1 profile, at least 1.2 kB")
    await page.getByRole("button", { name: "Refresh other saved profiles" }).click()
    await page.waitForFunction(() => (window as any).profileHost.lists === 2)
    await page.getByRole("button", { name: "Delete…" }).click()
    await page.getByRole("button", { name: "Delete 1 profile" }).click()
    await page.getByText("Deleted 1 profile.").waitFor()
    await page.waitForFunction(() => (window as any).profileHost.lists === 3)
    await row(page).waitFor({ state: "detached" })
    assert.deepEqual((await hostState(page)).deletes, [["scope:dev-v2-0123456789abcdef"]])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a plain browser never shows or queries other profiles", async () => {
  const { page, errors } = await open("inline", "web", SEVERAL)
  try {
    await page.waitForTimeout(200)
    assert.equal(await row(page).count(), 0)
    assert.equal((await hostState(page)).lists, 0)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})
