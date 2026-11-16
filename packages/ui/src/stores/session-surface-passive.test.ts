import assert from "node:assert/strict"
import { test } from "node:test"
import { applySurface, beginGesture, getSessionSurface } from "./session-surface"
import { forgetMissionView, missionProjectView, retargetMissionReader, updateMissionProjectView } from "./mission-view-state"
import { publishInstanceLifecycleAuthority } from "./instance-lifecycle-authority"
import { getTabViewState, seedTabViewState } from "./tab-view-state"
import { restoreSessionPreview } from "./session-previews"
import { serverApi } from "../lib/api-client"
import { getFilePreview, openFilePreview, reconcileFilePreview, reconcileFilePreviewLifetime } from "./files-preview"

const reader = { missionId: "mission", kind: "overview" as const }
const lifecycle = (instanceId: string, type: "opened" | "removed") =>
  publishInstanceLifecycleAuthority({ type, instanceId, folder: "/repo", occurrence: 0 })

for (const [name, reconcile] of Object.entries({
  "Mission inventory cleanup": (id: string) => updateMissionProjectView(id, { reader: undefined }),
  "Mission removal": (id: string) => forgetMissionView(id, "mission"),
  "Mission passage retarget": (id: string) => retargetMissionReader(id, reader, { ...reader, missionId: "next" }),
})) test(`passive ${name} applies immediately and preserves an admitted gesture`, () => {
  const instanceId = `passive-${name}`, ctx = { instanceId, sessionId: "same" }
  lifecycle(instanceId, "opened")
  applySurface(ctx, { kind: "mission", target: reader })
  const gesture = beginGesture(ctx)
  reconcile(instanceId)
  assert.equal(gesture.current(), true)
  assert.equal(missionProjectView(instanceId).reader?.missionId, name === "Mission passage retarget" ? "next" : undefined)
  applySurface(ctx, { kind: "mission", target: reader }, gesture)
  assert.equal(missionProjectView(instanceId).reader, reader, "the still-current gesture adopts after passive reconciliation")
  lifecycle(instanceId, "removed")
})

test("passive file status and lifetime cleanup apply immediately before gesture adoption", () => {
  const instanceId = "passive-file", ctx = { instanceId, sessionId: "same" }
  const target = { sessionId: "same", path: "a", slug: "root", directory: "/repo" }
  lifecycle(instanceId, "opened")
  seedTabViewState(instanceId, { version: 1, previews: { same: { mode: "chat", targetUrl: "https://example.com" } } })
  openFilePreview(instanceId, target)
  const gesture = beginGesture(ctx)
  const updated = { ...target, scope: "staged" as const }
  reconcileFilePreview(instanceId, target, updated)
  assert.equal(getFilePreview(instanceId), updated)
  reconcileFilePreviewLifetime(instanceId)
  assert.equal(getFilePreview(instanceId), null)
  assert.equal(gesture.current(), true)
  applySurface(ctx, { kind: "web", sessionId: "same" }, gesture)
  reconcileFilePreview(instanceId, updated, target)
  assert.equal(getSessionSurface(ctx).kind, "web", "old file cleanup preserves another foreground feature")
  lifecycle(instanceId, "removed")
})

test("passive browser resource restoration preserves foreground generation and saved mode", async () => {
  const instanceId = "passive-restore", ctx = { instanceId, sessionId: "same" }
  lifecycle(instanceId, "opened")
  seedTabViewState(instanceId, { version: 1, previews: { same: { mode: "chat", targetUrl: "https://example.com" } } })
  const create = serverApi.createPreview, remove = serverApi.deletePreview
  let resolve!: (value: any) => void
  serverApi.createPreview = () => new Promise(done => { resolve = done })
  serverApi.deletePreview = async () => {}
  const gesture = beginGesture(ctx)
  try {
    const restoring = restoreSessionPreview("same", instanceId)
    assert.equal(gesture.current(), true)
    resolve({ token: "restored", sessionId: "same", targetUrl: "https://example.com" })
    await restoring
    assert.equal(gesture.current(), true)
    assert.equal(getTabViewState(instanceId).previews?.same.mode, "chat")
    applySurface(ctx, { kind: "mission", target: reader }, gesture)
    assert.equal(missionProjectView(instanceId).reader, reader)
  } finally {
    lifecycle(instanceId, "removed")
    serverApi.createPreview = create; serverApi.deletePreview = remove
  }
})
