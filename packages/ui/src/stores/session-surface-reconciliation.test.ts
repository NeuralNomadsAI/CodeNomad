import assert from "node:assert/strict"
import { test } from "node:test"
import { activateSessionSurface as commitSurface, captureSessionSurfaceIntent, getSessionSurface, type CentralSurface, type SurfaceContext } from "./session-surface"
import { forgetMissionView, missionProjectView, retargetMissionReader, updateMissionProjectView } from "./mission-view-state"
import { publishInstanceLifecycleAuthority } from "./instance-lifecycle-authority"
import { activeSessionId, setActiveSessionId } from "./session-selection-state"
import { getTabViewState, seedTabViewState } from "./tab-view-state"
import { restoreSessionPreview } from "./session-previews"
import { serverApi } from "../lib/api-client"
import * as filePreviews from "./files-preview"

const reader = { missionId: "mission", kind: "overview" as const }
function activateSessionSurface(ctx: SurfaceContext, surface: CentralSurface) {
  const intent = captureSessionSurfaceIntent(ctx)
  try { commitSurface(ctx, surface, intent) }
  finally { intent.release() }
}
const passive = {
  "Mission inventory cleanup": (id: string) => updateMissionProjectView(id, { reader: undefined }),
  "Mission removal": (id: string) => forgetMissionView(id, "mission"),
  "Mission passage retarget": (id: string) => retargetMissionReader(id, reader, { ...reader, missionId: "next" }),
}

for (const [name, reconcile] of Object.entries(passive)) test(`passive ${name} yields to an admitted surface gesture`, () => {
  const instanceId = `passive-${name}`, ctx = { instanceId, sessionId: "same" }
  publishInstanceLifecycleAuthority({ type: "opened", instanceId, folder: "/repo", occurrence: 0 })
  setActiveSessionId(previous => new Map(previous).set(instanceId, "same"))
  activateSessionSurface(ctx, { kind: "mission", target: reader })
  const intent = captureSessionSurfaceIntent(ctx)
  try {
    reconcile(instanceId)
    assert.equal(intent.current(), true, `${name} must never advance foreground authority`)
    assert.equal(missionProjectView(instanceId).reader, reader)
    assert.equal(activeSessionId().get(instanceId), "same")
  } finally { intent.release() }
  if (name === "Mission inventory cleanup" || name === "Mission removal") assert.equal(missionProjectView(instanceId).reader, undefined)
  if (name === "Mission passage retarget") assert.equal(missionProjectView(instanceId).reader?.missionId, "next")
  publishInstanceLifecycleAuthority({ type: "removed", instanceId, folder: "/repo", occurrence: 0 })
})

test("passive file lifetime cleanup settles without changing a newer browser surface", () => {
  const instanceId = "passive-file", ctx = { instanceId, sessionId: "same" }
  publishInstanceLifecycleAuthority({ type: "opened", instanceId, folder: "/repo", occurrence: 0 })
  seedTabViewState(instanceId, { version: 1, previews: { same: { mode: "chat", targetUrl: "https://example.com" } } })
  activateSessionSurface(ctx, { kind: "file", target: { sessionId: "same", path: "a", slug: "root", directory: "/repo" } })
  const intent = captureSessionSurfaceIntent(ctx)
  filePreviews.reconcileFilePreviewLifetime(instanceId)
  assert.equal(intent.current(), true)
  assert.equal(getSessionSurface(ctx).kind, "file")
  commitSurface(ctx, { kind: "web", sessionId: "same" }, intent)
  intent.release()
  assert.equal(getSessionSurface(ctx).kind, "web")
  publishInstanceLifecycleAuthority({ type: "removed", instanceId, folder: "/repo", occurrence: 0 })
})

test("passive browser resource restoration leaves a foreground intent current", async () => {
  const instanceId = "passive-restore", ctx = { instanceId, sessionId: "same" }
  publishInstanceLifecycleAuthority({ type: "opened", instanceId, folder: "/repo", occurrence: 0 })
  seedTabViewState(instanceId, { version: 1, previews: { same: { mode: "chat", targetUrl: "https://example.com" } } })
  const create = serverApi.createPreview, remove = serverApi.deletePreview
  let resolve!: (value: any) => void
  serverApi.createPreview = () => new Promise(done => { resolve = done })
  serverApi.deletePreview = async () => {}
  const intent = captureSessionSurfaceIntent(ctx)
  try {
    const restoring = restoreSessionPreview("same", instanceId)
    assert.equal(intent.current(), true)
    resolve({ token: "restored", sessionId: "same", targetUrl: "https://example.com" })
    await restoring
    assert.equal(intent.current(), true)
    assert.equal(getTabViewState(instanceId).previews?.same.mode, "chat")
  } finally {
    intent.release()
    publishInstanceLifecycleAuthority({ type: "removed", instanceId, folder: "/repo", occurrence: 0 })
    serverApi.createPreview = create; serverApi.deletePreview = remove
  }
})

test("deferred Mission reconciliation rechecks recovery and the latest passage", () => {
  const instanceId = "passive-mission-recovery", ctx = { instanceId, sessionId: "same" }
  publishInstanceLifecycleAuthority({ type: "opened", instanceId, folder: "/repo", occurrence: 0 })
  activateSessionSurface(ctx, { kind: "mission", target: reader })
  let missing = true
  const cleanup = captureSessionSurfaceIntent(ctx)
  updateMissionProjectView(instanceId, () => missing ? { reader: undefined } : {})
  missing = false
  cleanup.release()
  assert.equal(missionProjectView(instanceId).reader, reader)
  let passage = { ...reader, missionId: "passage-a" }
  const retarget = captureSessionSurfaceIntent(ctx)
  retargetMissionReader(instanceId, reader, () => passage)
  passage = { ...reader, missionId: "passage-b" }
  retarget.release()
  assert.equal(missionProjectView(instanceId).reader, passage)
  publishInstanceLifecycleAuthority({ type: "removed", instanceId, folder: "/repo", occurrence: 0 })
})

for (const statusFirst of [false, true]) test(`file lifetime recovery is rechecked and status reconciliation cannot discard a pending close (status first: ${statusFirst})`, () => {
  const instanceId = `passive-file-recovery-${statusFirst}`, ctx = { instanceId, sessionId: "same" }
  const target = { sessionId: "same", path: "a", slug: "root", directory: "/repo" }
  publishInstanceLifecycleAuthority({ type: "opened", instanceId, folder: "/repo", occurrence: 0 })
  activateSessionSurface(ctx, { kind: "file", target })
  let missing = true
  const recovery = captureSessionSurfaceIntent(ctx)
  filePreviews.reconcileFilePreviewLifetime(instanceId, () => missing)
  missing = false
  recovery.release()
  assert.equal(filePreviews.getFilePreview(instanceId), target)
  const close = captureSessionSurfaceIntent(ctx)
  if (statusFirst) filePreviews.reconcileFilePreview(instanceId, target, () => ({ ...target, scope: "staged" }))
  filePreviews.reconcileFilePreviewLifetime(instanceId)
  filePreviews.reconcileFilePreviewLifetime(instanceId, () => missing)
  if (!statusFirst) filePreviews.reconcileFilePreview(instanceId, target, () => ({ ...target, scope: "staged" }))
  close.release()
  assert.equal(filePreviews.getFilePreview(instanceId), null)
  publishInstanceLifecycleAuthority({ type: "removed", instanceId, folder: "/repo", occurrence: 0 })
})

test("file recovery preserves a newer passive status target and a repeated file gesture renews its lifetime", () => {
  const instanceId = "file-lifetime-identity", ctx = { instanceId, sessionId: "same" }
  const target = { sessionId: "same", path: "a", slug: "root", directory: "/repo" }
  const updated = { ...target, scope: "staged" as const }
  publishInstanceLifecycleAuthority({ type: "opened", instanceId, folder: "/repo", occurrence: 0 })
  activateSessionSurface(ctx, { kind: "file", target })
  const recovery = captureSessionSurfaceIntent(ctx)
  filePreviews.reconcileFilePreview(instanceId, target, () => updated)
  filePreviews.reconcileFilePreviewLifetime(instanceId, () => false)
  recovery.release()
  assert.equal(filePreviews.getFilePreview(instanceId), updated)
  const reopen = captureSessionSurfaceIntent(ctx)
  filePreviews.reconcileFilePreviewLifetime(instanceId)
  commitSurface(ctx, { kind: "file", target: updated }, reopen)
  reopen.release()
  assert.equal(filePreviews.getFilePreview(instanceId), updated)
  publishInstanceLifecycleAuthority({ type: "removed", instanceId, folder: "/repo", occurrence: 0 })
})
