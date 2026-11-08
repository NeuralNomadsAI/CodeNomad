import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { createComputed, createRoot } from "solid-js"

const restored = process.env.MISSION_TASK_SEEN_STORAGE
const storage = new Map<string, string>(JSON.parse(restored ?? "[]"))
let storageUnavailable = false
Object.assign(globalThis, { window: { localStorage: {
  getItem: (key: string) => { if (storageUnavailable) throw new Error("unavailable"); return storage.get(key) ?? null },
  setItem: (key: string, value: string) => { if (storageUnavailable) throw new Error("unavailable"); storage.set(key, value) },
  removeItem: (key: string) => storage.delete(key),
} } })
const { initializeClientState } = await import("./client-state")
await initializeClientState()
const { markMissionTasksSeen, missionTaskUnseen, seedMissionTasksSeen } = await import("./mission-task-seen")
const task = (updatedAt: number, status = "completed", id = "task") => ({ id, updatedAt, status })

if (restored) {
  test("restores the initial boundary, individual versions and mission watermark", () => {
    assert.equal(missionTaskUnseen("persisted", "mission", task(101)), false, "waits for observation")
    seedMissionTasksSeen("persisted", 999)
    assert.equal(missionTaskUnseen("persisted", "mission", task(100)), false)
    assert.equal(missionTaskUnseen("persisted", "mission", task(101)), true, "later initial reads never cover unseen work")
    assert.equal(missionTaskUnseen("persisted", "mission", task(102)), false)
    assert.equal(missionTaskUnseen("persisted", "mission", task(103)), true, "a newer version needs acknowledgement")
    assert.equal(missionTaskUnseen("persisted", "all", task(105)), false)
    assert.equal(missionTaskUnseen("persisted", "all", task(106)), true)
    assert.equal(missionTaskUnseen("persisted", "all", task(200, "completed", "off-page")), false)
  })
} else {
  test("queries before the first observation neither seed nor freeze a mission watermark", () => {
    const before = storage.size
    assert.equal(missionTaskUnseen("initial", "mission", task(99)), false)
    markMissionTasksSeen("initial", "selected-early", [task(99, "running")])
    assert.equal(storage.size, before, "queries write no project boundary")
    seedMissionTasksSeen("initial", 100)
    assert.equal(missionTaskUnseen("initial", "mission", task(99)), false)
    assert.equal(missionTaskUnseen("initial", "mission", task(100)), false)
    assert.equal(missionTaskUnseen("initial", "selected-early", task(99)), false, "an early cached record adopts the boundary")
    assert.equal(missionTaskUnseen("initial", "mission", task(101)), true)
    seedMissionTasksSeen("initial", 200)
    assert.equal(missionTaskUnseen("initial", "mission", task(101)), true, "refresh never reseeds")
  })

  test("seeding notifies a query mounted before the initial observation", () => {
    createRoot(dispose => {
      try {
        const observed: boolean[] = []
        createComputed(() => { observed.push(missionTaskUnseen("reactive", "mission", task(101))) })
        seedMissionTasksSeen("reactive", 100)
        assert.deepEqual(observed, [false, true])
        markMissionTasksSeen("reactive", "mission", [task(101)])
        assert.deepEqual(observed, [false, true, false])
      } finally { dispose() }
    })
  })

  test("uses server timestamps even when the client clock is far ahead or behind", t => {
    for (const [scope, clientNow, serverNow] of [["ahead", 9_000_000, 100], ["behind", 100, 9_000_000]] as const) {
      t.mock.method(Date, "now", () => clientNow)
      seedMissionTasksSeen(scope, serverNow)
      assert.equal(missionTaskUnseen(scope, "mission", task(serverNow)), false)
      assert.equal(missionTaskUnseen(scope, "mission", task(serverNow + 1)), true)
    }
  })

  test("keeps the boundary and acknowledgements in memory when persistence is unavailable", () => {
    storageUnavailable = true
    try {
      seedMissionTasksSeen("memory", 100)
      assert.equal(missionTaskUnseen("memory", "first", task(100)), false)
      markMissionTasksSeen("memory", "first", [task(101)])
      seedMissionTasksSeen("memory", 999)
      assert.equal(missionTaskUnseen("memory", "first", task(101)), false)
      assert.equal(missionTaskUnseen("memory", "first", task(102)), true)
      assert.equal(missionTaskUnseen("memory", "later-loaded", task(100)), false)
      assert.equal(missionTaskUnseen("memory", "later-loaded", task(101)), true)
      markMissionTasksSeen("memory", "all", [task(105)], true)
      assert.equal(missionTaskUnseen("memory", "all", task(104)), false)
      assert.equal(missionTaskUnseen("memory", "all", task(106)), true)
    } finally { storageUnavailable = false }
  })

  test("selecting unfinished work never acknowledges its future completion", () => {
    seedMissionTasksSeen("unfinished", 100)
    for (const status of ["pending", "dispatched", "running", "blocked", "failed", "retired"]) {
      const pending = task(200, status, status)
      assert.equal(missionTaskUnseen("unfinished", "mission", pending), false)
      markMissionTasksSeen("unfinished", "mission", [pending])
      assert.equal(missionTaskUnseen("unfinished", "mission", { ...pending, status: "completed" }), true, status)
    }
    markMissionTasksSeen("unfinished", "all", [task(101), task(200, "running")], true)
    assert.equal(missionTaskUnseen("unfinished", "all", task(101)), false)
    assert.equal(missionTaskUnseen("unfinished", "all", task(102)), true, "unfinished timestamps cannot raise Mark as read")
    assert.equal(missionTaskUnseen("unfinished", "all", task(200)), true)
  })

  test("acknowledges only the selected version, mission and project", () => {
    seedMissionTasksSeen("versions", 100)
    seedMissionTasksSeen("other-project", 100)
    markMissionTasksSeen("versions", "mission", [task(101)])
    assert.equal(missionTaskUnseen("versions", "mission", task(101)), false)
    assert.equal(missionTaskUnseen("versions", "mission", task(102)), true)
    assert.equal(missionTaskUnseen("versions", "other-mission", task(101)), true)
    assert.equal(missionTaskUnseen("other-project", "mission", task(101)), true)
  })

  test("rejects invalid initial boundaries without consuming initialization", () => {
    for (const boundary of [NaN, Infinity, -1, 1.5]) seedMissionTasksSeen("invalid", boundary)
    seedMissionTasksSeen("invalid", 100)
    assert.equal(missionTaskUnseen("invalid", "mission", task(100)), false)
    assert.equal(missionTaskUnseen("invalid", "mission", task(101)), true)
  })

  test("Mark as read preserves individually seen off-page tasks above its watermark", () => {
    seedMissionTasksSeen("partial-map", 100)
    const offPage = task(200, "completed", "off-page")
    markMissionTasksSeen("partial-map", "mission", [offPage])
    for (const shown of [[task(105)], [task(105)], []]) {
      markMissionTasksSeen("partial-map", "mission", shown, true)
      assert.equal(missionTaskUnseen("partial-map", "mission", offPage), false)
      assert.equal(missionTaskUnseen("partial-map", "mission", task(105)), false)
      assert.equal(missionTaskUnseen("partial-map", "mission", task(106)), true, "unseen off-page work stays unseen")
    }
    assert.equal(missionTaskUnseen("partial-map", "mission", { ...offPage, updatedAt: 201 }), true)
  })

  test("hierarchy Mark as read covers off-page completions through the shown mission snapshot", () => {
    seedMissionTasksSeen("hierarchy", 100)
    markMissionTasksSeen("hierarchy", "mission", [task(105)], true, 200)
    assert.equal(missionTaskUnseen("hierarchy", "mission", task(199, "completed", "off-page")), false)
    assert.equal(missionTaskUnseen("hierarchy", "mission", task(201, "completed", "off-page")), true)
  })

  test("persists seen versions and the first project boundary across a fresh window", () => {
    seedMissionTasksSeen("persisted", 100)
    markMissionTasksSeen("persisted", "mission", [task(102)])
    markMissionTasksSeen("persisted", "all", [task(200, "completed", "off-page")])
    markMissionTasksSeen("persisted", "all", [task(105)], true)
    const { NODE_TEST_CONTEXT: _parent, ...env } = process.env
    const output = execFileSync(process.execPath, ["--conditions=browser", "--import", "tsx", fileURLToPath(import.meta.url)], {
      env: { ...env, MISSION_TASK_SEEN_STORAGE: JSON.stringify([...storage]) }, encoding: "utf8", windowsHide: true,
    })
    assert.match(output, /pass 1\b/)
    assert.match(output, /fail 0\b/)
  })
}
