import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { YamlDocStore } from "../../../server/src/settings/yaml-doc-store"
import { applyMergePatch } from "../../../server/src/settings/merge-patch"
import { backends, createBackendClient, localBackend, type BackendClient } from "../lib/backend-client"
import { backendEvents } from "../lib/backend-events"

type Wire = { url: string; method: string; body?: BodyInit | null; credentials?: RequestCredentials }
type Bucket = Record<string, any>

function fixture(config: Bucket = {}, state: Bucket = {}) {
  const calls: Wire[] = [], instances = new Map<string, Bucket>()
  let wait: Promise<void> | undefined
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "http://local.invalid")
    const method = init?.method ?? "GET"
    calls.push({ url: String(input), method, body: init?.body, credentials: init?.credentials })
    await wait
    const [, , , family, rawOwner] = url.pathname.split("/")
    const owner = decodeURIComponent(rawOwner)
    const document = family === "config" ? config : state
    if (family === "instances") {
      if (method === "PUT") instances.set(owner, JSON.parse(String(init?.body)))
      return Response.json(instances.get(owner) ?? { messageHistory: [], agentModelSelections: {} })
    }
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body))
      document[owner] = applyMergePatch(document[owner], url.search ? body.patch : body)
    }
    return Response.json(document[owner] ?? {})
  }
  return { calls, config, state, fetcher, instances, hold: (promise?: Promise<void>) => { wait = promise } }
}

test("real preference consumers isolate host, server, fallback, instance data and revoked attachments", async t => {
  const originalFetch = globalThis.fetch
  const root = mkdtempSync(join(tmpdir(), "codenomad-preferences-"))
  const file = join(root, "config.yaml")
  // A pre-existing on-disk document, including fields unknown to this UI.
  const original = "ui:\n  settings:\n    locale: fr\n    missionProfileDefaults: []\n    missionModels: []\n    modelVisibility:\n      p:\n        hiddenModelIds: [hidden]\n  untouched: { value: keep }\nserver:\n  opencodeBinary: /tools/opencode2\n  logLevel: WARN\nfutureOwner: { keep: true }\n"
  writeFileSync(file, original)
  const disk = new YamlDocStore(file, { warn() {} } as any)
  const host = fixture(disk.get(), { ui: { recentFolders: [{ path: "/host", lastAccessed: 1 }],
    models: { recents: [{ providerId: "p", modelId: "host" }], favorites: [{ providerId: "p", modelId: "host" }] },
    untouchedState: { keep: true } } })
  globalThis.fetch = host.fetcher
  const registry = backends as Map<string, BackendClient>
  const registered: BackendClient[] = []
  const attach = (id: string, data: ReturnType<typeof fixture>) => {
    const backend = createBackendClient({ id, baseUrl: `https://${id}.invalid`, fetcher: data.fetcher })
    registry.set(id, backend); registered.push(backend)
    const detach = backendEvents.attach(id, backend.events)
    return { backend, detach }
  }
  t.after(() => {
    for (const backend of registered) { backend.events.dispose(); registry.delete(backend.id) }
    localBackend.events.dispose()
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  })
  const module = await import("./preferences")
  const hostPrefs = module.preferencesForBackend("local")
  await hostPrefs.ensureLoaded()
  const a = fixture({ ui: { settings: { missionProfileDefaults: [], missionModels: [] } }, server: { logLevel: "INFO" } },
    { ui: { recentFolders: [{ path: "/a", lastAccessed: 2 }], models: { favorites: [] } } })
  const b = fixture({ server: { logLevel: "ERROR" } }, { ui: { recentFolders: [{ path: "/b", lastAccessed: 3 }] } })
  const ownerA = attach("prefsA", a), ownerB = attach("prefsB", b)
  const prefsA = module.preferencesForBackend("prefsA"), prefsB = module.preferencesForBackend("prefsB")
  await Promise.all([prefsA.ensureLoaded(), prefsB.ensureLoaded()])

  await t.test("host presentation has one owner; existing local documents retain bytes and unknown fields", async () => {
    assert.equal(readFileSync(file, "utf8"), original, "loading never migrates the file")
    assert.equal(prefsA.preferences().locale, "fr")
    assert.equal(prefsB.preferences().locale, "fr")
    const before = host.calls.length
    assert.equal(await prefsA.updatePreferences({ locale: "de" }), true)
    assert.deepEqual(host.calls.slice(before), [{ url: "/api/storage/config/ui", method: "PATCH",
      body: '{"settings":{"locale":"de"}}', credentials: "include" }])
    assert.equal(prefsB.preferences().locale, "de")
    assert.equal(a.calls.some(call => call.method === "PATCH"), false)
    assert.equal(b.calls.some(call => call.method === "PATCH"), false)
    disk.replace(host.config)
    assert.equal((new YamlDocStore(file, { warn() {} } as any).get().ui as Bucket).settings.locale, "de")
    assert.deepEqual((disk.get().ui as Bucket).untouched, { value: "keep" })
    assert.deepEqual(disk.get().futureOwner, { keep: true })
    assert.deepEqual(disk.get().server, { opencodeBinary: "/tools/opencode2", logLevel: "WARN" })
  })

  await t.test("server state and server configuration stay with their owner", async () => {
    assert.equal(prefsA.serverSettings().logLevel, "INFO")
    assert.equal(prefsB.serverSettings().logLevel, "ERROR")
    await prefsA.renameRecentFolderProject("/a", "Project A")
    assert.deepEqual(a.state.ui.recentFolders, [{ path: "/a", lastAccessed: 2, projectName: "Project A" }])
    assert.deepEqual(b.state.ui.recentFolders, [{ path: "/b", lastAccessed: 3 }])
    assert.deepEqual(host.state.ui.recentFolders, [{ path: "/host", lastAccessed: 1 }])
    prefsB.rememberCloneParent("/b/clones")
    await ownerB.backend.storage.flushWrites()
    assert.equal(b.state.ui.lastCloneParent, "/b/clones")
    assert.equal(host.state.ui.lastCloneParent, undefined)
    await assert.rejects(prefsA.setListeningMode("all"), /local host/)
    assert.equal(a.config.server.listeningMode, undefined)
  })

  await t.test("model and Missions values inherit only when absent; writes create server overrides", async () => {
    assert.deepEqual(prefsB.uiState().models.favorites, hostPrefs.uiState().models.favorites)
    assert.deepEqual(prefsA.uiState().models.favorites, [], "explicit empty values suppress fallback")
    assert.deepEqual(prefsB.preferences().modelVisibility, hostPrefs.preferences().modelVisibility)
    assert.equal(prefsB.missionDefaultsValid(), true)
    assert.equal(prefsB.missionModelsValid(), true)
    prefsB.toggleFavoriteModelPreference({ providerId: "p", modelId: "b" })
    prefsB.addRecentModelPreference({ providerId: "p", modelId: "b" })
    await new Promise<void>(resolve => setImmediate(resolve))
    await ownerB.backend.storage.flushWrites()
    assert.deepEqual(b.state.ui.models.favorites, [{ providerId: "p", modelId: "b" }, { providerId: "p", modelId: "host" }])
    assert.equal(host.state.ui.models.favorites.length, 1)
    await prefsB.setProviderModelVisibility("p", { hiddenModelIds: ["b"] })
    assert.deepEqual(prefsB.getProviderModelVisibilityPreference("p"), { hiddenModelIds: ["b"] })
    assert.deepEqual(hostPrefs.getProviderModelVisibilityPreference("p"), { hiddenModelIds: ["hidden"] })
    const defaults = [{ template: "all" as const, profiles: {}, taskMode: "native" as const }]
    await prefsB.saveMissionDefaults(defaults, prefsB.missionPreferenceSnapshot("missionProfileDefaults"))
    assert.equal(b.config.ui.settings.missionProfileDefaults[0].template, "all")
    assert.deepEqual(host.config.ui.settings.missionProfileDefaults, [])
    assert.equal(b.calls.at(-1)?.url, "https://prefsb.invalid/api/storage/config/ui?conditional=missions-v1")
    assert.deepEqual(JSON.parse(String(b.calls.at(-1)?.body)).expected, [{ key: "missionProfileDefaults", present: false }])
    const hostBrief = { version: 1 as const, id: "00000000-0000-0000-0000-000000000001", name: "Host", objective: "Host objective", notes: "", template: "custom" as const }
    await hostPrefs.saveUserMissionModel(hostBrief)
    assert.deepEqual(prefsB.preferences().missionModels, [hostBrief])
    assert.deepEqual(prefsA.preferences().missionModels, [], "explicit library suppresses inheritance")
    await prefsB.saveUserMissionModel({ ...hostBrief, id: "00000000-0000-0000-0000-000000000002", name: "B" })
    assert.equal(b.config.ui.settings.missionModels.length, 2, "first edit starts from the inherited library")
    assert.equal(host.config.ui.settings.missionModels.length, 1)
  })

  await t.test("real instance preference consumer uses raw ids on the owning storage", async () => {
    await module.setAgentModelPreference("prefsA~same", "build", { providerId: "p", modelId: "a" })
    await module.setAgentModelPreference("prefsB~same", "build", { providerId: "p", modelId: "b" })
    assert.deepEqual(await module.getAgentModelPreference("prefsA~same", "build"), { providerId: "p", modelId: "a" })
    assert.deepEqual(await module.getAgentModelPreference("prefsB~same", "build"), { providerId: "p", modelId: "b" })
    for (const owner of [a, b]) assert.ok(owner.calls.some(call => call.url.endsWith("/api/storage/instances/same") && call.method === "PUT"))
    assert.equal(host.calls.some(call => call.url.includes("/instances/")), false)
    const { preferredModelList } = await import("./model-picker")
    const models = ["host", "a", "b", "hidden"].map(id => ({ id, name: id, providerId: "p", providerName: "P" }))
    assert.equal(preferredModelList(models, "prefsB~same").shown.some(model => model.id === "b"), false)
    assert.equal(preferredModelList(models, "prefsA~same").shown.some(model => model.id === "b"), true)
  })

  await t.test("persisted thinking variants reset through Merge Patch on host and server", async () => {
    const model = { providerId: "p", modelId: "variant" }
    for (const [prefs, backend, data] of [[hostPrefs, localBackend, host], [prefsB, ownerB.backend, b]] as const) {
      prefs.setModelThinkingSelection(model, "high")
      await new Promise<void>(resolve => setImmediate(resolve))
      await backend.storage.flushWrites()
      assert.equal(prefs.getModelThinkingSelection(model), "high")
      prefs.setModelThinkingSelection(model, undefined)
      await new Promise<void>(resolve => setImmediate(resolve))
      await backend.storage.flushWrites()
      assert.equal(prefs.getModelThinkingSelection(model), undefined)
      assert.equal(Object.values(data.state.ui.models.thinkingSelections).includes("high"), false)
      const patch = JSON.parse(String(data.calls.filter(call => call.method === "PATCH").at(-1)?.body))
      assert.ok(Object.values(patch.models.thinkingSelections).includes(null))
    }
  })

  await t.test("missing and revoked owners never write locally; queued writes retain admission", async () => {
    const beforeHost = host.calls.length, beforeA = a.calls.length
    assert.throws(() => module.preferencesForBackend("absentPrefs"), /Backend unavailable/)
    ownerA.detach()
    assert.throws(() => prefsA.addRecentFolder("/wrong"), /Backend unavailable/)
    assert.throws(() => module.preferencesOf("prefsA~same"), /Backend unavailable/)
    assert.equal(host.calls.length, beforeHost)
    assert.equal(a.calls.length, beforeA)
    let release!: () => void
    b.hold(new Promise<void>(resolve => { release = resolve }))
    const first = prefsB.setProviderModelVisibility("p", { hiddenModelIds: ["first"] })
    const queued = prefsB.setProviderModelVisibility("p", { hiddenModelIds: ["queued"] })
    await new Promise<void>(resolve => setImmediate(resolve))
    ownerB.detach()
    const sent = b.calls.length
    release()
    await first.catch(() => {})
    await assert.rejects(queued, /Backend unavailable/)
    assert.equal(b.calls.length, sent, "queued mutation is never dispatched after revocation")
    assert.equal(host.calls.length, beforeHost)
  })

  await t.test("revocation fences in-flight loads and a reused backend id gets fresh state", async () => {
    const data = fixture({}, { ui: { recentFolders: [{ path: "/obsolete", lastAccessed: 1 }] } })
    let release!: () => void
    data.hold(new Promise<void>(resolve => { release = resolve }))
    const old = attach("prefsReuse", data), oldPrefs = module.preferencesForBackend("prefsReuse")
    const loading = oldPrefs.ensureLoaded()
    old.detach()
    const fresh = fixture({}, { ui: { recentFolders: [{ path: "/new", lastAccessed: 2 }] } })
    attach("prefsReuse", fresh)
    const newPrefs = module.preferencesForBackend("prefsReuse")
    newPrefs.addRecentFolder("/extra")
    await newPrefs.ensureLoaded()
    await new Promise<void>(resolve => setImmediate(resolve))
    release()
    await assert.rejects(loading, /Backend unavailable/)
    assert.throws(() => oldPrefs.recentFolders(), /Backend unavailable/)
    assert.deepEqual(newPrefs.recentFolders().map(folder => folder.path), ["/extra", "/new"], "an early edit waits for its existing server state")
  })
})
