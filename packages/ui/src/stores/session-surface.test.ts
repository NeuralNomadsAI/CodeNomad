import assert from "node:assert/strict"
import { it } from "node:test"
import { activateSessionSurface as commitSurface, captureSessionSurfaceIntent, getSessionSurface, type CentralSurface, type SurfaceContext } from "./session-surface"
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
import { removeSessionRuntimeState } from "./session-api"
import { addInstance, removeInstance } from "./instances"
import { captureState } from "../lib/hooks/use-app-session-capture"
import { attachInstanceTabMembership, detachInstanceTabMembership } from "./app-tab-membership"

const ctx = (instanceId: string) => ({ instanceId, sessionId: "same" })
function activateSessionSurface(context: SurfaceContext, surface: CentralSurface) {
  const intent = captureSessionSurfaceIntent(context)
  try { commitSurface(context, surface, intent) }
  finally { intent.release() }
}
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
    activateSessionSurface(ctx("matrix-b"), from)
    activateSessionSurface(ctx("matrix-a"), from)
    activateSessionSurface(ctx("matrix-a"), to)
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
      activateSessionSurface(ctx(id), surface)
      resolve({ sessionId: "same", token: id, targetUrl: "https://example.com/" })
      await assert.rejects(pending, { name: "AbortError" })
      assert.deepEqual(getSessionSurface(ctx(id)), surface)
      assert.equal(getSessionPreview("same", id), null)
      lifecycle(id, "removed")
    }
    assert.deepEqual(deleted, ["delay-conversation", "delay-file", "delay-mission"])
  } finally { serverApi.createPreview = create; serverApi.deletePreview = remove }
})

it("unavailability and removal invalidate only their own activation, retaining unavailable restoration", () => {
  for (const type of ["unavailable", "removed"] as const) {
    lifecycle("lifetime-a", "opened"); lifecycle("lifetime-b", "opened")
    activateSessionSurface(ctx("lifetime-a"), surfaces[3])
    activateSessionSurface(ctx("lifetime-b"), surfaces[2])
    const a = captureSessionSurfaceIntent(ctx("lifetime-a")), b = captureSessionSurfaceIntent(ctx("lifetime-b"))
    lifecycle("lifetime-a", type)
    assert.equal(a.current(), false); assert.equal(b.current(), true)
    assert.equal(getSessionSurface(ctx("lifetime-a")).kind, type === "removed" ? "conversation" : "mission")
    assert.equal(getSessionSurface(ctx("lifetime-b")).kind, "file")
    b.release()
    lifecycle("lifetime-a", "removed"); lifecycle("lifetime-b", "removed")
  }
})

it("schedule and playbook readers activate without a fabricated conversation", () => {
  const context = { instanceId: "no-conversation", sessionId: null }
  lifecycle(context.instanceId, "opened")
  for (const target of [
    { kind: "recurrence" as const, missionId: "schedule", instanceId: context.instanceId, projectID: "project" },
    { kind: "playbook" as const, missionId: "debug" },
  ]) {
    activateSessionSurface(context, { kind: "mission", target })
    assert.equal(getTabViewState(context.instanceId).missions?.reader, target)
    assert.deepEqual(getSessionSurface(context), { kind: "mission", target })
  }
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
})) it(`passive ${name} selection yields to an admitted surface gesture`, () => {
  const id = `passive-selection-${name}`
  lifecycle(id, "opened")
  setSessions(previous => new Map(previous).set(id, new Map([["next", { id: "next", parentId: null } as any]])))
  setActiveSessionId(previous => new Map(previous).set(id, "same"))
  const intent = captureSessionSurfaceIntent(ctx(id))
  reconcile(id)
  assert.equal(intent.current(), true)
  assert.equal(activeSessionId().get(id), "same")
  intent.release()
  assert.equal(activeSessionId().get(id), name.startsWith("clear") ? undefined : "next")
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
  const pending = openMissionTask(id, "/repo", () => value, "task-key", undefined, store)
  updateTabViewState(id, { filesMode: "changes", rightPanelTab: "files" })
  assert.equal(missionProjectView(id), before)
  assert.equal(missionProjectView(id).reader, reader)
  assert.equal(missionProjectView(id).selectedTask, before.selectedTask)
  resolve(); await pending
  assert.equal(missionProjectView(id).reader?.itemId, "task-id")
  lifecycle(id, "removed")
})

for (const order of [["parent", "child"], ["child", "parent"]]) it(`deferred deletion reconciles the whole selection and persisted capture (${order.join(", ")})`, () => {
  const id = `deleted-selection-${order.join("-")}`
  addInstance({ id, folder: "/repo", port: 0, pid: 0, proxyPath: "", status: "ready", client: null })
  attachInstanceTabMembership(id)
  const parent = { id: "parent", parentId: null } as any
  const child = { id: "child", parentId: "parent" } as any
  setSessions(previous => new Map(previous).set(id, new Map([["parent", parent], ["child", child]])))
  setActiveParentSession(id, "parent")
  setActiveSession(id, "child")
  const intent = captureSessionSurfaceIntent({ instanceId: id, sessionId: "child" })
  try {
    for (const sessionId of order) removeSessionRuntimeState(id, sessionId)
    assert.equal(activeParentSessionId().get(id), "parent")
    assert.equal(activeSessionId().get(id), "child")
    intent.release()
    const captured = captureState(new Map()).state.tabs.find(tab => tab.kind === "workspace" && tab.folder === "/repo")
    assert.ok(captured?.kind === "workspace")
    assert.deepEqual([captured.activeParentSessionId, captured.activeSessionId], [undefined, undefined],
      "the saved window must not retain a deleted parent or child")
    assert.deepEqual([activeParentSessionId().get(id), activeSessionId().get(id)], [undefined, undefined])
    assert.equal(sessions().get(id), undefined)
  } finally { intent.release(); detachInstanceTabMembership(id); removeInstance(id) }
})

it("deferred hydration resolves against the current inventory and binding", () => {
  for (const invalidation of ["inventory", "binding"]) {
    const id = `hydration-${invalidation}`
    lifecycle(id, "opened")
    setSessions(previous => new Map(previous).set(id, new Map([["parent", { id: "parent", parentId: null } as any]])))
    let current = true
    const intent = captureSessionSurfaceIntent({ instanceId: id, sessionId: null })
    hydrateActiveSessionSelection(id, "parent", "parent", () => current)
    if (invalidation === "inventory") setSessions(previous => { const next = new Map(previous); next.delete(id); return next })
    else current = false
    intent.release()
    assert.deepEqual([activeParentSessionId().get(id), activeSessionId().get(id)], [undefined, undefined])
    lifecycle(id, "removed")
  }
})
