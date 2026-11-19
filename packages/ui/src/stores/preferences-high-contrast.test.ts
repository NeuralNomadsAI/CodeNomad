import assert from "node:assert/strict"
import { before, it, mock } from "node:test"
import { storage, type OwnerBucket } from "../lib/storage"
import { normalizeColorScheme } from "../lib/theme-scheme"

type PreferencesModule = typeof import("./preferences")
let moduleId = 0

before(async () => {
  // i18n imports the canonical store. Finish its bootstrap before measuring a fresh test instance.
  mock.method(storage, "loadConfigOwner", async () => ({}))
  mock.method(storage, "loadStateOwner", async () => ({}))
  mock.method(storage, "revalidateUiConfigOwner", async () => ({}))
  try {
    const canonical = await import("./preferences")
    await canonical.ensureLoaded()
  } finally {
    mock.restoreAll()
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function merge(target: OwnerBucket, patch: OwnerBucket): OwnerBucket {
  const result = structuredClone(target)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key]
    else result[key] = typeof value === "object" && !Array.isArray(value)
      ? merge(result[key] ?? {}, value) : value
  }
  return result
}

async function withPreferences(config: OwnerBucket, run: (prefs: PreferencesModule, data: {
  config: OwnerBucket
  state: OwnerBucket
  writes: OwnerBucket[]
  stateWrites: OwnerBucket[]
  reads: number
}) => Promise<void>) {
  const originals = {
    loadConfigOwner: storage.loadConfigOwner, loadStateOwner: storage.loadStateOwner,
    revalidateUiConfigOwner: storage.revalidateUiConfigOwner,
    patchConfigOwner: storage.patchConfigOwner, patchStateOwner: storage.patchStateOwner,
  }
  const data = {
    config, state: { colorScheme: normalizeColorScheme("slate"), theme: "dark" } as OwnerBucket,
    writes: [] as OwnerBucket[], stateWrites: [] as OwnerBucket[], reads: 0,
  }
  storage.loadConfigOwner = async () => ({})
  storage.loadStateOwner = async () => structuredClone(data.state)
  storage.revalidateUiConfigOwner = async () => {
    data.reads++
    return structuredClone(data.config)
  }
  storage.patchConfigOwner = async (owner, patch) => {
    assert.equal(owner, "ui")
    data.writes.push(structuredClone(patch as OwnerBucket))
    data.config = merge(data.config, patch as OwnerBucket)
    return structuredClone(data.config)
  }
  storage.patchStateOwner = async (owner, patch) => {
    assert.equal(owner, "ui")
    data.stateWrites.push(structuredClone(patch as OwnerBucket))
    data.state = merge(data.state, patch as OwnerBucket)
    return structuredClone(data.state)
  }
  try {
    const prefs = await import(`./preferences.tsx?high-contrast=${moduleId++}`) as PreferencesModule
    await prefs.ensureLoaded()
    await run(prefs, data)
  } finally { Object.assign(storage, originals) }
}

it("loads absent and invalid contrast values as auto without writing", async () => {
  for (const value of [undefined, null, true, false, 1, "", "ON", "more", {}, []]) {
    await withPreferences({ settings: { highContrast: value } }, async (prefs, data) => {
      assert.equal(prefs.highContrastPreference(), "auto")
      assert.equal(prefs.preferences().highContrast, "auto")
      assert.equal(prefs.highContrastSaveFailed(), false)
      assert.equal(prefs.highContrastSavePending(), false)
      assert.equal(data.reads, 1)
      assert.deepEqual(data.writes, [])
      assert.deepEqual(data.stateWrites, [])
    })
  }
  for (const value of ["auto", "on", "off"]) {
    await withPreferences({ settings: { highContrast: value } }, async (prefs, data) => {
      assert.equal(prefs.highContrastPreference(), value)
      assert.deepEqual(data.writes, [])
    })
  }
})

it("publishes a burst immediately, serializes writes and persists explicit auto", async () => {
  await withPreferences({}, async (prefs, data) => {
    const first = deferred<OwnerBucket>()
    const started = deferred<void>()
    const patch = storage.patchConfigOwner.bind(storage)
    storage.patchConfigOwner = async (owner, value) => {
      if ((value as OwnerBucket).settings.highContrast === "on") {
        started.resolve()
        return first.promise
      }
      return patch(owner, value)
    }
    const one = prefs.setHighContrastPreference("on")
    assert.equal(prefs.highContrastPreference(), "on")
    const two = prefs.setHighContrastPreference("off")
    const three = prefs.setHighContrastPreference("auto")
    assert.equal(prefs.highContrastPreference(), "auto")
    assert.equal(prefs.highContrastSavePending(), true)
    await started.promise
    assert.deepEqual(data.writes, [])
    first.resolve({ settings: { highContrast: "on" } })
    assert.equal(await one, true)
    assert.equal(prefs.highContrastPreference(), "auto")
    assert.deepEqual(await Promise.all([two, three]), [true, true])
    assert.equal(prefs.highContrastSavePending(), false)
    assert.equal(prefs.highContrastSaveFailed(), false)
    assert.equal(data.config.settings.highContrast, "auto")
    assert.deepEqual(data.writes, [
      { settings: { highContrast: "off" } }, { settings: { highContrast: "auto" } },
    ])
    // Selecting the already-effective default is still an explicit saved choice.
    assert.equal(await prefs.setHighContrastPreference("auto"), true)
    assert.equal(data.writes.length, 3)
  })
})

it("rolls back to authority rather than the stale display cache after a failed write", async () => {
  await withPreferences({ settings: { highContrast: "off" } }, async (prefs, data) => {
    data.config = { settings: { highContrast: "auto", keepComputerAwake: true } }
    let cachedReads = 0
    storage.loadConfigOwner = async () => {
      cachedReads++
      return { settings: { highContrast: "off" } }
    }
    storage.patchConfigOwner = async () => { throw new Error("Simulated contrast write failure") }
    const result = prefs.setHighContrastPreference("on")
    assert.equal(prefs.highContrastPreference(), "on")
    assert.equal(await result, false)
    assert.equal(prefs.highContrastPreference(), "auto")
    assert.equal(prefs.preferences().keepComputerAwake, true)
    assert.equal(prefs.highContrastSaveFailed(), true)
    assert.equal(prefs.highContrastSavePending(), false)
    assert.equal(data.reads, 2)
    assert.equal(cachedReads, 0)
  })
})

it("does not retire a newer choice when an older successful response arrives", async () => {
  await withPreferences({}, async (prefs) => {
    const first = deferred<OwnerBucket>()
    const second = deferred<OwnerBucket>()
    const started = deferred<void>()
    let calls = 0
    storage.patchConfigOwner = async () => {
      if (++calls === 1) return first.promise
      started.resolve()
      return second.promise
    }
    const one = prefs.setHighContrastPreference("on")
    const two = prefs.setHighContrastPreference("off")
    first.resolve({ settings: { highContrast: "on" } })
    assert.equal(await one, true)
    await started.promise
    assert.equal(prefs.highContrastPreference(), "off")
    assert.equal(prefs.highContrastSavePending(), true)
    second.resolve({ settings: { highContrast: "off" } })
    assert.equal(await two, true)
    assert.equal(prefs.highContrastPreference(), "off")
    assert.equal(prefs.highContrastSavePending(), false)
  })
})

it("keeps the newest intent during an older failure and authoritative rollback read", async () => {
  await withPreferences({ settings: { highContrast: "off" } }, async (prefs, data) => {
    const rollback = deferred<OwnerBucket>()
    const reading = deferred<void>()
    const newest = deferred<OwnerBucket>()
    const writingNewest = deferred<void>()
    storage.revalidateUiConfigOwner = async () => {
      reading.resolve()
      return rollback.promise
    }
    let calls = 0
    storage.patchConfigOwner = async () => {
      if (++calls === 1) throw new Error("Simulated older failure")
      writingNewest.resolve()
      return newest.promise
    }
    const one = prefs.setHighContrastPreference("on")
    await reading.promise
    const two = prefs.setHighContrastPreference("auto")
    assert.equal(prefs.highContrastPreference(), "auto")
    rollback.resolve({ settings: { highContrast: "off" } })
    assert.equal(await one, false)
    await writingNewest.promise
    assert.equal(prefs.highContrastPreference(), "auto")
    assert.equal(prefs.highContrastSaveFailed(), false)
    assert.equal(prefs.highContrastSavePending(), true)
    newest.resolve({ settings: { highContrast: "auto" } })
    assert.equal(await two, true)
    assert.equal(prefs.highContrastPreference(), "auto")
    assert.equal(prefs.highContrastSaveFailed(), false)
    assert.equal(prefs.highContrastSavePending(), false)
    assert.deepEqual(data.stateWrites, [])
  })
})

it("settles a failed newest write and permits a successful retry", async () => {
  await withPreferences({ settings: { highContrast: "auto" } }, async (prefs, data) => {
    const patch = storage.patchConfigOwner.bind(storage)
    let calls = 0
    storage.patchConfigOwner = async (owner, value) => {
      if (++calls === 2) throw new Error("Simulated newest failure")
      return patch(owner, value)
    }
    const one = prefs.setHighContrastPreference("on")
    const two = prefs.setHighContrastPreference("off")
    assert.deepEqual(await Promise.all([one, two]), [true, false])
    assert.equal(prefs.highContrastPreference(), "on")
    assert.equal(prefs.highContrastSaveFailed(), true)
    assert.equal(prefs.highContrastSavePending(), false)
    assert.equal(data.reads, 2)
    assert.equal(await prefs.setHighContrastPreference("off"), true)
    assert.equal(prefs.highContrastPreference(), "off")
    assert.equal(prefs.highContrastSaveFailed(), false)
  })
})

it("reports unavailable authority without adopting a stale cached rollback", async () => {
  await withPreferences({ settings: { highContrast: "off" } }, async (prefs) => {
    storage.patchConfigOwner = async () => { throw new Error("Simulated write failure") }
    storage.revalidateUiConfigOwner = async () => { throw new Error("Simulated read failure") }
    assert.equal(await prefs.setHighContrastPreference("on"), false)
    assert.equal(prefs.highContrastPreference(), "on")
    assert.equal(prefs.highContrastSaveFailed(), true)
    assert.equal(prefs.highContrastSavePending(), false)
  })
})

it("saves contrast while a palette write is pending, preserving palette and mode", async () => {
  await withPreferences({ settings: { highContrast: "off" } }, async (prefs, data) => {
    const paletteBefore = structuredClone(data.state)
    assert.equal(await prefs.setHighContrastPreference("on"), true)
    assert.deepEqual(data.state, paletteBefore)
    const palette = deferred<OwnerBucket>()
    const started = deferred<void>()
    storage.patchStateOwner = async (_owner, value) => {
      data.stateWrites.push(value as OwnerBucket)
      started.resolve()
      return palette.promise
    }
    const changingPalette = prefs.setColorSchemePreference(normalizeColorScheme("linen"))
    await started.promise
    assert.equal(await prefs.setHighContrastPreference("auto"), true)
    assert.equal(data.config.settings.highContrast, "auto")
    assert.equal(prefs.highContrastPreference(), "auto")
    assert.equal(prefs.themePreference(), "dark")
    palette.resolve(merge(data.state, data.stateWrites[0]))
    await changingPalette
    assert.equal(prefs.highContrastPreference(), "auto")
    assert.equal(prefs.getAppearancePalette("light").id, "linen")
    assert.equal(prefs.themePreference(), "dark")
    assert.deepEqual(data.writes, [
      { settings: { highContrast: "on" } }, { settings: { highContrast: "auto" } },
    ])
  })
})
