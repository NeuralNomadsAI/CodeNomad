import assert from "node:assert/strict"
import { test } from "node:test"
import { sdkManager } from "../lib/sdk-manager.ts"
import { sseManager } from "../lib/sse-manager.ts"
import {
  applyOpenCodeDataEvent, destroyOpenCodeData, finishOpenCodeDataEvent,
  getOpenCodeMessageRevision, invalidateOpenCodeSessionContent,
} from "./opencode-data.ts"

const model = { providerID: "fixture", id: "fixture" }
function fixture(instanceId: string) {
  let sequence = 0, projections = 0
  const client: any = {
    session: { active: async () => ({}), get: async () => ({ id: "s" }),
      inbox: { list: async () => [] }, form: { list: async () => [] } },
    permission: { list: async () => [] },
    message: { list: async () => ({ data: [], cursor: {} }) },
  }
  ;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  let data!: ReturnType<typeof applyOpenCodeDataEvent>
  const emit = (type: string, payload: any = {}) => {
    data = applyOpenCodeDataEvent(instanceId, "/fixture", {
      type, id: `event-${++sequence}`, created: sequence,
      data: { sessionID: "s", ...payload }, location: { directory: "/fixture" },
    } as any, () => { projections++ })
    return data
  }
  return {
    emit, client, projections: () => projections,
    data: () => data,
    start: (id = "compact") => emit("session.compaction.started", { inputID: id, reason: "manual", recent: "" }),
    delta: (text: string) => emit("session.compaction.delta", { text }),
    summary: (id = "compact") => (data.session.message.get("s", id) as any)?.summary,
    cleanup: () => { destroyOpenCodeData(instanceId); sdkManager.destroyClientsForInstance(instanceId) },
  }
}

test("compaction chunks are fenced immediately, joined once, and preserve same-session order", ctx => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture("compaction-order")
  try {
    f.start()
    const revision = getOpenCodeMessageRevision("compaction-order", "s")
    for (let index = 0; index < 128; index++) f.delta(String(index))
    assert.equal(getOpenCodeMessageRevision("compaction-order", "s"), revision + 128)
    assert.equal(f.summary(), "")
    assert.equal(f.projections(), 0)
    ctx.mock.timers.tick(250)
    assert.equal(f.summary(), Array.from({ length: 128 }, (_, i) => String(i)).join(""))
    assert.equal(f.projections(), 1)
    f.delta("prefix")
    f.start("second")
    assert(f.summary()!.endsWith("prefix"), "second start flushes preceding running compaction")
    f.delta("second text")
    ctx.mock.timers.tick(250)
    assert.equal(f.summary("second"), "second text")
    assert.equal(f.projections(), 3)
    f.delta("pending")
    f.emit("session.compaction.ended", { reason: "manual", text: "final", recent: "" })
    ctx.mock.timers.tick(500)
    assert.equal(f.summary("second"), "final")
    assert.equal(f.projections(), 3, "ended supersedes buffered fragments without replay")
  } finally { f.cleanup() }
})

for (const boundary of ["failed", "delete", "reconnect", "prune", "revert", "dispose"] as const) {
  test(`pending compaction text cannot survive ${boundary}`, ctx => {
    ctx.mock.timers.enable({ apis: ["setTimeout"] })
    const instanceId = `compaction-${boundary}`
    const f = fixture(instanceId)
    try {
      f.start()
      f.delta("must not reappear")
      if (boundary === "failed") f.emit("session.compaction.failed", { reason: "manual", error: { type: "fixture", message: "failed" } })
      if (boundary === "delete") f.emit("session.deleted")
      if (boundary === "reconnect") f.emit("server.connected")
      if (boundary === "prune") invalidateOpenCodeSessionContent(instanceId, "s")
      if (boundary === "revert") f.emit("session.revert.committed", { to: "compact" })
      if (boundary === "dispose") destroyOpenCodeData(instanceId)
      ctx.mock.timers.tick(500)
      assert.equal(f.projections(), 0)
      if (boundary === "revert" || boundary === "delete") assert.equal(f.summary(), undefined)
      f.start("fresh")
      f.delta("new")
      ctx.mock.timers.tick(250)
      if (boundary !== "prune") assert.equal(f.summary("fresh"), "new")
    } finally { f.cleanup() }
  })
}

test("idle flushes pending compaction before retiring its reducer", ctx => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] })
  const f = fixture("compaction-idle")
  try {
    f.start()
    f.delta("last text")
    f.emit("session.idle")
    assert.equal(f.summary(), "last text")
    finishOpenCodeDataEvent("compaction-idle", { type: "session.idle", data: { sessionID: "s" } } as any)
    ctx.mock.timers.tick(500)
    assert.equal(f.projections(), 1)
  } finally { f.cleanup() }
})

test("same session IDs in distinct instances keep separate buffers and flush authority", ctx => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] })
  const first = fixture("compaction-instance-first"), second = fixture("compaction-instance-second")
  try {
    first.start(); second.start()
    first.delta("A"); second.delta("B")
    first.emit("session.usage.updated", { cost: 0, tokens: {} })
    assert.equal(first.summary(), "A")
    assert.equal(second.summary(), "")
    ctx.mock.timers.tick(250)
    assert.equal(second.summary(), "B")
    assert.equal(first.projections(), 1)
    assert.equal(second.projections(), 1)
  } finally { first.cleanup(); second.cleanup() }
})

test("SDK history reads flush pending chunks and reject a pre-delta page without duplication", async () => {
  const instanceId = "compaction-native-read"
  const previous = sseManager.getStatuses
  sseManager.getStatuses = () => new Map([[instanceId, "connected"]])
  const f = fixture(instanceId)
  const replies: Array<(value: any) => void> = []
  const page = (summary: string) => ({ data: [{ id: "compact", type: "compaction", status: "running",
    reason: "manual", summary, recent: "", model, time: { created: 1 } }], cursor: {} })
  f.client.message.list = () => new Promise(resolve => replies.push(resolve))
  try {
    const data = f.start()
    const read = data.session.message.sync("s")
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(replies.length, 1)
    f.delta("A")
    replies[0](page(""))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(replies.length, 2, "admitted buffered delta fences stale SDK read")
    replies[1](page("A"))
    await read
    assert.equal(f.summary(), "A", "authoritative page must not double-append buffered text")
    f.delta("B")
    data.session.message.invalidate("s")
    const nextRead = data.session.message.sync("s")
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.summary(), "AB", "pending text is reduced before a new native read")
    replies[2](page("AB"))
    await nextRead
    assert.equal(f.summary(), "AB")
    assert.equal(f.projections(), 2)
  } finally { f.cleanup(); sseManager.getStatuses = previous }
})

test("rotation at the 200-message boundary retains exactly one running compaction and its pending chunks", async () => {
  const f = fixture("compaction-rotation")
  try {
    for (let index = 0; index < 200; index++) {
      f.emit("session.step.started", { assistantMessageID: `m${index}`, agent: "build", model })
      f.emit("session.step.ended", { assistantMessageID: `m${index}`, finish: "stop" })
    }
    f.start()
    f.delta("A"); f.delta("B")
    // Same-session terminal delivery forces native order while the start is
    // still queued behind the bounded SDK snapshot rotation.
    f.emit("session.usage.updated", { cost: 0, tokens: {} })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.summary(), "AB")
    assert.equal(f.data().session.message.list("s").length, 200)
    assert.equal(f.data().session.message.list("s").filter(message => message.type === "compaction").length, 1)
  } finally { f.cleanup() }
})
