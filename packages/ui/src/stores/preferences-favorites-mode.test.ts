import assert from "node:assert/strict"
import { it } from "node:test"
import { storage } from "../lib/storage"

function merge(target: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  const result = structuredClone(target)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key]
    else result[key] = typeof value === "object" && !Array.isArray(value)
      ? merge(result[key] ?? {}, value) : value
  }
  return result
}

// Preference writes are fire-and-forget like the neighboring favorite toggles;
// the mode additionally passes through a write queue, so drain several turns.
const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

it("stores the favorites-only model mode next to the favorites without disturbing them", async () => {
  const originals = {
    loadConfigOwner: storage.loadConfigOwner, loadStateOwner: storage.loadStateOwner,
    patchStateOwner: storage.patchStateOwner, patchConfigOwner: storage.patchConfigOwner,
  }
  let state: Record<string, any> = {
    models: { favorites: [{ providerId: "openai", modelId: "gpt-6-astra" }] },
  }
  const patches: unknown[] = []
  storage.loadConfigOwner = async () => ({})
  storage.loadStateOwner = async () => structuredClone(state)
  storage.patchConfigOwner = async () => ({})
  storage.patchStateOwner = async (_owner, patch) => {
    patches.push(structuredClone(patch))
    state = merge(state, patch as Record<string, any>)
    return structuredClone(state)
  }
  try {
    const { getFavoritesOnlyPreference, setFavoritesOnlyPreference, toggleFavoriteModelPreference, uiState, updatePreferences } =
      await import("./preferences")
    await updatePreferences({}) // Load the stored state before interaction.

    // An absent flag reads as the full catalog rather than a guess.
    assert.equal(getFavoritesOnlyPreference(), false)
    assert.equal(uiState().models.favoritesOnly, false)

    setFavoritesOnlyPreference(true)
    await settle()
    assert.deepEqual(patches.at(-1), { models: { favoritesOnly: true } })
    assert.equal(getFavoritesOnlyPreference(), true)

    // Unstarring a model keeps the stored mode, and vice versa.
    toggleFavoriteModelPreference({ providerId: "openai", modelId: "gpt-6-astra" })
    await settle()
    assert.deepEqual(patches.at(-1), { models: { favorites: [] } })
    assert.equal(getFavoritesOnlyPreference(), true)
    toggleFavoriteModelPreference({ providerId: "zen", modelId: "zen-other" })
    await settle()
    assert.deepEqual(patches.at(-1), { models: { favorites: [{ providerId: "zen", modelId: "zen-other" }] } })
    assert.equal(getFavoritesOnlyPreference(), true)

    setFavoritesOnlyPreference(false)
    await settle()
    assert.deepEqual(patches.at(-1), { models: { favoritesOnly: false } })
    assert.equal(getFavoritesOnlyPreference(), false)
    assert.deepEqual(state.models.favorites, [{ providerId: "zen", modelId: "zen-other" }])

    // A repeated write of the current mode is not sent again.
    const before = patches.length
    setFavoritesOnlyPreference(false)
    await settle()
    assert.equal(patches.length, before)
  } finally { Object.assign(storage, originals) }
})

it("serializes rapid mode writes in click order and keeps a failed write revocable", async () => {
  const originals = {
    loadConfigOwner: storage.loadConfigOwner, loadStateOwner: storage.loadStateOwner,
    patchStateOwner: storage.patchStateOwner, patchConfigOwner: storage.patchConfigOwner,
  }
  let state: Record<string, any> = { models: { favorites: [], favoritesOnly: false } }
  let fail = false
  const applied: boolean[] = []
  storage.loadConfigOwner = async () => ({})
  storage.loadStateOwner = async () => structuredClone(state)
  storage.patchConfigOwner = async () => ({})
  storage.patchStateOwner = async (_owner, patch) => {
    const next = (patch as { models: { favoritesOnly: boolean } }).models.favoritesOnly
    // Turning the mode on is the slow write, so an unserialized implementation
    // would apply the following "off" write first and settle on the wrong value.
    if (typeof next === "boolean") await new Promise((resolve) => setTimeout(resolve, next ? 30 : 0))
    if (fail) throw new Error("Simulated storage failure")
    state = merge(state, patch as Record<string, any>)
    applied.push(next)
    return structuredClone(state)
  }
  try {
    const { getFavoritesOnlyPreference, setFavoritesOnlyPreference, updatePreferences } = await import("./preferences")
    await updatePreferences({})

    // The wanted value is readable immediately, so a second click alternates it
    // instead of being swallowed by the not-yet-settled first write.
    setFavoritesOnlyPreference(true)
    setFavoritesOnlyPreference(false)
    assert.equal(getFavoritesOnlyPreference(), false)
    await settle()
    assert.deepEqual(applied, [true, false], "the writes keep their click order")
    assert.equal(state.models.favoritesOnly, false)
    assert.equal(getFavoritesOnlyPreference(), false)

    // A rejected write falls back to the persisted value rather than sticking.
    fail = true
    setFavoritesOnlyPreference(true)
    assert.equal(getFavoritesOnlyPreference(), true, "the intent is visible while it is in flight")
    await settle()
    assert.equal(getFavoritesOnlyPreference(), false, "and released back to the stored value")
    assert.equal(state.models.favoritesOnly, false)
  } finally { Object.assign(storage, originals) }
})

it("accepts only a real boolean for the stored favorites-only mode", async () => {
  const originals = {
    loadConfigOwner: storage.loadConfigOwner, loadStateOwner: storage.loadStateOwner,
    patchStateOwner: storage.patchStateOwner, patchConfigOwner: storage.patchConfigOwner,
  }
  let state: Record<string, any> = { models: { favoritesOnly: "yes" } }
  storage.loadConfigOwner = async () => ({})
  storage.loadStateOwner = async () => structuredClone(state)
  storage.patchConfigOwner = async () => ({})
  storage.patchStateOwner = async (_owner, patch) => {
    state = merge(state, patch as Record<string, any>)
    return structuredClone(state)
  }
  try {
    const { getFavoritesOnlyPreference, setFavoritesOnlyPreference, updatePreferences } = await import("./preferences")
    await updatePreferences({})
    assert.equal(getFavoritesOnlyPreference(), false)
    setFavoritesOnlyPreference(true)
    await settle()
    assert.equal(getFavoritesOnlyPreference(), true)
  } finally { Object.assign(storage, originals) }
})
