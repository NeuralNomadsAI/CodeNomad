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

// Preference writes are fire-and-forget like the neighboring favorite toggles,
// and the mode additionally passes through a write queue whose mocked writes
// sleep. Waiting on the observable outcome keeps this independent of machine
// speed, timer resolution and how many other files the runner has already run.
async function waitUntil(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`Timed out waiting for ${description}`)
}

// The store is a module singleton, so its load happens once per process. Every
// block therefore seeds the state it needs through the very first load and
// drains the queue before restoring the mocks, so no write escapes to the real
// API client.
interface Harness {
  state: Record<string, any>
  patches: unknown[]
  applied: boolean[]
  fail: boolean
}

function install(initial: Record<string, any>) {
  const harness: Harness = { state: initial, patches: [], applied: [], fail: false }
  storage.loadConfigOwner = async () => ({}) as any
  storage.loadStateOwner = async () => structuredClone(harness.state) as any
  storage.patchConfigOwner = async () => ({}) as any
  storage.patchStateOwner = async (_owner: string, patch: unknown) => {
    const next = (patch as { models?: { favoritesOnly?: boolean } })?.models?.favoritesOnly
    harness.patches.push(structuredClone(patch))
    // Turning the mode on is the slow write, so an unserialized implementation
    // would apply the following "off" write first and settle on the wrong value.
    if (next === true) await new Promise((resolve) => setTimeout(resolve, 30))
    if (harness.fail) throw new Error("Simulated storage failure")
    harness.state = merge(harness.state, patch as Record<string, any>)
    if (typeof next === "boolean") harness.applied.push(next)
    return structuredClone(harness.state) as any
  }
  return harness
}

const originals = {
  loadConfigOwner: storage.loadConfigOwner, loadStateOwner: storage.loadStateOwner,
  patchStateOwner: storage.patchStateOwner, patchConfigOwner: storage.patchConfigOwner,
}

it("stores the favorites-only model mode next to the favorites without disturbing them", async () => {
  // A non-boolean flag is ignored, so the mode starts from the full catalog.
  const harness = install(
    { models: { favorites: [{ providerId: "openai", modelId: "gpt-6-astra" }], favoritesOnly: "yes" } },
  )
  try {
    const { getFavoritesOnlyPreference, setFavoritesOnlyPreference, toggleFavoriteModelPreference, uiState, updatePreferences } =
      await import("./preferences")
    await updatePreferences({}) // This is the one load, so the seeded state is the stored one.
    assert.equal(uiState().models.favoritesOnly, false, "only a real boolean is accepted")
    assert.equal(getFavoritesOnlyPreference(), false)

    setFavoritesOnlyPreference(true)
    await waitUntil(() => harness.patches.length === 1, "the mode to be persisted")
    assert.deepEqual(harness.patches[0], { models: { favoritesOnly: true } })
    assert.equal(getFavoritesOnlyPreference(), true)

    // Unstarring a model keeps the stored mode, and vice versa.
    toggleFavoriteModelPreference({ providerId: "openai", modelId: "gpt-6-astra" })
    await waitUntil(() => harness.patches.length === 2, "the favorite removal to be persisted")
    assert.deepEqual(harness.patches[1], { models: { favorites: [] } })
    assert.equal(getFavoritesOnlyPreference(), true)
    toggleFavoriteModelPreference({ providerId: "zen", modelId: "zen-other" })
    await waitUntil(() => harness.patches.length === 3, "the favorite addition to be persisted")
    assert.deepEqual(harness.patches[2], { models: { favorites: [{ providerId: "zen", modelId: "zen-other" }] } })
    assert.equal(getFavoritesOnlyPreference(), true)

    setFavoritesOnlyPreference(false)
    await waitUntil(() => harness.patches.length === 4, "the mode to be turned off")
    assert.deepEqual(harness.patches[3], { models: { favoritesOnly: false } })
    assert.equal(getFavoritesOnlyPreference(), false)
    assert.deepEqual(harness.state.models.favorites, [{ providerId: "zen", modelId: "zen-other" }])

    // A repeated write of the current mode is not sent again.
    setFavoritesOnlyPreference(false)
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(harness.patches.length, 4)
    await waitUntil(() => getFavoritesOnlyPreference() === harness.state.models.favoritesOnly, "the queue to drain")
  } finally { Object.assign(storage, originals) }
})

it("serializes rapid mode writes in click order and keeps a failed write revocable", async () => {
  const harness = install({ models: { favorites: [], favoritesOnly: false } })
  try {
    const { getFavoritesOnlyPreference, setFavoritesOnlyPreference, updatePreferences } = await import("./preferences")
    await updatePreferences({})

    // The wanted value is readable immediately, so a second click alternates it
    // instead of being swallowed by the not-yet-settled first write.
    setFavoritesOnlyPreference(true)
    setFavoritesOnlyPreference(false)
    assert.equal(getFavoritesOnlyPreference(), false)
    await waitUntil(() => harness.applied.length === 2, "both mode writes to be applied")
    assert.deepEqual(harness.applied, [true, false], "the writes keep their click order")
    assert.equal(harness.state.models.favoritesOnly, false)
    assert.equal(getFavoritesOnlyPreference(), false)

    // A rejected write falls back to the persisted value rather than sticking.
    harness.fail = true
    setFavoritesOnlyPreference(true)
    assert.equal(getFavoritesOnlyPreference(), true, "the intent is visible while it is in flight")
    await waitUntil(() => harness.patches.length === 3, "the failing write to be attempted")
    await waitUntil(() => getFavoritesOnlyPreference() === false, "the failed write to be released")
    assert.equal(harness.state.models.favoritesOnly, false)
    assert.equal(harness.applied.at(-1), false, "a rejected write is not applied")
  } finally { Object.assign(storage, originals) }
})

it("keeps the newest intent published while superseded writes are still settling", async () => {
  const harness = install({ models: { favorites: [], favoritesOnly: false } })
  try {
    const { getFavoritesOnlyPreference, setFavoritesOnlyPreference, updatePreferences } = await import("./preferences")
    await updatePreferences({})

    // A three-click burst: the middle write is superseded, so when it settles it
    // must not retire the newest intent and expose the older stored value.
    setFavoritesOnlyPreference(true)
    setFavoritesOnlyPreference(false)
    setFavoritesOnlyPreference(true)
    const readings: boolean[] = [getFavoritesOnlyPreference()]
    for (let sample = 0; sample < 200 && harness.applied.length < 3; sample += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      readings.push(getFavoritesOnlyPreference())
    }
    await waitUntil(() => harness.applied.length === 3, "the burst writes to be applied")
    await waitUntil(() => getFavoritesOnlyPreference() === harness.state.models.favoritesOnly, "the queue to drain")

    assert.deepEqual(harness.applied, [true, false, true], "the writes keep their click order")
    assert.ok(readings.every((value) => value === true), `the published intent never flips: ${readings.join(",")}`)
    assert.equal(getFavoritesOnlyPreference(), true)
  } finally { Object.assign(storage, originals) }
})
