import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { messageStoreBus } from "./message-v2/bus.ts"
import { applyOpenCodeDataEvent, projectOpenCodeMessages } from "./opencode-data.ts"
import { armLive, assistantRow, deltaDuring, readFixture, readTestingModel as model, readTestingSessionId as sessionId, settleSync, textOf } from "./opencode-data-read-testing.ts"

const toolStateOf = (data: ReturnType<typeof applyOpenCodeDataEvent>, messageId: string) => {
  const row: any = data.session.message.get(sessionId, messageId)
  return (row?.content?.find((part: any) => part.type === "tool")?.state as any)?.status
}

describe("OpenCode data read merge scenarios", () => {
  for (const revertOnRead of [1, 2, 3]) {
    it(`never republishes a revert that lands during read ${revertOnRead}`, async () => {
      const instanceId = `opencode-merge-revert-${revertOnRead}`
      let reads = 0
      const f = readFixture(instanceId, async () => {
        reads += 1
        await new Promise<void>((resolve) => setImmediate(resolve))
        deltaDuring(instanceId, reads)
        if (reads < revertOnRead) {
          // Keep the read contended without removing anything.
          applyOpenCodeDataEvent(instanceId, "/work", {
            id: `hold-${reads}`, type: "session.revert.committed", created: 3000 + reads,
            data: { sessionID: sessionId, to: `zzz-${reads}` },
          } as any)
        }
        if (reads === revertOnRead) {
          applyOpenCodeDataEvent(instanceId, "/work", {
            id: "revert", type: "session.revert.committed", created: 2000,
            data: { sessionID: sessionId, to: "reverted" },
          } as any)
        }
        return { data: reads <= revertOnRead ? [assistantRow("reverted", "gone", 50), assistantRow("live", "base", 100)] : [], cursor: {} }
      })
      try {
        const data = armLive(instanceId)
        data.session.message.invalidate(sessionId)
        await settleSync(data.session.message.sync(sessionId), () => reads)
        const ids = data.session.message.list(sessionId).map((message) => message.id)
        assert.ok(!ids.includes("reverted"), `reverted row republished: ${JSON.stringify(ids)}`)
        assert.ok(reads <= 5, `${reads} reads for one revert`)
      } finally {
        f.cleanup()
      }
    })
  }

  it("answers with live rows alone when destructive events outlast the attempts", async () => {
    const instanceId = "opencode-merge-exhausted"
    let reads = 0
    let suffix = 0
    const authoritative = [assistantRow("history", "settled", 10), {
      id: "live", type: "assistant", agent: "build", model, time: { created: 100, completed: 400 },
      content: [{ type: "text", text: "BASEXXX" }, {
        type: "tool", id: "tool", name: "bash", time: { created: 2, ran: 3, completed: 4 },
        state: { status: "completed", input: {}, metadata: {}, content: [] },
      }],
    }]
    const f = readFixture(instanceId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (reads <= 3) {
        // Every window both streams and removes: the page can never win.
        deltaDuring(instanceId, reads)
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: `revert-${reads}`, type: "session.revert.committed", created: 3000 + reads,
          data: { sessionID: sessionId, to: `zzz-${suffix++}` },
        } as any)
        return { data: [assistantRow("reverted", "BASE", 50)], cursor: {} }
      }
      return { data: authoritative, cursor: {} }
    })
    try {
      let data = armLive(instanceId, "BASE")
      data.session.message.invalidate(sessionId)
      await settleSync(data.session.message.sync(sessionId), () => reads)
      assert.ok(reads <= 4, `${reads} reads before giving up on the page`)
      let ids = data.session.message.list(sessionId).map((message) => message.id)
      assert.deepEqual(ids, ["live"], "the invalidated page became authoritative")
      assert.equal(textOf(data, "live"), "BASEXXX", "live text rewound by the exhausted page")

      // The owed coalesced reconciliation runs once the destruction stops:
      // history and the page's terminal tool state arrive through the fresh
      // projection the resync publishes.
      const deadline = Date.now() + 1000
      while (Date.now() < deadline && reads <= 3) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
      }
      data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "quiet-delta", type: "session.text.delta", created: 5000,
        data: { sessionID: sessionId, assistantMessageID: "live", ordinal: 0, delta: "." },
      } as any)
      ids = data.session.message.list(sessionId).map((message) => message.id)
      assert.ok(ids.includes("history"), `reconciliation omitted history: ${JSON.stringify(ids)}`)
      const tool = (data.session.message.get(sessionId, "live") as any)?.content?.find((part: any) => part.type === "tool")
      assert.equal(tool?.state?.status, "completed", "the reconciled terminal tool state was dropped")
      assert.ok(reads <= 6, `${reads} reads including the reconciliation`)
    } finally {
      f.cleanup()
    }
  })

  it("keeps a cancelled inbox message gone", async () => {
    const instanceId = "opencode-merge-cancelled"
    let reads = 0
    const f = readFixture(instanceId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (reads === 1) {
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: "cancel", type: "session.inbox.cancelled", created: 2000,
          data: { sessionID: sessionId, inboxID: "queued" },
        } as any)
        return { data: [assistantRow("queued", "cancelled", 40)], cursor: {} }
      }
      return { data: [], cursor: {} }
    })
    try {
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "enqueue", type: "session.inbox.enqueued", created: 1,
        data: { sessionID: sessionId, inboxID: "queued", item: { type: "user", payload: { text: "cancel me" }, delivery: "queue" } },
      } as any)
      const data = armLive(instanceId)
      data.session.message.invalidate(sessionId)
      await settleSync(data.session.message.sync(sessionId), () => reads)
      const ids = data.session.message.list(sessionId).map((message) => message.id)
      assert.ok(!ids.includes("queued"), `cancelled inbox message republished: ${JSON.stringify(ids)}`)
    } finally {
      f.cleanup()
    }
  })

  it("keeps a terminal tool state that an event delivered inside the window", async () => {
    const instanceId = "opencode-merge-tool-terminal"
    let reads = 0
    const runningToolPage = [{
      id: "live", type: "assistant", agent: "build", model, time: { created: 100 },
      content: [{ type: "tool", id: "tool", name: "bash", time: { created: 2 },
        state: { status: "running", input: {}, metadata: {} } }],
    }]
    const f = readFixture(instanceId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "success", type: "session.tool.success", created: 2000,
        data: { sessionID: sessionId, assistantMessageID: "live", id: "tool",
          content: [{ type: "text", text: "done" }], metadata: {} },
      } as any)
      return { data: runningToolPage, cursor: {} }
    })
    try {
      let data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "step", type: "session.step.started", created: 1,
        data: { sessionID: sessionId, assistantMessageID: "live", agent: "build", model },
      } as any)
      data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "tool", type: "session.tool.input.started", created: 2,
        data: { sessionID: sessionId, assistantMessageID: "live", id: "tool", name: "bash" },
      } as any)
      data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "called", type: "session.tool.called", created: 3,
        data: { sessionID: sessionId, assistantMessageID: "live", id: "tool", input: {} },
      } as any)
      data.session.message.invalidate(sessionId)
      await settleSync(data.session.message.sync(sessionId), () => reads)
      assert.equal(toolStateOf(data, "live"), "completed", "the page rewound the tool to running")
    } finally {
      f.cleanup()
    }
  })

  for (const pageShape of ["empty", "disjoint", "overlapping"] as const) {
    it(`keeps a row the stream created during the fetch, with a ${pageShape} page`, async () => {
      const instanceId = `opencode-merge-create-${pageShape}`
      let reads = 0
      const f = readFixture(instanceId, async () => {
        reads += 1
        await new Promise<void>((resolve) => setImmediate(resolve))
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: `fresh-${reads}`, type: "session.step.started", created: 500 + reads,
          data: { sessionID: sessionId, assistantMessageID: "fresh", agent: "build", model },
        } as any)
        if (pageShape === "empty") return { data: [], cursor: {} }
        if (pageShape === "disjoint") return { data: [assistantRow("unrelated", "x", 900)], cursor: {} }
        return { data: [assistantRow("fresh", "page-snapshot", 500)], cursor: {} }
      })
      try {
        const data = armLive(instanceId)
        data.session.message.invalidate(sessionId)
        await settleSync(data.session.message.sync(sessionId), () => reads)
        const ids = data.session.message.list(sessionId).map((message) => message.id)
        // The empty and disjoint pages own their membership: only the created
        // row rides along. The overlapping page already contains it.
        assert.ok(ids.includes("fresh"), `created row dropped: ${JSON.stringify(ids)}`)
        if (pageShape === "empty") {
          assert.deepEqual(ids, ["fresh"], `unexpected window: ${JSON.stringify(ids)}`)
        } else if (pageShape === "disjoint") {
          assert.deepEqual(ids, ["unrelated", "fresh"], `unexpected window: ${JSON.stringify(ids)}`)
        }
      } finally {
        f.cleanup()
      }
    })
  }

  it("drops a stale resident row the fetched page no longer has", async () => {
    const instanceId = "opencode-merge-stale-row"
    let reads = 0
    const f = readFixture(instanceId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      return { data: [assistantRow("live", "base", 100)], cursor: {} }
    })
    try {
      let data = armLive(instanceId)
      data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "stale", type: "session.step.started", created: 90,
        data: { sessionID: sessionId, assistantMessageID: "stale", agent: "build", model },
      } as any)
      data.session.message.invalidate(sessionId)
      await settleSync(data.session.message.sync(sessionId), () => reads)
      const ids = data.session.message.list(sessionId).map((message) => message.id)
      assert.deepEqual(ids, ["live"], `stale row survived: ${JSON.stringify(ids)}`)
    } finally {
      f.cleanup()
    }
  })

  it("keeps a shell exit that an event delivered inside the window", async () => {
    const instanceId = "opencode-merge-shell-exit"
    let reads = 0
    const runningShellPage = [{
      id: "msg_shell1", type: "shell", shellID: "sh1", command: "watch", status: "running",
      time: { created: 10 },
    }]
    const f = readFixture(instanceId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "shell-end", type: "session.shell.ended", created: 2000,
        data: { sessionID: sessionId, shell: { id: "sh1", status: "exited", exit: 0 }, output: "done" },
      } as any)
      return { data: runningShellPage, cursor: {} }
    })
    try {
      const data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "evt_shell1", type: "session.shell.started", created: 1,
        data: { sessionID: sessionId, shell: { id: "sh1", command: "watch", status: "running", metadata: {} } },
      } as any)
      assert.ok(data.session.message.get(sessionId, "msg_shell1"), "the shell row was not armed")
      data.session.message.invalidate(sessionId)
      await settleSync(data.session.message.sync(sessionId), () => reads)
      const row = data.session.message.get(sessionId, "msg_shell1") as any
      assert.equal(row?.status, "exited", "the page rewound the shell to running")
      assert.equal(row?.output, "done", "the shell's output was dropped")
    } finally {
      f.cleanup()
    }
  })

  it("keeps a synthetic row created inside the window", async () => {
    const instanceId = "opencode-merge-synthetic"
    let reads = 0
    const f = readFixture(instanceId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "evt_syn1", type: "session.synthetic", created: 2000,
        data: { sessionID: sessionId, text: "context", description: "ctx" },
      } as any)
      return { data: [], cursor: {} }
    })
    try {
      const data = armLive(instanceId)
      data.session.message.invalidate(sessionId)
      await settleSync(data.session.message.sync(sessionId), () => reads)
      const ids = data.session.message.list(sessionId).map((message) => message.id)
      assert.deepEqual(ids, ["msg_syn1"], `synthetic row dropped: ${JSON.stringify(ids)}`)
    } finally {
      f.cleanup()
    }
  })

  it("keeps a latest window with a resume cursor navigated", async () => {
    const instanceId = "opencode-merge-navigated-latest"
    const f = readFixture(instanceId, async () => ({ data: [], cursor: {} }))
    try {
      // The reducer holds a wide latest page; the display navigated near the
      // live end and committed a latest window that still carries a resume
      // cursor, with a narrower resident set.
      const data = armLive(instanceId)
      const store = messageStoreBus.getOrCreate(instanceId)
      const rows = Array.from({ length: 30 }, (_, index) => {
        const id = `m${String(1300 + index).padStart(4, "0")}`
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: `seed-${id}`, type: "session.step.started", created: 1300 + index,
          data: { sessionID: sessionId, assistantMessageID: id, agent: "build", model },
        } as any)
        return id
      })
      const resident = rows.slice(10)
      store.addOrUpdateSession({ id: sessionId, parentId: null })
      store.setMessageWindow(sessionId, { kind: "latest", resumeCursor: "around", newerCursors: [] })
      projectOpenCodeMessages(instanceId, sessionId, data)
      const displayed = store.getSessionMessageIds(sessionId)
      assert.ok(displayed.every((id) => resident.includes(id) || id === "live"),
        `rows above the navigated window were reinserted: ${JSON.stringify(displayed)}`)
    } finally {
      f.cleanup()
    }
  })

})
