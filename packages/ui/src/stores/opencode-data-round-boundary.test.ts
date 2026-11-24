import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeEvent } from "@opencode/client"
import { sdkManager } from "../lib/sdk-manager.ts"
import { sseManager } from "../lib/sse-manager.ts"
import { addInstance, handleInstanceInvalidation, removeInstance } from "./instances.ts"
import { messageStoreBus } from "./message-v2/bus.ts"
import { destroyOpenCodeData, applyOpenCodeDataEvent } from "./opencode-data.ts"
import { handleNativeSessionEvent } from "./session-events.ts"
import { setActiveSession, setSessions } from "./session-state.ts"
import { getPartStartedAt } from "../lib/message-timing.ts"
import { indexSubagentDeliveries, latestReportForLaunch } from "../components/tool-call/renderers/subagent-report.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const model = { providerID: "fixture", id: "fixture" }
const childId = "ses_child"
const reportText = `<subagent sessionID="${childId}" state="completed" description="Work">\nChild result\n</subagent>`

/** A round-1 assistant row whose task tool is a background launch acknowledgement. */
const launchRow = {
  id: "m1", type: "assistant", agent: "build", model,
  time: { created: 1, completed: 2 }, content: [{
    type: "tool", id: "task_1", name: "task", time: { created: 2, ran: 3, completed: 4 },
    state: {
      status: "completed",
      input: { description: "do work" },
      content: [{ type: "text", text: "launched" }],
      metadata: { sessionID: childId, status: "running" },
    },
  }],
}
const reportRow = { id: "msg_rep", type: "synthetic", text: reportText, time: { created: 5 } }

type Page = { data: unknown[]; cursor: Record<string, string> }

function fixture(instanceId: string) {
  const sessionId = "s"
  const status = sseManager.getRawStatus
  sseManager.getRawStatus = id => id === instanceId ? "connected" : null
  const active = deferred<Record<string, unknown>>()
  const reads: ReturnType<typeof deferred<Page>>[] = []
  const client = {
    session: {
      active: () => active.promise,
      get: async () => ({ id: sessionId, location: { directory: "/fixture" }, time: { created: 1, updated: 5 } }),
      inbox: { list: async () => [] },
      form: { list: async () => [] },
    },
    permission: { list: async () => [] },
    message: { list: (input: { limit?: number }) => {
      assert.equal(input.limit, 20, "this race must exercise the native reducer's history read")
      const read = deferred<Page>()
      reads.push(read)
      return read.promise
    } },
  } as any
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
    id: sessionId, instanceId, title: "Fixture", parentId: null, location: { directory: "/fixture" },
    status: "working", agent: "build", model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 1 },
  } as any]])))
  setActiveSession(instanceId, sessionId)
  let sequence = 0
  const emit = (type: string, data: Record<string, unknown>) => {
    const created = ++sequence
    const event = { id: `evt_${created}`, type, created, data, location: { directory: "/fixture" } } as OpenCodeEvent
    handleInstanceInvalidation(instanceId, event)
    handleNativeSessionEvent(instanceId, event)
  }
  const store = messageStoreBus.getOrCreate(instanceId)
  /** Mirrors readBackgroundReport: the card's report for the m1 launch. */
  const report = () => {
    const messageIds = store.getSessionMessageIds(sessionId)
    const index = indexSubagentDeliveries(messageIds, id => store.getMessage(id))
    const launch = store.getMessage("m1")
    const toolPart = Object.values(launch?.parts ?? {}).map(part => (part as any).data).find((part: any) => part.type === "tool")
    if (!toolPart) return undefined
    const launchedAt = getPartStartedAt(toolPart) ?? launch?.createdAt ?? 0
    return latestReportForLaunch(index.get(childId), launchedAt, (messageId, partId) => {
      const text = (store.getMessage(messageId)?.parts[partId]?.data as { text?: unknown } | undefined)?.text
      return typeof text === "string" ? text : undefined
    })
  }
  /** Every resident message must survive each boundary: nothing drops, nothing nulls. */
  const residents = () => store.getSessionMessageIds(sessionId)
  return {
    reads, emit, store, report, residents, active, sessionId,
    /** Round 1 runs a background task tool whose terminal event is only in the page. */
    async roundOneLaunch() {
      const base = { sessionID: sessionId, assistantMessageID: "m1" }
      emit("session.step.started", { ...base, agent: "build", model, started: 1 })
      emit("session.tool.input.started", { ...base, id: "task_1", name: "task" })
      emit("session.tool.called", { ...base, id: "task_1", input: { description: "do work" } })
      emit("session.execution.succeeded", { sessionID: sessionId })
      assert.equal(reads.length, 1, "round 1 settlement read started")
      reads[0].resolve({ data: [reportRow, launchRow], cursor: {} })
      await flush()
    },
    cleanup() {
      destroyOpenCodeData(instanceId)
      active.resolve({})
      for (const read of reads) read.resolve({ data: [], cursor: {} })
      sseManager.getRawStatus = status
      removeInstance(instanceId, { authoritative: false })
      sdkManager.destroyClientsForInstance(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    },
  }
}

async function flush() {
  await new Promise<void>(resolve => setImmediate(resolve))
}

test("a background subagent's report stays readable across every later round boundary", async () => {
  const f = fixture("round-boundary-subagent-report")
  /** Resident rows may be joined by new ones; none may ever drop. */
  const keepsResidents = (before: readonly string[]) => {
    const after = f.residents()
    for (const id of before) assert.ok(after.includes(id), `resident row ${id} disappeared: ${JSON.stringify(after)}`)
    return after
  }
  const keepsReport = () => {
    assert.ok(f.report()?.body === "Child result", `the subagent report became unreadable: residents=${JSON.stringify(f.residents())}`)
  }
  try {
    await f.roundOneLaunch()
    keepsReport()
    let settled = f.residents()
    assert.ok(settled.includes("m1") && settled.includes("msg_rep"), `round 1 settles with the launch row and report resident: ${JSON.stringify(settled)}`)

    // The next turn starts on a retired reducer: the new event lands on a fresh
    // reducer holding only its own row while the resident page must survive.
    const next = { sessionID: f.sessionId, assistantMessageID: "m2" }
    f.emit("session.step.started", { ...next, agent: "build", model, started: 6 })
    await flush()
    settled = keepsResidents(settled)
    assert.ok(settled.includes("m2"), "the next round's assistant row is resident")
    keepsReport()

    f.emit("session.text.started", next)
    f.emit("session.text.delta", { ...next, delta: "reply" })
    await flush()
    keepsResidents(settled)
    keepsReport()

    f.emit("session.step.ended", { ...next, finish: "stop", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
    f.emit("session.execution.succeeded", { sessionID: f.sessionId })
    await flush()
    keepsResidents(settled)
    keepsReport()

    // A third round exercises the fully retired path again.
    f.emit("session.step.started", { sessionID: f.sessionId, assistantMessageID: "m3", agent: "build", model, started: 9 })
    await flush()
    keepsResidents(settled)
    keepsReport()
  } finally { f.cleanup() }
})

test("a delivered prompt keeps every resident row through its repair read and the round it starts", async () => {
  const f = fixture("round-boundary-delivery-residents")
  const keepsResidents = (before: readonly string[]) => {
    const after = f.residents()
    for (const id of before) assert.ok(after.includes(id), `resident row ${id} disappeared: ${JSON.stringify(after)}`)
    return after
  }
  try {
    // Round 1 holds its settlement read open while the user's next prompt parks
    // in the inbox (the daemon's page is already ahead of its SSE delivery).
    const base = { sessionID: f.sessionId, assistantMessageID: "m1" }
    f.emit("session.step.started", { ...base, agent: "build", model, started: 1 })
    f.emit("session.tool.input.started", { ...base, id: "task_1", name: "task" })
    f.emit("session.tool.called", { ...base, id: "task_1", input: { description: "do work" } })
    f.emit("session.execution.succeeded", { sessionID: f.sessionId })
    assert.equal(f.reads.length, 1, "round 1 settlement read started")
    f.emit("session.inbox.enqueued", { sessionID: f.sessionId, inboxID: "msg_user", item: { type: "user", payload: { text: "crossing prompt" }, delivery: "steer" } })

    // The page carries the delivered prompt and the daemon's reply above it.
    const userRow = { id: "msg_user", type: "user", text: "crossing prompt", time: { created: 5 } }
    const replyRow = { id: "reply", type: "assistant", agent: "build", model, time: { created: 6 }, content: [{ type: "text", text: "answer" }] }
    f.reads[0].resolve({ data: [replyRow, userRow, reportRow, launchRow], cursor: {} })
    await flush()
    let settled = keepsResidents(["m1", "msg_rep"])
    assert.ok(settled.includes("msg_user") && settled.includes("reply"), `the HTTP-ahead page reconciled its rows: ${JSON.stringify(settled)}`)
    assert.ok(settled.indexOf("msg_rep") < settled.indexOf("msg_user") && settled.indexOf("msg_user") < settled.indexOf("reply"),
      `native order must place the prompt above its reply: ${JSON.stringify(settled)}`)

    // The delivery's own SSE event trails: the SDK relocates the prompt to its
    // tail and the relocation owes an authoritative repair read.
    f.emit("session.inbox.delivered", { sessionID: f.sessionId, inboxID: "msg_user" })
    assert.ok(f.reads.length >= 2, "the relocating delivery owed a repair read")
    settled = keepsResidents(settled)
    f.reads[f.reads.length - 1].resolve({ data: [replyRow, userRow, reportRow, launchRow], cursor: {} })
    await flush()
    settled = keepsResidents(settled)
    assert.ok(settled.indexOf("msg_user") < settled.indexOf("reply"), `the prompt sank below its reply after the repair: ${JSON.stringify(settled)}`)
    assert.ok(f.report()?.body === "Child result", "the delivery repair lost the subagent report")

    // The next round the prompt starts must not drop the prior round either.
    f.emit("session.step.started", { sessionID: f.sessionId, assistantMessageID: "m2", agent: "build", model, started: 7 })
    await flush()
    settled = keepsResidents(settled)
    assert.ok(f.report()?.body === "Child result", `the prompt's round lost the subagent report: ${JSON.stringify(settled)}`)
  } finally { f.cleanup() }
})
