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

  await t.test("remote state edits compose at their turn, loaded or cold, and stay backend independent", async () => {
    for (const cold of [false, true]) {
      const data = fixture({}, { ui: { recentFolders: [{ path: "/existing", lastAccessed: 1 }], models: { favorites: [] } } })
      const owner = attach(`burst${cold}`, data), prefs = module.preferencesForBackend(owner.backend.id)
      if (!cold) await prefs.ensureLoaded()
      let release!: () => void
      data.hold(new Promise<void>(resolve => { release = resolve }))
      prefs.addRecentFolder("/first")
      prefs.addRecentFolder("/second")
      prefs.toggleFavoriteModelPreference({ providerId: "p", modelId: "first" })
      prefs.toggleFavoriteModelPreference({ providerId: "p", modelId: "second" })
      const firstBrief = prefs.saveUserMissionModel({ version: 1, id: "00000000-0000-0000-0000-000000000011", name: "First", objective: "First", notes: "", template: "custom" })
      const secondBrief = prefs.saveUserMissionModel({ version: 1, id: "00000000-0000-0000-0000-000000000012", name: "Second", objective: "Second", notes: "", template: "custom" })
      await prefsB.renameRecentFolderProject("/b", "Independent")
      release()
      await owner.backend.storage.flushWrites()
      await Promise.all([firstBrief, secondBrief])
      assert.deepEqual(data.state.ui.recentFolders.map((entry: any) => entry.path), ["/second", "/first", "/existing"])
      assert.deepEqual(data.state.ui.models.favorites.map((entry: any) => entry.modelId), ["second", "first"])
      assert.deepEqual(data.config.ui.settings.missionModels.map((entry: any) => entry.name).sort(), ["First", "Host", "Second"])
    }
  })

  await t.test("cold default model waits for the server's recents before inheritance", async () => {
    const data = fixture({}, { ui: { models: { recents: [{ providerId: "p", modelId: "remote" }] } } })
    let release!: () => void
    data.hold(new Promise<void>(resolve => { release = resolve }))
    attach("coldModel", data)
    const { setProviders } = await import("./session-state")
    setProviders(previous => new Map(previous).set("coldModel~same", [{ id: "p", name: "P", models: ["host", "remote"].map(id => ({ id, name: id, providerId: "p" })) }]))
    const { getDefaultModel } = await import("./session-models")
    let settled = false
    const selected = getDefaultModel("coldModel~same").then(model => { settled = true; return model })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    release()
    assert.deepEqual(await selected, { providerId: "p", modelId: "remote" })
    const revokedData = fixture({}, { ui: { models: { recents: [{ providerId: "p", modelId: "remote" }] } } })
    let releaseRevoked!: () => void
    revokedData.hold(new Promise<void>(resolve => { releaseRevoked = resolve }))
    const revoked = attach("coldRevoked", revokedData)
    const pending = getDefaultModel("coldRevoked~same")
    const rejected = assert.rejects(pending, /Backend unavailable|abort/i)
    revoked.detach()
    releaseRevoked()
    await rejected
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
    assert.deepEqual(module.preferencesForBackend("absentPrefs").recentFolders(), [])
    ownerA.detach()
    assert.throws(() => prefsA.addRecentFolder("/wrong"), /Backend unavailable/)
    assert.deepEqual(module.preferencesOf("prefsA~same").recentFolders(), [])
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

  await t.test("the same client reattached cannot publish an old ACK or erase newer persisted recents", async () => {
    let state: Bucket = { recentFolders: [{ path: "/initial", lastAccessed: 1 }] }
    let hold: Promise<void> | undefined, release!: () => void
    const backend = createBackendClient({ id: "sameClient", baseUrl: "https://same.invalid", fetcher: async (input, init) => {
      if (!new URL(String(input)).pathname.includes("/state/")) return Response.json({})
      if (init?.method === "PATCH") {
        state = applyMergePatch(state, JSON.parse(String(init.body))) as Bucket
        const acknowledged = structuredClone(state)
        await hold // The mutation commits before its response is delayed.
        return Response.json(acknowledged)
      }
      return Response.json(state)
    } })
    registry.set(backend.id, backend); registered.push(backend)
    let detach = backendEvents.attach(backend.id, backend.events)
    const old = module.preferencesForBackend(backend.id)
    await old.ensureLoaded()
    hold = new Promise(resolve => { release = resolve })
    const pending = old.renameRecentFolderProject("/initial", "Committed name")
    const rejected = assert.rejects(pending, /Backend unavailable/)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(state.recentFolders[0].projectName, "Committed name")
    detach()
    hold = undefined
    detach = backendEvents.attach(backend.id, backend.events)
    const fresh = module.preferencesForBackend(backend.id)
    // Initial loading now waits for the dispatched request to settle.
    release()
    await fresh.ensureLoaded()
    await fresh.addRecentFolder("/fresh")
    const before = structuredClone(fresh.recentFolders())
    assert.ok(before.some(folder => folder.path === "/fresh"))
    release(); await rejected
    assert.deepEqual(fresh.recentFolders(), before, "revoked ACK never reaches the new subscription")
    assert.deepEqual(await backend.storage.loadStateOwner("ui"), state, "revoked ACK never replaces the shared cache")
    await fresh.addRecentFolder("/after")
    assert.deepEqual(state.recentFolders.map((folder: any) => folder.path), ["/after", "/fresh", "/initial"])
    assert.equal(state.recentFolders[2].projectName, "Committed name", "a dispatched mutation retains its durable result")
    detach()
  })

  for (const nativeEvent of [false, true]) await t.test(`late old commit preserves replacement edits (native event: ${nativeEvent})`, async () => {
    let state: Bucket = { recentFolders: [{ path: "/initial", lastAccessed: 1 }] }
    let release!: () => void, first = true, reads = 0, writes = 0
    const wait = new Promise<void>(resolve => { release = resolve })
    const backend = createBackendClient({ id: `lateCommit${nativeEvent}`, baseUrl: "https://late.invalid", fetcher: async (input, init) => {
      if (!String(input).includes("/state/")) return Response.json({})
      if (init?.method === "PATCH") {
        writes++
        const delayed = first
        if (first) { first = false; await wait }
        state = applyMergePatch(state, JSON.parse(String(init.body))) as Bucket
        if (delayed && nativeEvent) (backend.events as any).dispatch({ type: "storage.stateChanged", owner: "ui", value: structuredClone(state) })
      } else reads++
      return Response.json(state)
    } })
    registry.set(backend.id, backend); registered.push(backend)
    let detach = backendEvents.attach(backend.id, backend.events)
    const old = module.preferencesForBackend(backend.id)
    await old.ensureLoaded()
    const pending = old.renameRecentFolderProject("/initial", "Late durable name")
    const rejected = assert.rejects(pending, /Backend unavailable/)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(writes, 1)
    detach(); detach = backendEvents.attach(backend.id, backend.events)
    const fresh = module.preferencesForBackend(backend.id)
    const adding = fresh.addRecentFolder("/fresh") as unknown as Promise<void>
    for (let turn = 0; turn < 5; turn++) await new Promise<void>(resolve => setImmediate(resolve))
    const beforeRelease = { reads, writes }
    release()
    await Promise.all([rejected, adding])
    assert.ok(state.recentFolders.some((folder: any) => folder.path === "/fresh"), "the old commit preserves the new durable recent")
    assert.equal(state.recentFolders.find((folder: any) => folder.path === "/initial").projectName, "Late durable name")
    await fresh.addRecentFolder("/after")
    assert.deepEqual(state.recentFolders.map((folder: any) => folder.path), ["/after", "/fresh", "/initial"])
    assert.equal(state.recentFolders[2].projectName, "Late durable name")
    assert.deepEqual(fresh.recentFolders(), state.recentFolders)
    assert.equal(reads, 2, "replacement loads the durable document afresh")
    assert.equal(beforeRelease.reads, 1, "replacement reads wait for the old sent write")
    assert.equal(beforeRelease.writes, 1, "replacement edits wait before composing their patch")
    detach()
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
    assert.deepEqual(oldPrefs.recentFolders(), [])
    assert.deepEqual(newPrefs.recentFolders().map(folder => folder.path), ["/extra", "/new"], "an early edit waits for its existing server state")
  })
})
