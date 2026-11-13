import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseStoredSessionPreviews, openSessionPreview, restoreSessionPreview, showSessionChatFor, showSessionPreview, getSessionPreview, closeSessionPreview, updateSessionPreviewHistory, updateSessionPreviewViewport, getPreviewSessionIds } from "./session-previews"
import { missionProjectView, updateMissionProjectView } from "./mission-view-state"
import { serverApi } from "../lib/api-client"
import { getTabViewState, seedTabViewState } from "./tab-view-state"
import { publishInstanceLifecycleAuthority } from "./instance-lifecycle-authority"

describe("session preview persistence", () => {
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
      publishInstanceLifecycleAuthority({ type: "removed", instanceId: "duplicate-a", folder: "/same", occurrence: 0 })
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
      publishInstanceLifecycleAuthority({ type: "removed", instanceId: "closed-pending", folder: "/same", occurrence: 0 })
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
