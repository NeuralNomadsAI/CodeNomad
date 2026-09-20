import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { createRoot } from "solid-js"
import { serverApi } from "../lib/api-client"
import { createSessionOutline } from "./session-outline"
import { applyOpenCodeDataEvent, destroyOpenCodeData } from "./opencode-data"
import { setSessions } from "./session-state"
import { sdkManager } from "../lib/sdk-manager"

test("a message arriving during a fixed-horizon scan schedules one catch-up after terminal status", async () => {
  const instanceId = "outline-trailing", sessionId = "s"
  const original = serverApi.fetchSessionOutline
  const entry = (seq: number) => ({ id: `m${seq}`, seq, type: "user" as const, tools: 0, reasoning: 0 })
  const checkpoint = (after: number, through: number) => ({ after, through, digest: "a".repeat(64), changed: true })
  let release!: () => void, dispose!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0, held = false, appended = false
  const status = (status: string) => setSessions(new Map([[instanceId, new Map([[sessionId, {
    id: sessionId, status, projectID: "p", location: { directory: "/work" },
  } as any]])]]))
  status("working")
  serverApi.fetchSessionOutline = async (_instance, _session, cursor) => {
    calls++
    if (!cursor) return appended
      ? { status: "outline", entries: [entry(0), entry(1), entry(2)], checkpoints: [checkpoint(-1, 2)], total: 3, cursor: null }
      : { status: "outline", entries: [entry(0)], checkpoints: [checkpoint(-1, 0)], total: 2, cursor: { after: 0, through: 1 } }
    held = true
    await gate
    return { status: "outline", entries: [entry(1)], checkpoints: [checkpoint(0, 1)], total: 2, cursor: null }
  }
  const waitFor = async (check: () => boolean) => {
    for (let attempt = 0; attempt < 200 && !check(); attempt++) await delay(5)
    assert(check())
  }
  try {
    const outline = createRoot(cleanup => {
      dispose = cleanup
      return createSessionOutline({ instanceId: () => instanceId, sessionId: () => sessionId, active: () => true })
    })
    await waitFor(() => held)
    appended = true
    applyOpenCodeDataEvent(instanceId, "/work", { id: "event", type: "session.text.delta", created: 1,
      data: { sessionID: sessionId, assistantMessageID: "live", ordinal: 0, delta: "new" } } as any)
    status("idle")
    release()
    await waitFor(() => !outline.pending() && outline.entries().at(-1)?.seq === 2)
    assert.equal(outline.error(), "")
    assert.equal(calls, 4, "first page, superseded last-page read, resumed last page, then one catch-up")
  } finally {
    release(); dispose?.(); serverApi.fetchSessionOutline = original
    destroyOpenCodeData(instanceId); sdkManager.destroyClientsForInstance(instanceId); setSessions(new Map())
  }
})
