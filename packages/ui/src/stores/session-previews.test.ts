import assert from "node:assert/strict"
import { afterEach, before, describe, it } from "node:test"
import { sessionPreviews, openSessionPreview, restoreSessionPreview, showSessionChatFor, showSessionPreview, getSessionPreview, closeSessionPreview, updateSessionPreviewHistory, updateSessionPreviewLocation, updateSessionPreviewViewport } from "./session-previews"
import { parseLegacySessionPreviews } from "./tab-view-state-codec"
import { missionProjectView, navigateMissionProjectView } from "./mission-view-state"
import { serverApi } from "../lib/api-client"
import { getTabViewState, seedTabViewState } from "./tab-view-state"
import { publishInstanceLifecycleAuthority } from "./instance-lifecycle-authority"
import { getPendingPreviewOperationCount } from "./session-previews"
import { setPreviewSessionOwners } from "./session-previews"
import { applySurface, beginGesture, getSessionSurface } from "./session-surface"
import { setActiveSessionId } from "./session-selection-state"

function registerOccurrence(id: string) {
  publishInstanceLifecycleAuthority({ type: "opened", instanceId: id, folder: "/same", occurrence: 0 })
  setPreviewSessionOwners(id, new Map(["same", "session", "a", "b"].map(id => [id, true])))
}
function closeOccurrence(instanceId: string) {
  publishInstanceLifecycleAuthority({ type: "removed", instanceId, folder: "/same", occurrence: 0 })
}
before(() => {
  for (const id of ["duplicate-a", "duplicate-b", "duplicate-restored", "closed-pending", "restore-race",
    "error-survivor", "late-error-false", "late-error-true", "restore-reopen", "expired-native", "surface", "race"]) registerOccurrence(id)
})
afterEach(async () => { for (const id of sessionPreviews().keys()) await closeSessionPreview(id) })

describe("session preview persistence", () => {
  it("a second occurrence restores independently when the first requester closes", async () => {
    const create = serverApi.createPreview, remove = serverApi.deletePreview
    const responses: Array<(value: any) => void> = [], deleted: string[] = []
    const a = "restore-first", b = "restore-survivor"
    registerOccurrence(a); registerOccurrence(b)
    seedTabViewState(a, { version: 1, previews: { same: { targetUrl: "https://example.com/saved", mode: "chat" } } })
    seedTabViewState(b, { version: 1, previews: { same: { targetUrl: "https://example.com/saved", mode: "chat" } } })
    serverApi.createPreview = () => new Promise(resolve => { responses.push(resolve) })
    serverApi.deletePreview = async token => { deleted.push(token); return undefined as any }
    try {
      const first = restoreSessionPreview("same", a)
      const firstResult = assert.rejects(first, { name: "AbortError" })
      const second = restoreSessionPreview("same", b)
      const secondResult = second.then(record => { showSessionPreview(record!.sessionId, b); return record })
      // Observe rejection even on the broken implementation, where both share A's promise.
      void secondResult.catch(() => undefined)
      closeOccurrence(a)
      responses[0]({ sessionId: "same", token: "stale", targetUrl: "https://example.com/saved" })
      await firstResult
      assert.equal(responses.length, 2, "another occurrence owns its own restoration fence")
      assert.equal(restoreSessionPreview("same", b), second, "stale cleanup retains B's pending work")
      responses[1]({ sessionId: "same", token: "survivor", targetUrl: "https://example.com/saved" })
      assert.equal((await secondResult)?.token, "survivor")
      assert.equal(getSessionSurface({ instanceId: b, sessionId: "same" }).kind, "web")
      assert.equal(getPendingPreviewOperationCount(), 0)
      assert.deepEqual(deleted, ["stale"])
    } finally { closeOccurrence(a); closeOccurrence(b); serverApi.createPreview = create; serverApi.deletePreview = remove }
  })
  it("passive locations and same-URL history entries apply immediately without cancelling gesture adoption", async () => {
    const create = serverApi.createPreview, remove = serverApi.deletePreview, id = "web-intent"
    registerOccurrence(id)
    serverApi.createPreview = async ({ sessionId, url }) => ({ sessionId, token: "intent", targetUrl: url }) as any
    serverApi.deletePreview = async () => undefined as any
    try {
      const preview = await openSessionPreview("same", "https://example.com/a", id)
      setActiveSessionId(previous => new Map(previous).set(id, "same"))
      const ctx = { instanceId: id, sessionId: "same" }
      const unchanged = beginGesture(ctx)
      updateSessionPreviewLocation(preview.sessionId, preview.targetUrl)
      updateSessionPreviewHistory(preview.sessionId, preview.history)
      assert.equal(unchanged.current(), true)
      updateSessionPreviewLocation(preview.sessionId, "https://example.com/b")
      assert.equal(unchanged.current(), true)
      const sameUrl = beginGesture(ctx)
      updateSessionPreviewHistory(preview.sessionId, { urls: [preview.targetUrl, preview.targetUrl], index: 1 })
      assert.equal(sameUrl.current(), true)
      assert.deepEqual(getSessionPreview("same")?.history, { urls: [preview.targetUrl, preview.targetUrl], index: 1 })
      applySurface(ctx, { kind: "mission", target: { kind: "overview", missionId: "next" } }, sameUrl)
      assert.equal(getSessionSurface(ctx).kind, "mission")
    } finally { closeOccurrence(id); serverApi.createPreview = create; serverApi.deletePreview = remove }
  })
  it("hidden session location and history updates preserve the displayed session's activation intent", async () => {
    const create = serverApi.createPreview, remove = serverApi.deletePreview, id = "hidden-web-intent"
    registerOccurrence(id)
    serverApi.createPreview = async ({ sessionId, url }) => ({ sessionId, token: sessionId, targetUrl: url }) as any
    serverApi.deletePreview = async () => undefined as any
    try {
      const a = await openSessionPreview("a", "https://example.com/a", id)
      const b = await openSessionPreview("b", "https://example.com/b", id)
      setActiveSessionId(previous => new Map(previous).set(id, "b"))
      assert.equal(getTabViewState(id).previews?.a.mode, "preview", "saved mode also remains preview for the hidden session")
      const intent = beginGesture({ instanceId: id, sessionId: "b" })
      updateSessionPreviewLocation(a.sessionId, "https://example.com/redirect")
      assert.equal(intent.current(), true)
      assert.equal(getSessionPreview("a")?.targetUrl, "https://example.com/redirect")
      const history = { urls: [a.targetUrl, "https://example.com/redirect"], index: 1 }
      updateSessionPreviewHistory(a.sessionId, history)
      assert.equal(intent.current(), true)
      assert.deepEqual(getSessionPreview("a")?.history, history)
      assert.equal(getTabViewState(id).previews?.a.history, undefined, "tab envelopes retain only foreground choices")
      updateSessionPreviewLocation(b.sessionId, "https://example.com/foreground")
      assert.equal(intent.current(), true)
      const next = beginGesture({ instanceId: id, sessionId: "b" })
      updateSessionPreviewHistory(b.sessionId, { urls: [b.targetUrl, b.targetUrl], index: 1 })
      assert.equal(next.current(), true)
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
        assert.equal(getSessionPreview("same"), null)
      }
    } finally { serverApi.createPreview = create; serverApi.deletePreview = remove }
  })
  it("duplicate occurrences share the browser and retain only their foreground choice", async () => {
    const create = serverApi.createPreview, remove = serverApi.deletePreview
    let token = 0
    const deleted: string[] = []
    serverApi.createPreview = async ({ sessionId, url }) => ({ sessionId, token: `duplicate-${++token}`, targetUrl: url }) as any
    serverApi.deletePreview = async token => { deleted.push(token); return undefined as any }
    try {
      const a = await openSessionPreview("same", "https://example.com/a", "duplicate-a")
      assert.equal(getSessionPreview("same"), a)
      const b = await restoreSessionPreview("same", "duplicate-b")
      showSessionPreview("same", "duplicate-b")
      assert.equal(a, b)
      assert.equal(token, 1)
      assert.equal(getPendingPreviewOperationCount(), 0, "settled opens release their fences")
      showSessionChatFor("same", "duplicate-b")
      updateSessionPreviewHistory(a.sessionId, { urls: ["https://example.com/a", "https://example.com/next"], index: 1 })
      updateSessionPreviewViewport(a.sessionId, "mobile")
      assert.equal(getTabViewState("duplicate-b").previews?.same.mode, "chat")
      assert.equal(getSessionPreview("same")?.targetUrl, "https://example.com/next")
      assert.equal(getSessionPreview("same")?.viewport, "mobile")
      assert.equal(getTabViewState("duplicate-a").previews?.same.viewport, undefined)
      assert.equal(getTabViewState("duplicate-b").previews?.same.viewport, undefined)
      const snapshot = getTabViewState("duplicate-a")
      seedTabViewState("duplicate-restored", snapshot)
      assert.equal(token, 1, "hydration allocates no guest")
      const restored = await restoreSessionPreview("same", "duplicate-restored")
      assert.deepEqual(restored?.history, { urls: ["https://example.com/a", "https://example.com/next"], index: 1 })
      assert.equal(restored?.viewport, "mobile")
      closeOccurrence("duplicate-a")
      assert.equal(getSessionPreview("same"), restored, "closing one occurrence retains the shared resource")
      assert.equal(getSessionPreview("same")?.token, b!.token)
      assert.deepEqual(deleted, [])
      showSessionPreview("same", "duplicate-b")
      assert.equal(getTabViewState("duplicate-b").previews?.same.mode, "preview")
      await closeSessionPreview(b!.sessionId)
      await closeSessionPreview(restored!.sessionId)
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
      assert.equal(getSessionPreview("same"), null)
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
      assert.equal(getSessionPreview("same"), null)
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
      assert.equal(getSessionPreview("same"), record)
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
      assert.equal(getSessionPreview("same"), null)
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
        assert.equal(getSessionSurface({ instanceId: id, sessionId: "same" }).kind, "conversation")
        assert.equal(getSessionPreview("same"), b)
      }
      await closeSessionPreview(b.sessionId)
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
      showSessionPreview(current!.sessionId, "restore-reopen")
      assert.equal(getTabViewState("restore-reopen").previews?.same.mode, "preview")
      assert.deepEqual(deleted, ["old"])
      await closeSessionPreview(current!.sessionId)
    } finally { serverApi.createPreview = create; serverApi.deletePreview = remove }
  })
  it("an expired native open cannot publish a delayed preview response", async () => {
    const create = serverApi.createPreview, remove = serverApi.deletePreview
    const deleted: string[] = []
    const delivery = new AbortController()
    serverApi.createPreview = async () => {
      delivery.abort()
      return { token: "expired-native-open", targetUrl: "https://example.com" } as any
    }
    serverApi.deletePreview = async token => { deleted.push(token); return undefined as any }
    try {
      await assert.rejects(openSessionPreview("session", "https://example.com", "expired-native", undefined,
        { requestID: "expired", instanceId: "expired-native" }, delivery.signal), { name: "AbortError" })
      assert.equal(getSessionPreview("session"), null)
      assert.deepEqual(deleted, ["expired-native-open"])
    } finally { serverApi.createPreview = create; serverApi.deletePreview = remove }
  })
  it("restores only valid HTTP preview records", () => {
    assert.deepEqual(parseLegacySessionPreviews(JSON.stringify({
      valid: { targetUrl: "http://localhost:3000/app", mode: "preview" },
      invalidScheme: { targetUrl: "javascript:alert(1)", mode: "preview" },
      invalidMode: { targetUrl: "https://example.com", mode: "hidden" },
    })), [["valid", { targetUrl: "http://localhost:3000/app", mode: "preview" }]])
    assert.deepEqual(parseLegacySessionPreviews("not json"), [])
    assert.equal(parseLegacySessionPreviews(JSON.stringify({
      mobile: { targetUrl: "https://example.com/", mode: "chat", viewport: "mobile" },
      invalid: { targetUrl: "https://example.com/", mode: "chat", viewport: "custom-script" },
    }))[0][1].viewport, "mobile")
    assert.equal(parseLegacySessionPreviews(JSON.stringify({
      invalid: { targetUrl: "https://example.com/", mode: "chat", viewport: "custom-script" },
    }))[0][1].viewport, undefined)
  })
  it("explicit browser and reader gestures share the surface without losing the browser target", async () => {
    const create = serverApi.createPreview, remove = serverApi.deletePreview
    serverApi.createPreview = async () => ({ token: "fixture", sessionId: "session", targetUrl: "https://example.com", url: "/preview/fixture" }) as any
    serverApi.deletePreview = async () => undefined as any
    try {
      const reader = { missionId: "mission", kind: "overview" as const }
      const { sessionId } = await openSessionPreview("session", "https://example.com", "surface")
      showSessionChatFor("session", "surface")
      navigateMissionProjectView("surface", { reader })
      assert.equal(getTabViewState("surface").previews?.session.mode, "chat")
      showSessionPreview(sessionId, "surface")
      assert.equal(missionProjectView("surface").reader, undefined)
      assert.equal(getSessionPreview("session")?.targetUrl, "https://example.com")
      await closeSessionPreview(sessionId)
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
      navigateMissionProjectView("race", { reader })
      resolve({ token: "stale", targetUrl: "https://example.com" })
      await assert.rejects(pending, /superseded/)
      assert.deepEqual(deleted, ["stale"])
      assert.deepEqual(missionProjectView("race").reader, reader)
      assert.equal(getSessionPreview("session"), null)
    } finally { serverApi.createPreview = create; serverApi.deletePreview = remove }
  })
})
