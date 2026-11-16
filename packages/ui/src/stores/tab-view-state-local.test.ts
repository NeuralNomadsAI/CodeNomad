import assert from "node:assert/strict"
import { test } from "node:test"

const values = new Map<string, string>()
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value) },
  removeItem: (key: string) => { values.delete(key) },
  get length() { return values.size },
  key: (index: number) => [...values.keys()][index] ?? null,
}
Object.assign(globalThis, { window: { localStorage: storage, __CODENOMAD_RUNTIME_HOST__: "electron",
  __CODENOMAD_WINDOW_CONTEXT__: "local", electronAPI: {
    claimClientStateAccess: async () => false,
  } } })
const { initializeClientState, clientStateIsPrimary } = await import("./client-state")
await initializeClientState()
const { bindLocalTabView, saveLocalTabView, unbindLocalTabView, adoptLocalLegacyPreview } = await import("./tab-view-state-local")
const { compactMissionKey } = await import("./tab-view-state-migration")
const key = "opencode-session-tab-views-v1"
const view = (selected: string) => ({ version: 1 as const, missions: { selected } })

test("nonprimary local layout keeps compatible local keys and independent remote occurrence inventories", () => {
  assert.equal(clientStateIsPrimary(), false)
  storage.setItem(key, JSON.stringify({
    '["c:/same",0]': view("local"),
    '["ServerA~c:/same",0]': view("remote-a"),
    '["ServerA~c:/same",1]': view("remote-a-sibling"),
    '["servera~c:/same",0]': view("remote-case"),
  }))
  assert.deepEqual(bindLocalTabView("local", "C:/Same"), view("local"))
  assert.deepEqual(bindLocalTabView("ServerA~first", "C:\\Same"), view("remote-a"))
  assert.deepEqual(bindLocalTabView("ServerA~second", "c:/same/"), view("remote-a-sibling"))
  assert.deepEqual(bindLocalTabView("servera~first", "C:/Same"), view("remote-case"))
  saveLocalTabView("ServerA~second", view("changed"))
  unbindLocalTabView("ServerA~first")
  const saved = JSON.parse(storage.getItem(key)!)
  assert.deepEqual(saved['["ServerA~c:/same",0]'], view("changed"))
  assert.deepEqual(saved['["c:/same",0]'], view("local"))
  assert.deepEqual(saved['["servera~c:/same",0]'], view("remote-case"))
  assert.deepEqual(bindLocalTabView("ServerA~third", "C:/Same"), undefined)
  for (const id of ["local", "ServerA~second", "servera~first", "ServerA~third"]) unbindLocalTabView(id)
})

test("legacy local layout imports only the exact backend's preview and Mission scope", () => {
  storage.setItem(key, "{}")
  storage.setItem(`mission-project-${compactMissionKey("C:/Repo")}`, JSON.stringify({ selected: "local-only" }))
  storage.setItem(`mission-project-${compactMissionKey("ServerA~C:/Repo")}`, JSON.stringify({ selected: "remote-only" }))
  assert.deepEqual(bindLocalTabView("ServerA~legacy", "C:/Repo"), view("remote-only"))
  assert.deepEqual(bindLocalTabView("servera~legacy", "C:/Repo"), undefined)
  assert.deepEqual(bindLocalTabView("local-legacy", "C:/Repo"), view("local-only"))
  storage.setItem("opencode-session-previews-v1", JSON.stringify({
    [JSON.stringify(["ServerA~c:\\repo", "session"])]: { targetUrl: "https://remote.test/", mode: "preview" },
    [JSON.stringify(["C:/Repo", "session"])]: { targetUrl: "https://local.test/", mode: "preview" },
    "C:/Repo": { targetUrl: "https://local-project.test/", mode: "preview" },
  }))
  assert.equal(adoptLocalLegacyPreview("ServerA~legacy", "session")?.view.previews?.session.targetUrl, "https://remote.test/")
  assert.equal(adoptLocalLegacyPreview("local-legacy", "session")?.view.previews?.session.targetUrl, "https://local.test/")
  assert.equal(adoptLocalLegacyPreview("servera~legacy", "session"), undefined)
  assert.equal(adoptLocalLegacyPreview("ServerA~legacy", "other"), undefined)
  for (const id of ["ServerA~legacy", "servera~legacy", "local-legacy"]) unbindLocalTabView(id)
})
