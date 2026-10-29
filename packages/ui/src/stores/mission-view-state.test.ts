import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

// The largest completed set a project journal can hold: 2,000 events, two per completed Mission.
const ids = Array.from({ length: 1000 }, (_, index) => `msn_${index.toString(16).padStart(24, "0")}`)
const reload = process.env.MISSION_SEEN_STORAGE
const storage = new Map<string, string>(JSON.parse(reload ?? "[]"))
Object.assign(globalThis, { window: {
  localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key) },
  electronAPI: { claimClientStateAccess: async () => true,
    loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: null }), saveClientState: async () => true },
} })
const { initializeClientState } = await import("./client-state")
await initializeClientState()
const { markMissionsFinishedSeen, missionFinishedSeen } = await import("./mission-view-state")

if (reload) {
  test("a fresh window keeps every seen completion and the unseen one", () => {
    assert.equal(ids.slice(0, -1).every(id => missionFinishedSeen("project", id)), true)
    assert.equal(missionFinishedSeen("project", ids.at(-1)!), false)
  })
} else {
  test("seen completions persist for the most completed Missions a project journal can hold", () => {
    markMissionsFinishedSeen("project", [], ids.slice(0, -1))
    markMissionsFinishedSeen("project", [], ids)
    assert.equal(missionFinishedSeen("project", ids.at(-1)!), false, "a later completion starts unseen")
    const saved = [...storage.values()].find(value => /^[\w-]+$/.test(value))
    assert.ok(saved && saved.length <= 4096, "one layout value")
    const { NODE_TEST_CONTEXT: _parent, ...env } = process.env
    const output = execFileSync(process.execPath, ["--conditions=browser", "--import", "tsx", fileURLToPath(import.meta.url)],
      { env: { ...env, MISSION_SEEN_STORAGE: JSON.stringify([...storage]) }, encoding: "utf8" })
    assert.match(output, /pass 1\b/)
    assert.match(output, /fail 0\b/)
  })
}
