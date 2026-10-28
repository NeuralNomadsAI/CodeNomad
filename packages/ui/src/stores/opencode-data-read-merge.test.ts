import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { SessionMessageInfo } from "@opencode/client"
import { mergePageWithSnapshot, snapshotRows } from "./opencode-data-read-merge.ts"
import {
  armLive, assistantRow, delta, emitEvent, readFixture, readTestingModel as model,
  readTestingSessionId as sessionId, settleSync, textOf,
} from "./opencode-data-read-testing.ts"

const row = (id: string, text: string, completed?: number) =>
  ({ ...assistantRow(id, text), time: { created: 100, ...(completed === undefined ? {} : { completed }) } }) as unknown as SessionMessageInfo

/** Runs one reducer message sync whose fetches call `during` before answering `page(read)`. */
async function syncWith(instanceId: string, arm: () => void, during: (read: number) => void, page: (read: number) => unknown[]) {
  let reads = 0
  const f = readFixture(instanceId, async () => {
    reads += 1
    await new Promise<void>((resolve) => setImmediate(resolve))
    during(reads)
    return { data: page(reads), cursor: {} }
  })
  const data = armLive(instanceId)
  arm()
  data.session.message.invalidate(sessionId)
  try {
    await settleSync(data.session.message.sync(sessionId), () => reads)
  } catch (error) {
    f.cleanup()
    throw error
  }
  return { data, reads: () => reads, ids: () => data.session.message.list(sessionId).map((message) => message.id), cleanup: f.cleanup }
}

describe("OpenCode data read merge", () => {
  it("keeps changed live rows, takes the page for rows changed only by a step boundary, adds created rows", () => {
    const stamped = row("stamped", "page")
    const streamed = row("streamed", "base")
    const since = snapshotRows([stamped, streamed])
    const live = [row("stamped", "page", 7), row("streamed", "base more"), row("created", "new"), row("newer", "new")]
    const page = [row("streamed", "base m"), row("stamped", "page", 9)]
    const merged = mergePageWithSnapshot(live, page, since)
    assert.deepEqual(merged.map((message) => message.id), ["newer", "created", "streamed", "stamped"])
    assert.equal(merged[2], live[1], "a changed live row keeps its live version")
    assert.equal(merged[3], page[1], "a row whose only change is time.completed takes the page's terminal state")
  })

  for (const pageShape of ["empty", "disjoint", "overlapping"] as const) {
    it(`keeps a row the stream created during the fetch exactly once, with a ${pageShape} page`, async () => {
      const r = await syncWith(`opencode-merge-create-${pageShape}`, () => {}, () => {
        emitEvent(`opencode-merge-create-${pageShape}`, "session.step.started", { assistantMessageID: "fresh", agent: "build", model, started: 500 })
      }, () => pageShape === "empty" ? []
        : pageShape === "disjoint" ? [assistantRow("unrelated", "x", 900)]
          : [assistantRow("fresh", "page-snapshot", 500)])
      try {
        assert.equal(r.reads(), 1)
        assert.deepEqual(r.ids(), pageShape === "disjoint" ? ["unrelated", "fresh"] : ["fresh"])
        if (pageShape === "overlapping") assert.equal(textOf(r.data, "fresh"), "", "the created row lost its live version")
      } finally { r.cleanup() }
    })
  }

  it("keeps a terminal tool state an event delivered during the fetch", async () => {
    const instanceId = "opencode-merge-tool-terminal"
    const live = { assistantMessageID: "live", id: "tool" }
    const r = await syncWith(instanceId, () => {
      emitEvent(instanceId, "session.tool.input.started", { ...live, name: "bash" })
      emitEvent(instanceId, "session.tool.called", { ...live, input: {} })
    }, () => {
      emitEvent(instanceId, "session.tool.success", { ...live, content: [{ type: "text", text: "done" }], metadata: {} })
    }, () => [{ ...assistantRow("live", "base"), content: [{ type: "text", text: "base" }, {
      type: "tool", id: "tool", name: "bash", time: { created: 2 }, state: { status: "running", input: {}, metadata: {} },
    }] }])
    try {
      const tool = (r.data.session.message.get(sessionId, "live") as any)?.content?.find((part: any) => part.type === "tool")
      assert.equal(tool?.state?.status, "completed", "the page rewound the tool to running")
    } finally { r.cleanup() }
  })

  it("takes the page for identified parts a changed row left untouched", () => {
    const tool = (id: string, status: string, metadata: Record<string, unknown> = {}) =>
      ({ type: "tool", id, name: "bash", time: { created: 2 }, state: { status, input: {}, metadata } })
    const withTools = (...content: unknown[]) => ({ ...row("live", "base"), content: [{ type: "text", text: "base" }, ...content] }) as unknown as SessionMessageInfo
    const since = snapshotRows([withTools(tool("stranded", "streaming"), tool("busy", "running"))])
    const live = withTools(tool("stranded", "streaming"), tool("busy", "running", { progress: 1 }))
    const page = withTools(tool("stranded", "completed"), tool("busy", "running"))
    const [merged] = mergePageWithSnapshot([live], [page], since) as any[]
    assert.equal(merged.content[1].state.status, "completed", "an untouched part kept its stale live state")
    assert.deepEqual(merged.content[2].state.metadata, { progress: 1 }, "a changed part lost its live version")
    assert.equal(merged.content[0], (live as any).content[0], "parts without an identity stay live")
  })

  it("settles a stranded tool while a sibling tool reports progress during the fetch", async () => {
    const instanceId = "opencode-merge-sibling-progress"
    const stranded = { assistantMessageID: "live", id: "stranded" }
    const busy = { assistantMessageID: "live", id: "busy" }
    const pageTool = (id: string, state: Record<string, unknown>) => ({ type: "tool", id, name: "bash", time: { created: 2 }, state })
    const r = await syncWith(instanceId, () => {
      // The stranded tool never received `session.tool.called`.
      emitEvent(instanceId, "session.tool.input.started", { ...stranded, name: "bash" })
      emitEvent(instanceId, "session.tool.input.started", { ...busy, name: "bash" })
      emitEvent(instanceId, "session.tool.called", { ...busy, input: {} })
    }, () => {
      emitEvent(instanceId, "session.tool.progress", { ...busy, metadata: { progress: 1 } })
    }, () => [{ ...assistantRow("live", "base"), content: [{ type: "text", text: "base" },
      pageTool("stranded", { status: "completed", input: {}, metadata: {}, content: [{ type: "text", text: "ok" }] }),
      pageTool("busy", { status: "running", input: {}, metadata: {} })] }])
    try {
      const tools = (r.data.session.message.get(sessionId, "live") as any)?.content?.filter((part: any) => part.type === "tool")
      assert.equal(r.reads(), 1)
      assert.equal(tools?.find((part: any) => part.id === "stranded")?.state?.status, "completed", "the stranded tool stayed pending")
      assert.deepEqual(tools?.find((part: any) => part.id === "busy")?.state?.metadata, { progress: 1 }, "the sibling's progress was rewound")
    } finally { r.cleanup() }
  })

  it("keeps a shell exit and a synthetic row created during the fetch", async () => {
    const instanceId = "opencode-merge-shell-synthetic"
    const r = await syncWith(instanceId, () => {}, () => {
      emitEvent(instanceId, "session.shell.started", { shell: { id: "sh1", command: "watch", status: "running", metadata: {} } }, "evt_shell1")
      emitEvent(instanceId, "session.shell.ended", { shell: { id: "sh1", status: "exited", exit: 0 }, output: "done" })
      emitEvent(instanceId, "session.synthetic", { text: "context", description: "ctx" }, "evt_syn1")
    }, () => [{ id: "msg_shell1", type: "shell", shellID: "sh1", command: "watch", status: "running", time: { created: 10 } }])
    try {
      assert.deepEqual(r.ids(), ["msg_shell1", "msg_syn1"])
      const shell = r.data.session.message.get(sessionId, "msg_shell1") as any
      assert.equal(shell?.status, "exited", "the page rewound the shell to running")
      assert.equal(shell?.output, "done", "the shell's output was dropped")
    } finally { r.cleanup() }
  })

  it("drops a resident row the fetched page no longer has", async () => {
    const instanceId = "opencode-merge-stale-row"
    const r = await syncWith(instanceId, () => {
      emitEvent(instanceId, "session.step.started", { assistantMessageID: "stale", agent: "build", model, started: 90 })
    }, () => {}, () => [assistantRow("live", "base")])
    try {
      assert.deepEqual(r.ids(), ["live"])
    } finally { r.cleanup() }
  })

  for (const kind of ["revert", "cancel"] as const) {
    it(`restarts a read a ${kind} lands in, without resurrecting the removed row`, async () => {
      const instanceId = `opencode-merge-destructive-${kind}`
      const r = await syncWith(instanceId, () => {}, (read) => {
        // Streaming continues in every fetch; the row is created and removed
        // inside the first one, whose page still contains it.
        delta(instanceId)
        if (read !== 1) return
        if (kind === "revert") {
          emitEvent(instanceId, "session.step.started", { assistantMessageID: "removed", agent: "build", model, started: 200 })
          emitEvent(instanceId, "session.revert.committed", { to: "removed" })
        } else {
          emitEvent(instanceId, "session.inbox.enqueued", {
            inboxID: "removed", item: { type: "user", payload: { text: "cancel me" }, delivery: "queue" },
          })
          emitEvent(instanceId, "session.inbox.cancelled", { inboxID: "removed" })
        }
      }, (read) => read === 1
        ? [assistantRow("removed", "stale", 200), assistantRow("live", "base")]
        : [assistantRow("live", "base")])
      try {
        assert.equal(r.reads(), 2, "the destructive event did not restart the read")
        assert.deepEqual(r.ids(), ["live"], "the removed row resurrected")
        assert.equal(textOf(r.data, "live"), "baseXX", "the restarted read rewound streamed text")
      } finally { r.cleanup() }
    })
  }
})
