import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { sdkManager } from "../lib/sdk-manager.ts"
import { serverApi } from "../lib/api-client.ts"
import type { Session } from "../types/session.ts"
import { addInstance, handleInstanceInvalidation, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { loadMessages } from "./session-api.ts"
import { destroyOpenCodeData } from "./opencode-data.ts"
import { setActiveSession, setSessions } from "./session-state.ts"

const model = { providerID: "provider", id: "model" }
const user = (id: string, text = id) => ({ id, type: "user", text, time: { created: 1 } })
const assistant = (id: string, text: string, completed = false) => ({
  id, type: "assistant", agent: "build", model, content: [{ type: "text", text }],
  time: completed ? { created: 2, completed: 3 } : { created: 2 },
})
const settle = async (turns = 12) => {
  for (let turn = 0; turn < turns; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

function session(instanceId: string, id: string, status: Session["status"] = "working"): Session {
  return {
    id, instanceId, parentId: null, title: id, agent: "build", model: { providerId: "provider", modelId: "model" },
    status, retry: null, idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
    version: "1", projectID: "project", location: { directory: "/work" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
  }
}

/** A real instance dispatcher over an in-memory native message page. */
function fixture(instanceId: string, sessionIds = ["s"]) {
  const originalFetchWorktrees = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: "/work", kind: "root" }] }) as any
  const pages = new Map<string, unknown[]>(sessionIds.map((id) => [id, []]))
  const reads: Array<{ sessionID: string; limit?: number }> = []
  let duringFetch: ((sessionID: string) => void) | undefined
  const client: any = {
    session: { active: async () => Object.fromEntries(sessionIds.map((id) => [id, {}])) },
    message: {
      list: async (input: { sessionID: string; limit?: number }) => {
        reads.push({ sessionID: input.sessionID, limit: input.limit })
        const page = [...(pages.get(input.sessionID) ?? [])]
        await new Promise<void>((resolve) => setImmediate(resolve))
        duringFetch?.(input.sessionID)
        return { data: page.reverse(), cursor: {} }
      },
    },
  }
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setSessions((previous) => new Map(previous).set(instanceId, new Map(sessionIds.map((id) => [id, session(instanceId, id)]))))
  setActiveSession(instanceId, sessionIds[0])
  let sequence = 0
  const native = (type: string, payload: Record<string, unknown>, sessionID = sessionIds[0]) => handleInstanceInvalidation(instanceId, {
    id: `evt_${++sequence}`, type, created: 100 + sequence, location: { directory: "/work" }, data: { sessionID, ...payload },
  } as any)
  const store = () => messageStoreBus.getOrCreate(instanceId)
  const text = (messageId: string) => Object.values(store().getMessage(messageId)?.parts ?? {})
    .map((part: any) => String(part.data?.text ?? "")).join("")
  return {
    pages, reads, native, store, text,
    setDuringFetch(next?: (sessionID: string) => void) { duringFetch = next },
    dispose() {
      serverApi.fetchWorktrees = originalFetchWorktrees
      destroyOpenCodeData(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
      setSessions((previous) => { const next = new Map(previous); next.delete(instanceId); return next })
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
    },
  }
}

describe("live transcript divergence repair", () => {
  it("repairs a watched session whose step start was missed, with one coalesced read", async () => {
    const f = fixture("divergence-missed-step")
    try {
      f.pages.set("s", [user("msg_u1")])
      await loadMessages("divergence-missed-step", "s")
      await settle()
      assert.equal(f.reads.length, 1)

      // OpenCode persisted the reply, but its `session.step.started` never
      // reached this window: every later event targets an unknown message.
      f.pages.set("s", [user("msg_u1"), assistant("msg_a1", "Hel")])
      f.native("session.text.started", { assistantMessageID: "msg_a1" })
      for (const delta of ["H", "e", "l"]) f.native("session.text.delta", { assistantMessageID: "msg_a1", ordinal: 0, delta })
      await settle()
      assert.equal(f.reads.length, 2, "a burst of unknown-target events owes exactly one authoritative read")
      assert.equal(f.text("msg_a1"), "Hel", "the repair read must publish the authoritative reply")

      f.native("session.text.delta", { assistantMessageID: "msg_a1", ordinal: 0, delta: "lo" })
      assert.equal(f.text("msg_a1"), "Hello", "the reseeded reducer applies later deltas")
      f.native("session.text.ended", { assistantMessageID: "msg_a1", ordinal: 0, text: "Hello!" })
      f.native("session.step.ended", { assistantMessageID: "msg_a1", finish: "stop", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } })
      f.native("session.execution.succeeded", {})
      await settle()
      assert.equal(f.text("msg_a1"), "Hello!")
      assert.equal(f.reads.length, 2, "a healed transcript owes no settlement read")
    } finally { f.dispose() }
  })

  it("keeps rows streamed during the repair read and stays bounded when OpenCode lacks the message", async () => {
    const f = fixture("divergence-bounded")
    try {
      f.pages.set("s", [user("msg_u1")])
      await loadMessages("divergence-bounded", "s")
      await settle()
      // The page keeps lacking the reply: repairs stop after a bounded number.
      for (let index = 0; index < 12; index += 1) {
        f.native("session.text.delta", { assistantMessageID: "msg_ghost", ordinal: 0, delta: "x" })
        await settle()
      }
      const capped = f.reads.length
      assert.ok(capped > 1 && capped <= 4, `repairs must be bounded (saw ${capped - 1})`)

      // A newer step streamed while a read is in flight is never discarded.
      f.setDuringFetch(() => {
        f.setDuringFetch(undefined)
        f.native("session.step.started", { assistantMessageID: "msg_a2", agent: "build", model, started: 5 })
        f.native("session.text.started", { assistantMessageID: "msg_a2" })
        f.native("session.text.delta", { assistantMessageID: "msg_a2", ordinal: 0, delta: "live" })
      })
      // Settlement still owes an authoritative read for the unhealed transcript.
      f.pages.set("s", [user("msg_u1"), assistant("msg_ghost", "Ghost reply", true)])
      f.native("session.execution.succeeded", {})
      await settle()
      assert.equal(f.reads.length, capped + 1, "settlement of a diverged transcript reads authoritatively once")
      assert.equal(f.text("msg_ghost"), "Ghost reply")
      assert.equal(f.text("msg_a2"), "live", "the repair must keep rows streamed during its fetch")
    } finally { f.dispose() }
  })

  it("never publishes a repair page that a deletion made stale", async () => {
    const f = fixture("divergence-stale")
    try {
      f.pages.set("s", [user("msg_u1")])
      await loadMessages("divergence-stale", "s")
      await settle()
      f.pages.set("s", [user("msg_u1"), assistant("msg_a1", "Late")])
      f.setDuringFetch(() => {
        f.setDuringFetch(undefined)
        f.native("session.deleted", {})
      })
      f.native("session.text.delta", { assistantMessageID: "msg_a1", ordinal: 0, delta: "L" })
      await settle()
      assert.equal(f.reads.length, 2)
      assert.equal(f.store().getMessage("msg_a1"), undefined, "a page fetched before the deletion must not publish")
    } finally { f.dispose() }
  })

  it("repairs a transcript whose reducer threw on a live event", async () => {
    const f = fixture("divergence-reduce-failure")
    try {
      f.pages.set("s", [user("msg_u1")])
      await loadMessages("divergence-reduce-failure", "s")
      await settle()
      f.native("session.step.started", { assistantMessageID: "msg_a1", agent: "build", model, started: 5 })
      f.native("session.tool.input.started", { assistantMessageID: "msg_a1", id: "tool_1", name: "read" })
      f.native("session.tool.called", { assistantMessageID: "msg_a1", id: "tool_1", input: {}, executed: false })
      f.pages.set("s", [user("msg_u1"), { ...assistant("msg_a1", ""), content: [{ type: "text", text: "Recovered" }] }])
      // A malformed native payload makes the SDK reducer throw mid-event.
      assert.doesNotThrow(() => f.native("session.tool.success", { assistantMessageID: "msg_a1", id: "tool_1", metadata: {}, content: 5 }))
      await settle()
      assert.equal(f.reads.length, 2, "the failed reduction owes one authoritative read")
      assert.equal(f.text("msg_a1"), "Recovered")
    } finally { f.dispose() }
  })

  it("repairs a missed tool while a sibling tool changes during the read", async () => {
    const f = fixture("divergence-sibling-tool")
    const tool = (id: string, status: string) => ({ type: "tool", id, name: "read", time: { created: 5 },
      state: status === "completed" ? { status, input: {}, metadata: {}, content: [] } : { status, input: {}, metadata: {} } })
    const toolStatus = (messageId: string, id: string) => (f.store().getMessage(messageId)?.parts as any)?.[id]?.data?.state?.status
    try {
      f.pages.set("s", [user("msg_u1")])
      await loadMessages("divergence-sibling-tool", "s")
      await settle()
      f.native("session.step.started", { assistantMessageID: "msg_a1", agent: "build", model, started: 5 })
      f.native("session.tool.input.started", { assistantMessageID: "msg_a1", id: "tool_a", name: "read" })
      f.native("session.tool.called", { assistantMessageID: "msg_a1", id: "tool_a", input: {}, executed: false })
      // Tool B's start and call never arrived; its success owes a repair, and
      // tool A completes while that read is in flight.
      f.pages.set("s", [user("msg_u1"), { ...assistant("msg_a1", ""), content: [tool("tool_a", "running"), tool("tool_b", "completed")] }])
      f.setDuringFetch(() => {
        f.setDuringFetch(undefined)
        f.native("session.tool.success", { assistantMessageID: "msg_a1", id: "tool_a", metadata: {}, content: [] })
      })
      f.native("session.tool.success", { assistantMessageID: "msg_a1", id: "tool_b", metadata: {}, content: [] })
      await settle()
      assert.equal(f.reads.length, 2)
      assert.equal(toolStatus("msg_a1", "tool_a"), "completed", "the live change of tool A is kept")
      assert.equal(toolStatus("msg_a1", "tool_b"), "completed", "the fetched tool B must join the live-changed row")
    } finally { f.dispose() }
  })

  it("keeps a missed part diverged until a page holds it", async () => {
    const f = fixture("divergence-part-heal")
    try {
      f.pages.set("s", [user("msg_u1")])
      await loadMessages("divergence-part-heal", "s")
      await settle()
      f.native("session.step.started", { assistantMessageID: "msg_a1", agent: "build", model, started: 5 })
      // The page holds the message but not yet tool B.
      f.pages.set("s", [user("msg_u1"), { ...assistant("msg_a1", ""), content: [] }])
      f.native("session.tool.success", { assistantMessageID: "msg_a1", id: "tool_b", metadata: {}, content: [] })
      await settle()
      assert.equal(f.reads.length, 2)
      f.pages.set("s", [user("msg_u1"), { ...assistant("msg_a1", "", true), content: [
        { type: "tool", id: "tool_b", name: "read", time: { created: 5 }, state: { status: "completed", input: {}, metadata: {}, content: [] } }] }])
      f.native("session.step.ended", { assistantMessageID: "msg_a1", finish: "stop", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } })
      f.native("session.execution.succeeded", {})
      await settle()
      assert.equal(f.reads.length, 3, "settlement still owes the read for the absent part")
      assert.equal((f.store().getMessage("msg_a1")?.parts as any)?.tool_b?.data?.state?.status, "completed")
    } finally { f.dispose() }
  })

  it("detects a missed later text start by its ordinal instead of editing the earlier fragment", async () => {
    const f = fixture("divergence-text-ordinal")
    const fragments = (...texts: string[]) => ({ ...assistant("msg_a1", "", true), content: texts.map((text) => ({ type: "text", text })) })
    try {
      f.pages.set("s", [user("msg_u1")])
      await loadMessages("divergence-text-ordinal", "s")
      await settle()
      f.native("session.step.started", { assistantMessageID: "msg_a1", agent: "build", model, started: 5 })
      f.native("session.text.started", { assistantMessageID: "msg_a1", ordinal: 0 })
      f.native("session.text.delta", { assistantMessageID: "msg_a1", ordinal: 0, delta: "First" })
      f.native("session.text.ended", { assistantMessageID: "msg_a1", ordinal: 0, text: "First" })
      // Fragment 1's start is lost; the page does not hold that fragment yet.
      f.pages.set("s", [user("msg_u1"), fragments("First")])
      f.native("session.text.delta", { assistantMessageID: "msg_a1", ordinal: 1, delta: "Sec" })
      await settle()
      assert.equal(f.reads.length, 2, "a delta for a fragment the reducer lacks owes a repair read")
      assert.equal(f.text("msg_a1"), "First", "a misaligned delta must not edit the earlier fragment")
      f.pages.set("s", [user("msg_u1"), fragments("First", "Second")])
      f.native("session.text.ended", { assistantMessageID: "msg_a1", ordinal: 1, text: "Second" })
      f.native("session.step.ended", { assistantMessageID: "msg_a1", finish: "stop", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } })
      f.native("session.execution.succeeded", {})
      await settle()
      assert.equal(f.text("msg_a1"), "FirstSecond")
      assert.equal(f.reads.length, 3, "fragment 1 stays owed until a page holds it")
    } finally { f.dispose() }
  })

  it("reads at settlement a later fragment the repair page did not hold yet", async () => {
    const f = fixture("divergence-text-ordinal-heal")
    const fragments = (completed: boolean, ...texts: string[]) => ({ ...assistant("msg_a1", "", completed), content: texts.map((text) => ({ type: "text", text })) })
    try {
      f.pages.set("s", [user("msg_u1")])
      await loadMessages("divergence-text-ordinal-heal", "s")
      await settle()
      f.native("session.step.started", { assistantMessageID: "msg_a1", agent: "build", model, started: 5 })
      f.native("session.text.started", { assistantMessageID: "msg_a1", ordinal: 0 })
      f.native("session.text.ended", { assistantMessageID: "msg_a1", ordinal: 0, text: "First" })
      f.pages.set("s", [user("msg_u1"), fragments(false, "First")])
      f.native("session.text.delta", { assistantMessageID: "msg_a1", ordinal: 1, delta: "Sec" })
      await settle()
      assert.equal(f.reads.length, 2)
      // Fragment 1's remaining events are lost too; only settlement remains.
      f.pages.set("s", [user("msg_u1"), fragments(true, "First", "Second")])
      f.native("session.execution.succeeded", {})
      await settle()
      assert.equal(f.reads.length, 3, "a page holding fragment 0 does not settle fragment 1")
      assert.equal(f.text("msg_a1"), "FirstSecond")
    } finally { f.dispose() }
  })

  it("drops a delayed delta for a fragment the page holds complete", async () => {
    const f = fixture("divergence-closed-fragment")
    try {
      f.pages.set("s", [user("msg_u1"), { ...assistant("msg_a1", ""), content: [{ type: "text", text: "Done", native: { item: "t1" } }] }])
      await loadMessages("divergence-closed-fragment", "s")
      await settle()
      // The page already committed the fragment; its delayed delta arrives and its ending is lost.
      f.native("session.text.delta", { assistantMessageID: "msg_a1", ordinal: 0, delta: "Done" })
      f.native("session.step.ended", { assistantMessageID: "msg_a1", finish: "stop", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } })
      f.native("session.execution.succeeded", {})
      await settle()
      assert.equal(f.text("msg_a1"), "Done", "a redelivered delta duplicated committed text")
      assert.equal(f.reads.length, 1)
    } finally { f.dispose() }
  })

  it("owes settlement a read when a delta for a partial page fragment loses its ending", async () => {
    const f = fixture("divergence-partial-fragment")
    try {
      f.pages.set("s", [user("msg_u1"), assistant("msg_a1", "Hel")])
      await loadMessages("divergence-partial-fragment", "s")
      await settle()
      // Redelivered or new? A partial page fragment cannot tell: the delta
      // applies (here a redelivery), and its full-text ending is lost.
      f.native("session.text.delta", { assistantMessageID: "msg_a1", ordinal: 0, delta: "Hel" })
      await settle()
      assert.equal(f.reads.length, 1, "an ambiguous delta reads nothing mid-stream")
      f.pages.set("s", [user("msg_u1"), { ...assistant("msg_a1", "", true), content: [{ type: "text", text: "Hello", native: { item: "t1" } }] }])
      f.native("session.execution.succeeded", {})
      await settle()
      assert.equal(f.reads.length, 2, "settlement reads the fragment whose ending never came")
      assert.equal(f.text("msg_a1"), "Hello")
    } finally { f.dispose() }
  })

  it("settles a partial page fragment through its delivered ending without a read", async () => {
    const f = fixture("divergence-partial-ended")
    try {
      f.pages.set("s", [user("msg_u1"), assistant("msg_a1", "Hel")])
      await loadMessages("divergence-partial-ended", "s")
      await settle()
      f.native("session.text.delta", { assistantMessageID: "msg_a1", ordinal: 0, delta: "lo" })
      assert.equal(f.text("msg_a1"), "Hello", "a new delta after the page's content still applies")
      f.native("session.text.ended", { assistantMessageID: "msg_a1", ordinal: 0, text: "Hello" })
      f.native("session.execution.succeeded", {})
      await settle()
      assert.equal(f.reads.length, 1)
      assert.equal(f.text("msg_a1"), "Hello")
    } finally { f.dispose() }
  })

  it("defers an unwatched session's repair until it is opened", async () => {
    const f = fixture("divergence-unwatched", ["s", "other"])
    try {
      f.pages.set("s", [user("msg_u1")])
      await loadMessages("divergence-unwatched", "s")
      await settle()
      const before = f.reads.length
      f.pages.set("other", [user("msg_o1"), assistant("msg_o2", "Busy")])
      for (const delta of ["B", "u", "s", "y"]) f.native("session.text.delta", { assistantMessageID: "msg_o2", ordinal: 0, delta }, "other")
      f.native("session.text.ended", { assistantMessageID: "msg_o2", ordinal: 0, text: "Busy" }, "other")
      await settle()
      assert.equal(f.reads.length, before, "unwatched sessions are never fetched for divergence")

      setActiveSession("divergence-unwatched", "other")
      await loadMessages("divergence-unwatched", "other")
      await settle()
      assert.equal(f.reads.length, before + 1)
      f.native("session.text.delta", { assistantMessageID: "msg_o2", ordinal: 0, delta: "!" }, "other")
      assert.equal(f.text("msg_o2"), "Busy!", "opening reseeds the reducer from the loaded page")
      assert.equal(f.reads.length, before + 1, "the loaded page reseeds without another read")
    } finally { f.dispose() }
  })

  it("seeds a reducer that already holds a parked inbox row from the first page", async () => {
    const f = fixture("divergence-inbox-first")
    try {
      f.native("session.inbox.enqueued", { inboxID: "msg_u2", item: { type: "user", payload: { text: "Queued" }, delivery: "queue" } })
      f.pages.set("s", [user("msg_u1"), assistant("msg_a1", "BASE")])
      await loadMessages("divergence-inbox-first", "s")
      await settle()
      f.native("session.text.delta", { assistantMessageID: "msg_a1", ordinal: 0, delta: "X" })
      assert.equal(f.text("msg_a1"), "BASEX", "the streaming reply froze behind the parked row")
      assert.equal(f.reads.length, 1, "the loaded page seeds the reducer without another read")
    } finally { f.dispose() }
  })

  it("reseeds the reducer from a forced reload that contains a missed step", async () => {
    const f = fixture("divergence-forced-reload")
    try {
      f.pages.set("s", [user("msg_u1"), assistant("msg_a1", "First", true)])
      await loadMessages("divergence-forced-reload", "s")
      await settle()
      // The second step started while this window missed its start event; a
      // forced reload (reconnect, invalidation) reads it from OpenCode.
      f.pages.set("s", [user("msg_u1"), assistant("msg_a1", "First", true), assistant("msg_a2", "PART")])
      await loadMessages("divergence-forced-reload", "s", { force: true })
      await settle()
      assert.equal(f.text("msg_a2"), "PART")
      f.native("session.text.delta", { assistantMessageID: "msg_a2", ordinal: 0, delta: "Y" })
      assert.equal(f.text("msg_a2"), "PARTY", "the reloaded step must keep streaming")
      assert.equal(f.reads.length, 2, "the reloaded page reseeds the reducer without another read")
    } finally { f.dispose() }
  })
})
