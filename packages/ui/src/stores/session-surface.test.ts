import assert from "node:assert/strict"
import { it } from "node:test"
import { applySurface, beginGesture, getSessionSurface, type CentralSurface } from "./session-surface"
import { publishInstanceLifecycleAuthority } from "./instance-lifecycle-authority"
import { getTabViewState, seedTabViewState, updateTabViewState } from "./tab-view-state"
import { getSessionPreview, openSessionPreview } from "./session-previews"
import { serverApi } from "../lib/api-client"
import { openMissionTask } from "../components/mission-task-open"
import { missionProjectView, updateMissionProjectView } from "./mission-view-state"
import { clearActiveParentSession, clearActiveSession, hydrateActiveSessionSelection, seedRestoredSessionSelection,
  setActiveParentSession, setActiveSession, setActiveSessionFromList, setSessions } from "./session-state"
import { activeSessionId, setActiveSessionId } from "./session-selection-state"
import { activeParentSessionId, sessions } from "./session-state"
import { removeSessionProjection, removeSessionRuntimeState } from "./session-api"
import { addInstance, removeInstance } from "./instances"
import { captureState } from "../lib/hooks/use-app-session-capture"
import { attachInstanceTabMembership, detachInstanceTabMembership } from "./app-tab-membership"

const ctx = (instanceId: string) => ({ instanceId, sessionId: "same" })
const lifecycle = (instanceId: string, type: "opened" | "removed" | "unavailable") =>
  publishInstanceLifecycleAuthority({ type, instanceId, folder: "/repo", occurrence: 0 })
const surfaces: CentralSurface[] = [
  { kind: "conversation" }, { kind: "web", sessionId: "same" },
  { kind: "file", target: { sessionId: "same", directory: "/repo", slug: "root", path: "a.ts" } },
  { kind: "mission", target: { missionId: "mission", kind: "overview" } },
]

it("every central surface replaces every other, independently of duplicate occurrences", () => {
  for (const id of ["matrix-a", "matrix-b"]) {
    lifecycle(id, "opened")
    seedTabViewState(id, { version: 1, previews: { same: { mode: "chat", targetUrl: "https://example.com/" } } })
  }
  for (const from of surfaces) for (const to of surfaces) {
    applySurface(ctx("matrix-b"), from)
    applySurface(ctx("matrix-a"), from)
    applySurface(ctx("matrix-a"), to)
    assert.deepEqual(getSessionSurface(ctx("matrix-a")), to)
    assert.deepEqual(getSessionSurface(ctx("matrix-b")), from)
    if ("target" in to) assert.equal((getSessionSurface(ctx("matrix-a")) as typeof to).target, to.target)
    updateMissionProjectView("matrix-a", { selected: "unrelated-selection", reader: to.kind === "mission" ? to.target : undefined })
    assert.deepEqual(getSessionSurface(ctx("matrix-a")), to, "selection bookkeeping preserves the foreground target")
  }
  lifecycle("matrix-a", "removed"); lifecycle("matrix-b", "removed")
})

it("a delayed browser releases only its token after a file, Mission or conversation gesture", async () => {
  const create = serverApi.createPreview, remove = serverApi.deletePreview
  const deleted: string[] = []
  serverApi.deletePreview = async token => { deleted.push(token) }
  try {
    for (const surface of surfaces.filter(value => value.kind !== "web")) {
      const id = `delay-${surface.kind}`
      lifecycle(id, "opened")
      let resolve!: (value: any) => void
      serverApi.createPreview = () => new Promise(done => { resolve = done })
      const pending = openSessionPreview("same", "https://example.com/", id)
      applySurface(ctx(id), surface)
      resolve({ sessionId: "same", token: id, targetUrl: "https://example.com/" })
      await assert.rejects(pending, { name: "AbortError" })
      assert.deepEqual(getSessionSurface(ctx(id)), surface)
      assert.equal(getSessionPreview("same"), null)
      lifecycle(id, "removed")
    }
    assert.deepEqual(deleted, ["delay-conversation", "delay-file", "delay-mission"])
  } finally { serverApi.createPreview = create; serverApi.deletePreview = remove }
})

it("unavailability and removal invalidate only their own activation, retaining unavailable restoration", () => {
  for (const type of ["unavailable", "removed"] as const) {
    lifecycle("lifetime-a", "opened"); lifecycle("lifetime-b", "opened")
    applySurface(ctx("lifetime-a"), surfaces[3])
    applySurface(ctx("lifetime-b"), surfaces[2])
    const a = beginGesture(ctx("lifetime-a")), b = beginGesture(ctx("lifetime-b"))
    lifecycle("lifetime-a", type)
    assert.equal(a.current(), false); assert.equal(b.current(), true)
    assert.equal(getSessionSurface(ctx("lifetime-a")).kind, type === "removed" ? "conversation" : "mission")
    assert.equal(getSessionSurface(ctx("lifetime-b")).kind, "file")
    lifecycle("lifetime-a", "removed"); lifecycle("lifetime-b", "removed")
  }
})

it("a playbook reader activates without a fabricated conversation", () => {
  const context = { instanceId: "no-conversation", sessionId: null }
  lifecycle(context.instanceId, "opened")
  const target = { kind: "playbook" as const, missionId: "debug" }
  applySurface(context, { kind: "mission", target })
  assert.equal(getTabViewState(context.instanceId).missions?.reader, target)
  assert.deepEqual(getSessionSurface(context), { kind: "mission", target })
  lifecycle(context.instanceId, "removed")
})

for (const [name, reconcile] of Object.entries({
  conversation: (id: string) => setActiveSession(id, "next"),
  parent: (id: string) => setActiveParentSession(id, "next"),
  list: (id: string) => setActiveSessionFromList(id, "next"),
  clearParent: clearActiveParentSession,
  clearConversation: clearActiveSession,
  hydrate: (id: string) => hydrateActiveSessionSelection(id, "next", "next"),
  seed: (id: string) => seedRestoredSessionSelection(id, "next", "next"),
})) it(`passive ${name} selection applies immediately without cancelling an admitted gesture`, () => {
  const id = `passive-selection-${name}`
  lifecycle(id, "opened")
  setSessions(previous => new Map(previous).set(id, new Map([["next", { id: "next", parentId: null } as any]])))
  setActiveSessionId(previous => new Map(previous).set(id, "same"))
  const intent = beginGesture(ctx(id))
  reconcile(id)
  assert.equal(intent.current(), true)
  assert.equal(activeSessionId().get(id), name.startsWith("clear") ? undefined : "next")
  setActiveSession(id, "same", intent)
  assert.equal(activeSessionId().get(id), "same", "the current gesture adopts over passive selection")
  lifecycle(id, "removed")
})

it("unrelated envelope updates preserve live Mission identities and an in-flight task open", async () => {
  const id = "task-identity", reader = { missionId: "mission", kind: "overview" as const }
  lifecycle(id, "opened")
  updateMissionProjectView(id, { selectedTask: { missionId: "mission", taskId: "old" }, reader })
  const before = missionProjectView(id)
  let resolve!: () => void
  const value: any = { id: "mission", projectID: "project", tasks: [], taskPage: {} }
  const store: any = { loadTasks: () => new Promise<void>(done => { resolve = () => {
    value.tasks.push({ id: "task-id", key: "task-key", state: "ready" }); done()
  } }) }
  const pending = openMissionTask(id, "/repo", () => value, "task-key", store)
  updateTabViewState(id, { filesMode: "changes", rightPanelTab: "files" })
  assert.equal(missionProjectView(id), before)
  assert.equal(missionProjectView(id).reader, reader)
  assert.equal(missionProjectView(id).selectedTask, before.selectedTask)
  resolve(); await pending
  assert.equal(missionProjectView(id).reader?.itemId, "task-id")
  lifecycle(id, "removed")
})

for (const order of [["parent", "child"], ["child", "parent"]]) it(`passive deletion reconciles the whole selection and persisted capture immediately (${order.join(", ")})`, () => {
  const id = `deleted-selection-${order.join("-")}`
  addInstance({ id, folder: "/repo", port: 0, pid: 0, proxyPath: "", status: "ready", client: null })
  attachInstanceTabMembership(id)
  const parent = { id: "parent", parentId: null } as any
  const child = { id: "child", parentId: "parent" } as any
  setSessions(previous => new Map(previous).set(id, new Map([["parent", parent], ["child", child]])))
  setActiveParentSession(id, "parent")
  setActiveSession(id, "child")
  const intent = beginGesture({ instanceId: id, sessionId: "child" })
  try {
    for (const sessionId of order) removeSessionRuntimeState(id, sessionId)
    assert.equal(intent.current(), true)
    const captured = captureState(new Map()).state.tabs.find(tab => tab.kind === "workspace" && tab.folder === "/repo")
    assert.ok(captured?.kind === "workspace")
    assert.deepEqual([captured.activeParentSessionId, captured.activeSessionId], [undefined, undefined],
      "the saved window must not retain a deleted parent or child")
    assert.deepEqual([activeParentSessionId().get(id), activeSessionId().get(id)], [undefined, undefined])
    assert.equal(sessions().get(id), undefined)
  } finally { detachInstanceTabMembership(id); removeInstance(id) }
})

it("hydration resolves against its current inventory and binding", () => {
  for (const invalidation of ["inventory", "binding"]) {
    const id = `hydration-${invalidation}`
    lifecycle(id, "opened")
    setSessions(previous => new Map(previous).set(id, new Map([["parent", { id: "parent", parentId: null } as any]])))
    let current = true
    const intent = beginGesture({ instanceId: id, sessionId: null })
    if (invalidation === "inventory") setSessions(previous => { const next = new Map(previous); next.delete(id); return next })
    else current = false
    hydrateActiveSessionSelection(id, "parent", "parent", () => current)
    assert.equal(intent.current(), true)
    assert.deepEqual([activeParentSessionId().get(id), activeSessionId().get(id)], [undefined, undefined])
    lifecycle(id, "removed")
  }
})

it("deletion preserves an unrelated unavailable selection and later recovery can select the returned runtime", () => {
  const id = "deletion-selection-fences"
  lifecycle(id, "opened")
  setActiveParentSession(id, "unavailable")
  setActiveSession(id, "unavailable-child")
  const unrelated = beginGesture({ instanceId: id, sessionId: "unavailable-child" })
  removeSessionRuntimeState(id, "unrelated")
  assert.equal(unrelated.current(), true)
  assert.deepEqual([activeParentSessionId().get(id), activeSessionId().get(id)], ["unavailable", "unavailable-child"])
  const recovery = beginGesture({ instanceId: id, sessionId: "unavailable-child" })
  removeSessionProjection(id, "unavailable-child")
  assert.equal(activeSessionId().get(id), undefined)
  setSessions(previous => new Map(previous).set(id, new Map([["unavailable-child", { id: "unavailable-child" } as any]])))
  setActiveSessionFromList(id, "unavailable-child", recovery)
  assert.equal(activeSessionId().get(id), "unavailable-child")
  lifecycle(id, "removed")
})

for (const removed of ["parent", "child"]) it(`restoration seeds honor the ${removed} deletion tombstone`, () => {
  const id = `seed-deletion-${removed}`
  lifecycle(id, "opened")
  setSessions(previous => new Map(previous).set(id, new Map([
    ["parent", { id: "parent", parentId: null } as any], ["child", { id: "child", parentId: "parent" } as any],
  ])))
  removeSessionRuntimeState(id, removed)
  seedRestoredSessionSelection(id, "parent", "child")
  const expected = removed === "parent" ? undefined : "parent"
  assert.deepEqual([activeParentSessionId().get(id), activeSessionId().get(id)], [expected, expected])
  lifecycle(id, "removed")
})
