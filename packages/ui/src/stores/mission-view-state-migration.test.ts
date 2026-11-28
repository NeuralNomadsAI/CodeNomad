import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

const mode = process.env.MISSION_MIGRATION_MODE
if (!mode) {
  for (const mode of ["native", "native-with-preview", "web"]) test(`${mode} restores dev Mission layout into occurrence views`, () => {
    const { NODE_TEST_CONTEXT: _, ...env } = process.env
    const output = execFileSync(process.execPath, ["--import", "tsx", "--test", fileURLToPath(import.meta.url)],
      { env: { ...env, MISSION_MIGRATION_MODE: mode }, encoding: "utf8", windowsHide: true })
    assert.match(output, /pass 4\b/)
    assert.match(output, /fail 0\b/)
  })
} else {
  const native = mode !== "web"
  // Literal keys/values written by dev's folder/mission/section hashing and +/- codec.
  const projectKey = "mission-project-HhdJiAYMjxA", disclosureKey = "mission-disclosures-E9x1_W9tWRE"
  const legacy = { selected: "legacy-mission", selectedRecurrence: "daily", selectedScheduled: "scheduled",
    selectedTask: { missionId: "legacy-mission", taskId: "task" }, expanded: ["mission:legacy-mission"],
    reader: { missionId: "legacy-mission", kind: "report" as const, itemId: "report" } }
  const layout = { [projectKey]: JSON.stringify(legacy), [disclosureKey]: "-q1aEyLZiDLY,+yH2N9QrcmKE",
    "mission-project-vo6-9pq1uzw": JSON.stringify(legacy),
    ...(mode === "native-with-preview" ? {
      "opencode-session-previews-v1": JSON.stringify({ "/same": { mode: "preview", targetUrl: "https://example.com/" } }),
    } : {}) }
  const values = new Map<string, string>(Object.entries(native ? {} : layout))
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => values.delete(key),
    get length() { return values.size }, key: (index: number) => [...values.keys()][index] ?? null }
  const workspace = (folder: string, occurrence: number, viewState?: { version: 1 }) => ({
    kind: "workspace" as const, folder, occurrence, activeSessionId: "session", drafts: {}, attachments: {},
    scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {}, ...(viewState ? { viewState } : {}),
  })
  let failSave = true
  const concurrent = JSON.stringify({ selected: "concurrent" })
  const saved: any[] = []
  Object.assign(globalThis, { window: { localStorage: storage,
    ...(native ? { __CODENOMAD_RUNTIME_HOST__: "electron", __CODENOMAD_WINDOW_CONTEXT__: "local",
      electronAPI: { claimClientStateAccess: async () => true,
        loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: { version: 1, revision: 1, savedAt: 1,
          layout, session: { activeTabIndex: 0, tabs: [workspace("/same", 1), workspace("/same", 0),
            workspace("/explicit", 0, { version: 1 }), workspace("/explicit", 1)] } } }),
        saveClientState: async (_token: string, value: unknown) => {
          if (failSave) throw new Error("publication failed")
          if (!saved.length) storage.setItem("mission-project-vo6-9pq1uzw", concurrent)
          saved.push(value); return true
        } } } : { __CODENOMAD_RUNTIME_HOST__: "web" }) } })
  if (mode === "web") storage.setItem("opencode-session-tab-views-v1", JSON.stringify({ '["/explicit",0]': { version: 1 } }))
  const state = await import("./client-state")
  await state.initializeClientState()
  assert.equal(state.readClientLayoutValue(projectKey), JSON.stringify(legacy))
  const { seedTabViewState, getTabViewState } = await import("./tab-view-state")
  const { publishInstanceLifecycleAuthority } = await import("./instance-lifecycle-authority")
  const { missionProjectView, missionDisclosureOpen, setMissionDisclosureOpen } = await import("./mission-view-state")
  const ids = ["first", "second", "explicit", "explicit-second"]
  if (native) state.loadedRestorableSession()!.tabs.forEach((tab, index) => {
    if (tab.kind === "workspace") seedTabViewState(ids[index], tab.viewState)
  })
  else ids.forEach((instanceId, index) => publishInstanceLifecycleAuthority({ type: "opened", instanceId,
    folder: index < 2 ? "/same" : "/explicit", occurrence: index % 2 }))

  test("restores selection, tree and reader, without a schedule's selection", () => {
    const { selectedRecurrence: _daily, selectedScheduled: _scheduled, ...restored } = legacy
    assert.deepEqual(missionProjectView("first"), restored)
    if (mode === "native-with-preview") {
      assert.equal(getTabViewState("first").previews?.session.mode, "preview")
      assert.equal(JSON.parse(state.readClientLayoutValue("opencode-session-browser-state-v1")!).session.targetUrl, "https://example.com/")
    }
  })
  test("keeps saved closed/open disclosures readable and gives occurrence rewrites precedence", () => {
    assert.equal(missionDisclosureOpen("first", "legacy-mission", "technical"), false)
    assert.equal(missionDisclosureOpen("first", "legacy-mission", "other", false), true)
    setMissionDisclosureOpen("first", "legacy-mission", "technical", true)
    assert.equal(missionDisclosureOpen("first", "legacy-mission", "technical"), true)
    assert.equal(missionDisclosureOpen("second", "legacy-mission", "technical"), false)
  })
  test("descriptor/open order adopts project state once and an explicit versioned envelope wins", () => {
    assert.deepEqual(missionProjectView("second"), {})
    assert.deepEqual(missionProjectView("explicit"), {})
    assert.deepEqual(missionProjectView("explicit-second"), {})
  })
  test("publishes migrated views before retiring their source and preserves disclosure fallback", async () => {
    if (native) {
      await assert.rejects(state.flushClientState(), /publication failed/)
      assert.equal(state.readClientLayoutValue(projectKey), JSON.stringify(legacy))
      failSave = false
      await state.flushClientState()
      assert.equal(saved.at(-1).session.tabs[0].viewState.missions.selected, "legacy-mission")
      assert.equal(state.readClientLayoutValue(projectKey), null)
      assert.equal(state.readClientLayoutValue("mission-project-vo6-9pq1uzw"), concurrent)
      assert.equal(saved.at(-1).layout["mission-project-vo6-9pq1uzw"], concurrent)
    } else {
      const restored = JSON.parse(storage.getItem("opencode-session-tab-views-v1")!)
      assert.equal(restored['["/same",0]'].missions.selected, "legacy-mission")
      assert.equal(state.readClientLayoutValue(projectKey), null)
    }
    assert.equal(state.readClientLayoutValue(disclosureKey), layout[disclosureKey])
  })
}
