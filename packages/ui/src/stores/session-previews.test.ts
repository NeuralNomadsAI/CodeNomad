import assert from "node:assert/strict"
import { before, describe, it } from "node:test"
import { parseStoredSessionPreviews, openSessionPreview, restoreSessionPreview, showSessionChatFor, showSessionPreview, getSessionPreview, closeSessionPreview, updateSessionPreviewHistory, updateSessionPreviewLocation, updateSessionPreviewViewport, getPreviewSessionIds } from "./session-previews"
import { missionProjectView, updateMissionProjectView } from "./mission-view-state"
import { serverApi } from "../lib/api-client"
import { getTabViewState, seedTabViewState } from "./tab-view-state"
import { publishInstanceLifecycleAuthority } from "./instance-lifecycle-authority"
import { getPendingPreviewOperationCount } from "./session-previews"
import { captureSessionSurfaceIntent } from "./session-surface"

function registerOccurrence(id: string) {
  publishInstanceLifecycleAuthority({ type: "opened", instanceId: id, folder: "/same", occurrence: 0 })
}
function closeOccurrence(instanceId: string) {
  publishInstanceLifecycleAuthority({ type: "removed", instanceId, folder: "/same", occurrence: 0 })
}
before(() => {
  for (const id of ["duplicate-a", "duplicate-b", "duplicate-restored", "closed-pending", "restore-race",
    "error-survivor", "late-error-false", "late-error-true", "restore-reopen", "expired-native", "surface", "race"]) registerOccurrence(id)
})

describe("session preview persistence", () => {
  it("changed browser locations and same-URL history entries supersede activation, unchanged history samples preserve it", async () => {
    const create = serverApi.createPreview, remove = serverApi.deletePreview, id = "web-intent"
    registerOccurrence(id)
    serverApi.createPreview = async ({ sessionId, url }) => ({ sessionId, token: "intent", targetUrl: url }) as any
    serverApi.deletePreview = async () => undefined as any
    try {
      const preview = await openSessionPreview("same", "https://example.com/a", id)
      const ctx = { instanceId: id, sessionId: "same" }
      const unchanged = captureSessionSurfaceIntent(ctx)
      updateSessionPreviewLocation(preview.storageKey, preview.targetUrl)
      updateSessionPreviewHistory(preview.storageKey, preview.history)
      assert.equal(unchanged.current(), true)
      updateSessionPreviewLocation(preview.storageKey, "https://example.com/b")
      assert.equal(unchanged.current(), false)
      const sameUrl = captureSessionSurfaceIntent(ctx)
      updateSessionPreviewHistory(preview.storageKey, { urls: [preview.targetUrl, preview.targetUrl], index: 1 })
      assert.equal(sameUrl.current(), false, "same URL entries still represent newer navigation")
    } finally { closeOccurrence(id); serverApi.createPreview = create; serverApi.deletePreview = remove }
  })
  it("retains only pending request fences across 1000 occurrence lifetimes", async () => {
    const create = serverApi.createPreview, remove = serverApi.deletePreview
    serverApi.deletePreview = async () => undefined as any
    try {
      for (let index = 0; index < 1000; index++) {
        const id = `retention-${index}`
        registerOccurrence(id)
        showSessionChatFor("same", id)
        assert.equal(getPendingPreviewOperationCount(), 0)
        let resolve!: (value: any) => void
        serverApi.createPreview = () => new Promise(done => { resolve = done })
        const pending = openSessionPreview("same", "https://example.com", id)
        assert.equal(getPendingPreviewOperationCount(), 1)
        closeOccurrence(id)
        assert.equal(getPendingPreviewOperationCount(), 0)
        resolve({ sessionId: "same", token: id, targetUrl: "https://example.com" })
        await assert.rejects(pending, { name: "AbortError" })
        assert.equal(getPendingPreviewOperationCount(), 0)
        assert.equal(getSessionPreview("same", id), null)
      }
    } finally { serverApi.createPreview = create; serverApi.deletePreview = remove }
  })
  it("duplicate occurrences keep URLs, mode, history, emulation and persistence independent", async () => {
    const create = serverApi.createPreview, remove = serverApi.deletePreview
    let token = 0
    const deleted: string[] = []
    serverApi.createPreview = async ({ sessionId, url }) => ({ sessionId, token: `duplicate-${++token}`, targetUrl: url }) as any
    serverApi.deletePreview = async token => { deleted.push(token); return undefined as any }
    try {
      const a = await openSessionPreview("same", "https://example.com/a", "duplicate-a")
      assert.equal(getSessionPreview("same", "duplicate-b"), null)
      const b = await openSessionPreview("same", "https://example.com/b", "duplicate-b")
      assert.equal(getPendingPreviewOperationCount(), 0, "settled opens release their fences")
      showSessionChatFor("same", "duplicate-b")
      updateSessionPreviewHistory(a.storageKey, { urls: ["https://example.com/a", "https://example.com/next"], index: 1 })
      updateSessionPreviewViewport(a.storageKey, "mobile")
      assert.deepEqual(getPreviewSessionIds("duplicate-a"), ["same"])
      assert.equal(getSessionPreview("same", "duplicate-b")?.mode, "chat")
      assert.equal(getSessionPreview("same", "duplicate-b")?.targetUrl, "https://example.com/b")
      assert.equal(getTabViewState("duplicate-a").previews?.same.viewport, "mobile")
      assert.equal(getTabViewState("duplicate-b").previews?.same.viewport, undefined)
      const snapshot = getTabViewState("duplicate-a")
      seedTabViewState("duplicate-restored", snapshot)
      assert.equal(getSessionPreview("same", "duplicate-restored"), null, "hydration is data-only")
      const restored = await restoreSessionPreview("same", "duplicate-restored")
      assert.deepEqual(restored?.history, { urls: ["https://example.com/a", "https://example.com/next"], index: 1 })
      assert.equal(restored?.viewport, "mobile")
      closeOccurrence("duplicate-a")
      assert.equal(getSessionPreview("same", "duplicate-a"), null)
      assert.equal(getSessionPreview("same", "duplicate-b")?.token, b.token)
      assert.deepEqual(deleted, [a.token])
      showSessionPreview(b.storageKey)
      assert.equal(getSessionPreview("same", "duplicate-b")?.mode, "preview")
      await closeSessionPreview(b.storageKey)
      await closeSessionPreview(restored!.storageKey)
    } finally { serverApi.createPreview = create; serverApi.deletePreview = remove }
  })

  it("closing an occurrence fences its pending open without rerouting it to another owner", async () => {
    const create = serverApi.createPreview, remove = serverApi.deletePreview
    let resolve!: (value: any) => void
    const deleted: string[] = []
    serverApi.createPreview = () => new Promise(yes => { resolve = yes })
    serverApi.deletePreview = async token => { deleted.push(token); return undefined as any }
    try {
      const pending = openSessionPreview("same", "https://example.com/a", "closed-pending")
      closeOccurrence("closed-pending")
      resolve({ sessionId: "same", token: "late-closed", targetUrl: "https://example.com/a" })
      await assert.rejects(pending, { name: "AbortError", message: "Preview navigation was superseded" })
      assert.equal(getSessionPreview("same", "closed-pending"), null)
      assert.equal(getTabViewState("closed-pending").previews, undefined)
      assert.deepEqual(deleted, ["late-closed"])
      await assert.rejects(openSessionPreview("same", "https://example.com/a", "closed-pending"), /closed/)
    } finally { serverApi.createPreview = create; serverApi.deletePreview = remove }
  })

  it("a later chat gesture fences a pending restore instead of starting a default browser", async () => {
    const create = serverApi.createPreview, remove = serverApi.deletePreview
    let resolve!: (value: any) => void
    serverApi.createPreview = () => new Promise(yes => { resolve = yes })
    serverApi.deletePreview = async () => undefined as any
    seedTabViewState("restore-race", { version: 1, previews: { same: { targetUrl: "https://example.com/", mode: "preview" } } })
    try {
      const pending = restoreSessionPreview("same", "restore-race")
      showSessionChatFor("same", "restore-race")
      resolve({ sessionId: "same", token: "late-restore", targetUrl: "https://example.com/" })
      await assert.rejects(pending, /superseded/)
      assert.equal(getSessionPreview("same", "restore-race"), null)
      assert.equal(getTabViewState("restore-race").previews?.same.mode, "chat")
    } finally { serverApi.createPreview = create; serverApi.deletePreview = remove }
  })
  it("an old response cannot match a new request after the same occurrence is reopened", async () => {
    const create = serverApi.createPreview, remove = serverApi.deletePreview
    const responses: Array<(value: any) => void> = [], deleted: string[] = []
    serverApi.createPreview = () => new Promise(resolve => { responses.push(resolve) })
    serverApi.deletePreview = async token => { deleted.push(token); return undefined as any }
    registerOccurrence("reused")
    try {
      const old = openSessionPreview("same", "https://example.com/old", "reused")
      closeOccurrence("reused")
      registerOccurrence("reused")
      const fresh = openSessionPreview("same", "https://example.com/new", "reused")
      responses[1]({ sessionId: "same", token: "fresh", targetUrl: "https://example.com/new" })
      const record = await fresh
      assert.equal(getPendingPreviewOperationCount(), 0)
      responses[0]({ sessionId: "same", token: "old", targetUrl: "https://example.com/old" })
      await assert.rejects(old, { name: "AbortError" })
      assert.equal(getSessionPreview("same", "reused"), record)
      assert.deepEqual(deleted, ["old"])
      closeOccurrence("reused")
    } finally { serverApi.createPreview = create; serverApi.deletePreview = remove }
  })
  it("unavailable occurrences reject new requests and fence an in-flight response", async () => {
    const create = serverApi.createPreview, remove = serverApi.deletePreview
    let resolve!: (value: any) => void
    serverApi.createPreview = () => new Promise(done => { resolve = done })
    serverApi.deletePreview = async () => undefined as any
    registerOccurrence("unavailable")
    try {
      const pending = openSessionPreview("same", "https://example.com", "unavailable")
      publishInstanceLifecycleAuthority({ type: "unavailable", instanceId: "unavailable", folder: "/same", occurrence: 0 })
      await assert.rejects(openSessionPreview("same", "https://example.com", "unavailable"), { name: "AbortError" })
      registerOccurrence("unavailable")
      resolve({ sessionId: "same", token: "unavailable", targetUrl: "https://example.com" })
      await assert.rejects(pending, { name: "AbortError" })
      assert.equal(getPendingPreviewOperationCount(), 0)
      assert.equal(getSessionPreview("same", "unavailable"), null)
      closeOccurrence("unavailable")
    } finally { serverApi.createPreview = create; serverApi.deletePreview = remove }
  })
  it("late errors after close or a newer view gesture abort only the original occurrence", async () => {
    const create = serverApi.createPreview, remove = serverApi.deletePreview
    let reject!: (error: Error) => void
    serverApi.createPreview = async ({ sessionId, url }) => ({ sessionId, token: "survivor", targetUrl: url }) as any
    serverApi.deletePreview = async () => undefined as any
    try {
      const b = await openSessionPreview("same", "https://example.com/b", "error-survivor")
      serverApi.createPreview = () => new Promise((_, no) => { reject = no })
      for (const close of [false, true]) {
        const id = `late-error-${close}`
        const pending = openSessionPreview("same", "https://example.com/a", id)
        if (close) closeOccurrence(id)
        else showSessionChatFor("same", id)
        reject(new Error("late server failure"))
        await assert.rejects(pending, { name: "AbortError" })
        assert.equal(getPendingPreviewOperationCount(), 0, "settled errors release their fences")
        assert.equal(getSessionPreview("same", id), null)
        assert.equal(getSessionPreview("same", "error-survivor"), b)
      }
      await closeSessionPreview(b.storageKey)
    } finally { serverApi.createPreview = create; serverApi.deletePreview = remove }
  })
  it("reopening after a hide starts a fresh restore and an old completion cannot clear it", async () => {
    const create = serverApi.createPreview, remove = serverApi.deletePreview
    const responses: Array<(value: any) => void> = [], deleted: string[] = []
    serverApi.createPreview = () => new Promise(resolve => { responses.push(resolve) })
    serverApi.deletePreview = async token => { deleted.push(token); return undefined as any }
    seedTabViewState("restore-reopen", { version: 1, previews: { same: { targetUrl: "https://example.com/", mode: "chat" } } })
    try {
      const first = restoreSessionPreview("same", "restore-reopen")
      assert.equal(restoreSessionPreview("same", "restore-reopen"), first, "identical pending restores coalesce")
      showSessionChatFor("same", "restore-reopen")
      const second = restoreSessionPreview("same", "restore-reopen")
      assert.notEqual(first, second)
      responses[0]({ sessionId: "same", token: "old", targetUrl: "https://example.com/" })
      await assert.rejects(first, /superseded/)
      assert.equal(restoreSessionPreview("same", "restore-reopen"), second)
      responses[1]({ sessionId: "same", token: "new", targetUrl: "https://example.com/" })
      const current = await second
      showSessionPreview(current!.storageKey)
      assert.equal(getSessionPreview("same", "restore-reopen")?.mode, "preview")
      assert.deepEqual(deleted, ["old"])
      await closeSessionPreview(current!.storageKey)
    } finally { serverApi.createPreview = create; serverApi.deletePreview = remove }
  })
  it("an expired native open cannot publish a delayed preview response", async () => {
    const create = serverApi.createPreview, remove = serverApi.deletePreview
    const deleted: string[] = []
    serverApi.createPreview = async () => ({ token: "expired-native-open", targetUrl: "https://example.com" }) as any
    serverApi.deletePreview = async token => { deleted.push(token); return undefined as any }
    try {
      await assert.rejects(openSessionPreview("session", "https://example.com", "expired-native", async () => false), /no longer current/)
      assert.equal(getSessionPreview("session", "expired-native"), null)
      assert.deepEqual(deleted, ["expired-native-open"])
    } finally { serverApi.createPreview = create; serverApi.deletePreview = remove }
  })
  it("restores only valid HTTP preview records", () => {
    assert.deepEqual(parseStoredSessionPreviews(JSON.stringify({
      valid: { targetUrl: "http://localhost:3000/app", mode: "preview" },
      invalidScheme: { targetUrl: "javascript:alert(1)", mode: "preview" },
      invalidMode: { targetUrl: "https://example.com", mode: "hidden" },
    })), [["valid", { targetUrl: "http://localhost:3000/app", mode: "preview" }]])
    assert.deepEqual(parseStoredSessionPreviews("not json"), [])
    assert.equal(parseStoredSessionPreviews(JSON.stringify({
      mobile: { targetUrl: "https://example.com/", mode: "chat", viewport: "mobile" },
      invalid: { targetUrl: "https://example.com/", mode: "chat", viewport: "custom-script" },
    }))[0][1].viewport, "mobile")
    assert.equal(parseStoredSessionPreviews(JSON.stringify({
      invalid: { targetUrl: "https://example.com/", mode: "chat", viewport: "custom-script" },
    }))[0][1].viewport, undefined)
  })
  it("explicit browser and reader gestures share the surface without losing the browser target", async () => {
    const create = serverApi.createPreview, remove = serverApi.deletePreview
    serverApi.createPreview = async () => ({ token: "fixture", sessionId: "session", targetUrl: "https://example.com", url: "/preview/fixture" }) as any
    serverApi.deletePreview = async () => undefined as any
    try {
      const reader = { missionId: "mission", kind: "overview" as const }
      const { storageKey } = await openSessionPreview("session", "https://example.com", "surface")
      showSessionChatFor("session", "surface")
      updateMissionProjectView("surface", { reader })
      assert.equal(getSessionPreview("session", "surface")?.mode, "chat")
      showSessionPreview(storageKey)
      assert.equal(missionProjectView("surface").reader, undefined)
      assert.equal(getSessionPreview("session", "surface")?.targetUrl, "https://example.com")
      await closeSessionPreview(storageKey)
    } finally { serverApi.createPreview = create; serverApi.deletePreview = remove }
  })
  it("a pending browser open cannot steal a later mission reader gesture", async () => {
    const create = serverApi.createPreview, remove = serverApi.deletePreview
    let resolve!: (value: any) => void
    const deleted: string[] = []
    serverApi.createPreview = () => new Promise(yes => { resolve = yes })
    serverApi.deletePreview = async token => { deleted.push(token); return undefined as any }
    try {
      const pending = openSessionPreview("session", "https://example.com", "race")
      showSessionChatFor("session", "race")
      const reader = { missionId: "mission", kind: "overview" as const }
      updateMissionProjectView("race", { reader })
      resolve({ token: "stale", targetUrl: "https://example.com" })
      await assert.rejects(pending, /superseded/)
      assert.deepEqual(deleted, ["stale"])
      assert.deepEqual(missionProjectView("race").reader, reader)
      assert.equal(getSessionPreview("session", "race"), null)
    } finally { serverApi.createPreview = create; serverApi.deletePreview = remove }
  })
})
