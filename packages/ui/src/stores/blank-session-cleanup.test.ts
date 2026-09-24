import assert from "node:assert/strict"
import { after, afterEach, before, describe, it } from "node:test"
import toast from "solid-toast"
import { sdkManager } from "../lib/sdk-manager.ts"
import type { Session } from "../types/session.ts"
import { createFileAttachment } from "../types/attachment.ts"
import { addAttachment, clearInstanceAttachments } from "./attachments.ts"
import { cleanupBlankSession } from "./blank-session-cleanup.ts"
import { addInstance, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { destroyOpenCodeData } from "./opencode-data.ts"
import { createSession } from "./session-api.ts"
import { sendMessage } from "./session-actions.ts"
import { preferences } from "./preferences.tsx"
import {
  beginSessionGenerationAdmission, cleanupBlankSessions, clearInstanceDeletedSessionAuthority,
  clearSessionDraftPrompt, sessions, setSessionDraftPrompt, setSessions,
} from "./session-state.ts"

const instanceId = "blank-cleanup"
const sessionId = "existing"
// Node's CJS interop for this browser-only toast package differs from Vite's.
const originalToast = toast.custom
before(() => { toast.custom = () => "cleanup-toast" })
after(() => { toast.custom = originalToast })
const emptyPage = () => ({ data: [], cursor: {} })
const session = (id = sessionId, overrides: Partial<Session> = {}): Session => ({
  id, instanceId, parentId: null, title: id, agent: "", model: { providerId: "", modelId: "" },
  status: "idle", runtimeStatusKnown: true, projectID: "project", location: { directory: "/work" },
  time: { created: 1, updated: 1 }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, ...overrides,
})

function setup(overrides: Partial<Session> = {}) {
  const removed: string[] = []
  const reads: any[] = []
  const client = {
    model: { default: async () => ({ data: null }) },
    session: {
      create: async () => session("new"),
      get: async () => session(sessionId, overrides),
      remove: async ({ sessionID }: { sessionID: string }) => { removed.push(sessionID) },
      list: async () => emptyPage(),
      active: async () => ({}),
      inbox: { list: async () => [] },
    },
    message: { list: async (input: any) => { reads.push(input); return emptyPage() } },
  } as any
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, session(sessionId, overrides)]])))
  return { client, removed, reads }
}

afterEach(() => {
  clearSessionDraftPrompt(instanceId, sessionId)
  clearInstanceAttachments(instanceId)
  messageStoreBus.unregisterInstance(instanceId)
  setSessions(previous => { const next = new Map(previous); next.delete(instanceId); return next })
  clearInstanceDeletedSessionAuthority(instanceId)
  removeInstance(instanceId, { authoritative: false })
  sdkManager.destroyClientsForInstance(instanceId)
})

function residentMessage() {
  messageStoreBus.getOrCreate(instanceId).upsertMessage({
    id: "local", sessionId, role: "user", status: "sending", createdAt: 2,
    parts: [{ id: "text", type: "text", text: "not submitted yet" }],
  })
}

describe("automatic blank-session cleanup", () => {
  it("creating a session preserves an unloaded conversation with equal timestamps (#754)", async () => {
    const { client, removed } = setup()
    client.message.list = async () => ({ data: [{ id: "prompt", type: "user", text: "Keep me" }], cursor: {} })
    assert.equal(preferences().autoCleanupBlankSessions, true)
    assert.equal((await createSession(instanceId)).id, "new")
    await cleanupBlankSessions(instanceId, "new")
    assert.deepEqual(removed, [])
    assert.ok(sessions().get(instanceId)?.has(sessionId))
  })

  it("creating a session removes only a confirmed empty session and excludes the new one", async () => {
    const { removed, reads } = setup({ time: { created: 1, updated: 20 } })
    await createSession(instanceId)
    await cleanupBlankSessions(instanceId, "new")
    assert.deepEqual(removed, [sessionId])
    assert.deepEqual(reads, [{ sessionID: sessionId, limit: 1 }, { sessionID: sessionId, limit: 1 }])
    assert.ok(sessions().get(instanceId)?.has("new"))
  })

  for (const type of ["user", "assistant", "system", "synthetic", "shell", "compaction", "agent-switched"]) {
    it(`preserves native ${type} messages irrespective of UI visibility`, async () => {
      const { client, removed } = setup()
      client.message.list = async () => ({ data: [{ id: "message", type }], cursor: {} })
      assert.equal(await cleanupBlankSession(instanceId, sessionId), false)
      assert.deepEqual(removed, [])
    })
  }

  for (const [name, protect] of [
    ["optimistic message", residentMessage],
    ["draft", () => setSessionDraftPrompt(instanceId, sessionId, "unsent")],
    ["attachment", () => addAttachment(instanceId, sessionId, createFileAttachment("/work/keep.txt", "keep.txt"))],
    ["child", () => setSessions(previous => new Map(previous).set(instanceId,
      new Map(previous.get(instanceId)).set("child", session("child", { parentId: sessionId }))))],
    ["pending admission", () => { beginSessionGenerationAdmission(instanceId, sessionId) }],
  ] as const) {
    it(`preserves a local ${name} without relying on native messages`, async () => {
      const { removed, reads } = setup()
      protect()
      assert.equal(await cleanupBlankSession(instanceId, sessionId), false)
      assert.deepEqual(removed, [])
      assert.deepEqual(reads, [])
    })
  }

  for (const overrides of [
    { status: "working" }, { status: "compacting" }, { pendingPermission: true }, { pendingForm: true },
    { generationRecovery: "interrupted" }, { revert: { messageID: "hidden" } },
    { fork: { sessionID: "source", boundary: { type: "end" } } },
    { metadata: { pinned: true } },
  ] as Partial<Session>[]) {
    it(`preserves sessions with protected state ${JSON.stringify(overrides)}`, async () => {
      const { removed, reads } = setup(overrides)
      assert.equal(await cleanupBlankSession(instanceId, sessionId), false)
      assert.deepEqual(removed, [])
      assert.deepEqual(reads, [])
    })
  }

  for (const kind of ["inbox", "children", "active"] as const) {
    it(`preserves native ${kind} absent from the local store`, async () => {
      const { client, removed } = setup()
      if (kind === "inbox") client.session.inbox.list = async () => [{ id: "queued" }]
      if (kind === "children") client.session.list = async (input: any) => {
        assert.deepEqual(input, { parentID: sessionId, project: "project", limit: 1 })
        return { data: [{ id: "unloaded-child" }], cursor: {} }
      }
      if (kind === "active") client.session.active = async () => ({ [sessionId]: { type: "running" } })
      assert.equal(await cleanupBlankSession(instanceId, sessionId), false)
      assert.deepEqual(removed, [])
    })
  }

  for (const kind of ["messages", "session", "inbox", "children", "active", "delete"] as const) {
    it(`does not report cleanup success on ${kind} failure`, async () => {
      const { client, removed } = setup()
      const fail = async () => { throw new Error("unavailable") }
      if (kind === "messages") client.message.list = fail
      if (kind === "session") client.session.get = fail
      if (kind === "inbox") client.session.inbox.list = fail
      if (kind === "children") client.session.list = fail
      if (kind === "active") client.session.active = fail
      if (kind === "delete") client.session.remove = fail
      assert.equal(await cleanupBlankSession(instanceId, sessionId), false)
      assert.deepEqual(removed, [])
    })
  }

  it("preserves sessions where remote daemon metadata reports pinned: true", async () => {
    const { client, removed } = setup()
    client.session.get = async () => ({
      ...session(),
      metadata: { pinned: true },
    })
    assert.equal(await cleanupBlankSession(instanceId, sessionId), false)
    assert.deepEqual(removed, [])
  })

  for (const page of [{}, { data: null }, { data: [], cursor: { next: "more" } }]) {
    it(`does not treat an unconfirmed message page as empty: ${JSON.stringify(page)}`, async () => {
      const { client, removed } = setup()
      client.message.list = async () => page
      assert.equal(await cleanupBlankSession(instanceId, sessionId), false)
      assert.deepEqual(removed, [])
    })
  }

  for (const [name, change] of [
    ["message", residentMessage],
    ["draft", () => setSessionDraftPrompt(instanceId, sessionId, "arrived during fetch")],
    ["reconnect", () => destroyOpenCodeData(instanceId)],
  ] as const) {
    it(`abandons the empty result if a ${name} arrives during its reads`, async () => {
      const { client, removed } = setup()
      let resolve!: (value: unknown[]) => void
      client.session.inbox.list = () => new Promise(done => { resolve = done })
      const pending = cleanupBlankSession(instanceId, sessionId)
      await new Promise<void>(done => setImmediate(done))
      change()
      resolve([])
      assert.equal(await pending, false)
      assert.deepEqual(removed, [])
    })
  }

  it("stops the whole sweep after reconnect rather than admitting later stale candidates", async () => {
    const { client, removed } = setup()
    setSessions(previous => new Map(previous).set(instanceId, new Map(previous.get(instanceId)).set("second", session("second"))))
    const reads: string[] = []
    client.message.list = async ({ sessionID }: any) => {
      reads.push(sessionID)
      destroyOpenCodeData(instanceId)
      return emptyPage()
    }
    await cleanupBlankSessions(instanceId)
    assert.deepEqual(reads, [sessionId])
    assert.deepEqual(removed, [])
  })

  it("overlapping sweeps dispatch a single deletion", async () => {
    const { removed } = setup()
    await Promise.all([cleanupBlankSessions(instanceId), cleanupBlankSessions(instanceId)])
    assert.deepEqual(removed, [sessionId])
  })

  it("rechecks native messages after ancillary reads even before SSE has arrived", async () => {
    const { client, removed } = setup()
    let sent = false
    client.message.list = async () => ({ data: sent ? [{ id: "remote-prompt", type: "user" }] : [], cursor: {} })
    client.session.inbox.list = async () => { sent = true; return [] }
    assert.equal(await cleanupBlankSession(instanceId, sessionId), false)
    assert.deepEqual(removed, [])
  })

  it("a stalled historical read does not block creation or the first send, and overlapping sweeps coalesce", async () => {
    const { client, removed } = setup()
    let resolve!: (value: unknown) => void
    let reads = 0
    client.message.list = () => { reads++; return new Promise(done => { resolve = done }) }
    const prompts: string[] = []
    client.session.instructions = { entry: { put: async () => {}, remove: async () => {} } }
    client.session.switchAgent = async () => {}
    client.session.switchModel = async () => {}
    client.session.prompt = async (input: any) => { prompts.push(input.text); return { id: input.id } }
    // Check completion in one event-loop turn without depending on timing thresholds.
    let created = false
    const creating = createSession(instanceId).then(value => { created = true; return value })
    await new Promise<void>(done => setImmediate(done))
    try {
      assert.equal(created, true, "Historical I/O must not gate creation")
      const result = await creating
      await sendMessage(instanceId, result.id, "first prompt")
      assert.deepEqual(prompts, ["first prompt"])
      const firstSweep = cleanupBlankSessions(instanceId, result.id)
      const secondSweep = cleanupBlankSessions(instanceId, result.id)
      assert.equal(firstSweep, secondSweep)
      assert.equal(reads, 1)
      resolve({ data: [{ id: "old-message", type: "user" }], cursor: {} })
      await firstSweep
      assert.deepEqual(removed, [])
    } finally {
      resolve?.({ data: [{ id: "old-message", type: "user" }], cursor: {} })
      await creating
    }
  })
})
