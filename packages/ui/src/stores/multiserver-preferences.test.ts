import assert from "node:assert/strict"
import { it } from "node:test"
import { storage } from "../lib/storage"

it("retains server-scoped recents and favorites while legacy local edits leave remote entries intact", async () => {
  const path = "/same"
  let state: any = {
    recentFolders: [undefined, "A", "B"].map(serverId => ({ path, lastAccessed: 1, ...(serverId ? { serverId } : {}) })),
    models: { favorites: [undefined, "A", "B"].map(serverId => ({ providerId: "p", modelId: "m", ...(serverId ? { serverId } : {}) })) },
  }
  const originals = {
    loadConfigOwner: storage.loadConfigOwner, loadStateOwner: storage.loadStateOwner,
    revalidateUiConfigOwner: storage.revalidateUiConfigOwner,
    patchConfigOwner: storage.patchConfigOwner, patchStateOwner: storage.patchStateOwner,
  }
  storage.loadConfigOwner = async () => ({}) as any
  storage.revalidateUiConfigOwner = async () => ({})
  storage.loadStateOwner = async () => structuredClone(state)
  storage.patchConfigOwner = async () => ({}) as any
  storage.patchStateOwner = async (_owner, patch: any) => {
    state = { ...state, ...patch, models: { ...state.models, ...patch.models } }
    return structuredClone(state)
  }
  const drain = async () => { for (let i = 0; i < 10; i++) await new Promise<void>(resolve => setImmediate(resolve)) }
  try {
    const prefs = await import("./preferences")
    await prefs.updatePreferences({})
    assert.equal(prefs.uiState().recentFolders.length, 3)
    assert.equal(prefs.uiState().models.favorites.length, 3)
    assert.equal(prefs.recentFolders().length, 1, "the path-only public launcher receives local entries only")
    prefs.removeRecentFolder(path)
    prefs.toggleFavoriteModelPreference({ providerId: "p", modelId: "m" })
    await drain()
    assert.deepEqual(prefs.uiState().recentFolders.map(f => f.serverId), ["A", "B"])
    assert.equal(prefs.recentFolders().length, 0)
    assert.deepEqual(prefs.uiState().models.favorites.map(f => f.serverId), ["A", "B"])
    prefs.recordWorkspaceLaunch(path, "/alias", "A")
    await drain()
    assert.deepEqual(prefs.uiState().recentFolders.map(f => f.serverId), ["A", "B"])
    prefs.toggleFavoriteModelPreference({ providerId: "p", modelId: "m", serverId: "A" })
    await drain()
    assert.deepEqual(prefs.uiState().models.favorites.map(f => f.serverId), ["B"])
    prefs.addRecentModelPreference({ providerId: "p", modelId: "m", serverId: "A" })
    await drain()
    prefs.addRecentModelPreference({ providerId: "p", modelId: "m", serverId: "B" })
    await drain()
    assert.deepEqual(prefs.uiState().models.recents.map(f => f.serverId), ["B", "A"])
    assert.equal(prefs.isFavoriteModelPreference({ providerId: "p", modelId: "m" }), false)
    assert.equal(prefs.isFavoriteModelPreference({ providerId: "p", modelId: "m", serverId: "B" }), true)
  } finally { Object.assign(storage, originals) }
})
