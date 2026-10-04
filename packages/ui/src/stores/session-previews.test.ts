import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseStoredSessionPreviews, openSessionPreview, showSessionChat, showSessionPreview, getSessionPreview, closeSessionPreview } from "./session-previews"
import { missionProjectView, updateMissionProjectView } from "./mission-view-state"
import { serverApi } from "../lib/api-client"

describe("session preview persistence", () => {
  it("restores only valid HTTP preview records", () => {
    assert.deepEqual(parseStoredSessionPreviews(JSON.stringify({
      valid: { targetUrl: "http://localhost:3000/app", mode: "preview" },
      invalidScheme: { targetUrl: "javascript:alert(1)", mode: "preview" },
      invalidMode: { targetUrl: "https://example.com", mode: "hidden" },
    })), [["valid", { targetUrl: "http://localhost:3000/app", mode: "preview" }]])
    assert.deepEqual(parseStoredSessionPreviews("not json"), [])
  })
  it("explicit browser and reader gestures share the surface without losing the browser target", async () => {
    const create = serverApi.createPreview, remove = serverApi.deletePreview
    serverApi.createPreview = async () => ({ token: "fixture", sessionId: "session", targetUrl: "https://example.com", url: "/preview/fixture" }) as any
    serverApi.deletePreview = async () => undefined as any
    try {
      const reader = { missionId: "mission", kind: "overview" as const }
      await openSessionPreview("session", "https://example.com", "surface")
      showSessionChat("surface")
      updateMissionProjectView("surface", { reader })
      assert.equal(getSessionPreview("session", "surface")?.mode, "chat")
      showSessionPreview("surface")
      assert.equal(missionProjectView("surface").reader, undefined)
      assert.equal(getSessionPreview("session", "surface")?.targetUrl, "https://example.com")
      await closeSessionPreview("surface")
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
      showSessionChat("race")
      const reader = { missionId: "mission", kind: "overview" as const }
      updateMissionProjectView("race", { reader })
      resolve({ token: "stale", targetUrl: "https://example.com" })
      await assert.rejects(pending, /superseded/)
      assert.deepEqual(deleted, ["stale"])
      assert.equal(missionProjectView("race").reader, reader)
      assert.equal(getSessionPreview("session", "race"), null)
    } finally { serverApi.createPreview = create; serverApi.deletePreview = remove }
  })
})
