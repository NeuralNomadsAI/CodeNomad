import assert from "node:assert/strict"
import { it } from "node:test"
import { activateSessionSurface, captureSessionSurfaceIntent, getSessionSurface, type CentralSurface } from "./session-surface"
import { publishInstanceLifecycleAuthority } from "./instance-lifecycle-authority"
import { getTabViewState, seedTabViewState, updateTabViewState } from "./tab-view-state"
import { getSessionPreview, openSessionPreview } from "./session-previews"
import { serverApi } from "../lib/api-client"
import { openMissionTask } from "../components/mission-task-open"
import { missionProjectView, updateMissionProjectView } from "./mission-view-state"

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
