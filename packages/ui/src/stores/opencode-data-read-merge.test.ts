import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { messageStoreBus } from "./message-v2/bus.ts"
import { applyOpenCodeDataEvent, destroyOpenCodeData } from "./opencode-data.ts"
import { getRootClient } from "./opencode-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import { sseManager } from "../lib/sse-manager.ts"

const model = { providerID: "provider", id: "model" }
const sessionId = "session"

function stubAuthoritativeSession(client: any, messages: () => Promise<any>) {
  client.session.get = async () => ({
    id: sessionId, title: sessionId, projectID: "project", location: { directory: "/work" },
    time: { created: 1, updated: 1 }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  client.session.active = async () => ({})
  client.session.inbox = { list: async () => [] }
  client.permission.list = async () => []
  client.session.form.list = async () => []
  client.message.list = messages
}

const assistant = (id: string, text?: string, created = 100) => ({
  id, type: "assistant", agent: "build", model,
  content: text === undefined ? [] : [{ type: "text", text }],
  time: { created },
})

const textOf = (data: ReturnType<typeof applyOpenCodeDataEvent>, messageId: string) => {
  const row: any = data.session.message.get(sessionId, messageId)
  return String(row?.content?.find((part: any) => part.type === "text")?.text ?? "")
}

const toolStateOf = (data: ReturnType<typeof applyOpenCodeDataEvent>, messageId: string) => {
  const row: any = data.session.message.get(sessionId, messageId)
  return (row?.content?.find((part: any) => part.type === "tool")?.state as any)?.status
}

/** Arms one live assistant row with base text, through events only. */
function armLive(instanceId: string, base = "base") {
  const baseData = { sessionID: sessionId, assistantMessageID: "live" }
  let data = applyOpenCodeDataEvent(instanceId, "/work", {
    id: "step", type: "session.step.started", created: 1, data: { ...baseData, agent: "build", model },
  } as any)
  data = applyOpenCodeDataEvent(instanceId, "/work", {
    id: "text", type: "session.text.started", created: 2, data: { ...baseData },
  } as any)
  data = applyOpenCodeDataEvent(instanceId, "/work", {
    id: "base", type: "session.text.delta", created: 3, data: { ...baseData, ordinal: 0, delta: base },
  } as any)
  return data
}

const deltaDuring = (instanceId: string, ordinal: string, target = "live") =>
  applyOpenCodeDataEvent(instanceId, "/work", {
    id: `delta-${ordinal}`, type: "session.text.delta", created: 1000 + Number(ordinal),
    data: { sessionID: sessionId, assistantMessageID: target, ordinal: 0, delta: "X" },
  } as any)

function fixture(instanceId: string, messages: () => Promise<any>) {
  const client = getRootClient(instanceId)
  sseManager.seedStatus(instanceId, "connected")
  stubAuthoritativeSession(client, messages)
  return {
    client,
    cleanup() {
      destroyOpenCodeData(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
      sdkManager.destroyClientsForInstance(instanceId)
    },
  }
}

async function settleSync(sync: Promise<unknown>, reads: () => number): Promise<void> {
  await Promise.race([
    sync,
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error(`sync did not settle (${reads()} reads)`)), 2000)
    }),
  ])
}

describe("OpenCode data read merge scenarios", () => {
  for (const revertOnRead of [1, 2, 3]) {
    it(`never republishes a revert that lands during read ${revertOnRead}`, async () => {
      const instanceId = `opencode-merge-revert-${revertOnRead}`
      let reads = 0
      const f = fixture(instanceId, async () => {
        reads += 1
        await new Promise<void>((resolve) => setImmediate(resolve))
        deltaDuring(instanceId, String(reads))
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
        return { data: reads <= revertOnRead ? [assistant("reverted", "gone", 50), assistant("live", "base", 100)] : [], cursor: {} }
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
    const f = fixture(instanceId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      // Every window both streams and removes: the page can never win.
      deltaDuring(instanceId, String(reads))
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: `revert-${reads}`, type: "session.revert.committed", created: 3000 + reads,
        data: { sessionID: sessionId, to: `zzz-${suffix++}` },
      } as any)
      return { data: [assistant("reverted", "BASE", 50)], cursor: {} }
    })
    try {
      const data = armLive(instanceId, "BASE")
      data.session.message.invalidate(sessionId)
      await settleSync(data.session.message.sync(sessionId), () => reads)
      assert.ok(reads <= 4, `${reads} reads before giving up on the page`)
      const ids = data.session.message.list(sessionId).map((message) => message.id)
      assert.deepEqual(ids, ["live"], "the invalidated page became authoritative")
      assert.equal(textOf(data, "live"), "BASEXXX", "live text rewound by the exhausted page")
    } finally {
      f.cleanup()
    }
  })

  it("keeps a cancelled inbox message gone", async () => {
    const instanceId = "opencode-merge-cancelled"
    let reads = 0
    const f = fixture(instanceId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (reads === 1) {
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: "cancel", type: "session.inbox.cancelled", created: 2000,
          data: { sessionID: sessionId, inboxID: "queued" },
        } as any)
        return { data: [assistant("queued", "cancelled", 40)], cursor: {} }
      }
      return { data: [], cursor: {} }
    })
    try {
      let data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "enqueue", type: "session.inbox.enqueued", created: 1,
        data: { sessionID: sessionId, inboxID: "queued", item: { type: "user", payload: { text: "cancel me" }, delivery: "queue" } },
      } as any)
      data = armLive(instanceId)
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
    const f = fixture(instanceId, async () => {
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

  it("keeps a row the stream created during the fetch, with an empty page", async () => {
    const instanceId = "opencode-merge-create-empty-page"
    let reads = 0
    const f = fixture(instanceId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: `fresh-${reads}`, type: "session.step.started", created: 500 + reads,
        data: { sessionID: sessionId, assistantMessageID: "fresh", agent: "build", model },
      } as any)
      return { data: [], cursor: {} }
    })
    try {
      const data = armLive(instanceId)
      data.session.message.invalidate(sessionId)
      await settleSync(data.session.message.sync(sessionId), () => reads)
      const ids = data.session.message.list(sessionId).map((message) => message.id)
      // An empty page owns membership; only the row the stream created inside
      // the window rides along.
      assert.deepEqual(ids, ["fresh"], `created row dropped: ${JSON.stringify(ids)}`)
      // Later deltas still reach it.
      deltaDuring(instanceId, "1", "fresh")
      const updated = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "fresh-text", type: "session.text.started", created: 900, data: { sessionID: sessionId, assistantMessageID: "fresh" },
      } as any)
      void updated
      assert.equal(data.session.message.list(sessionId).some((message) => message.id === "fresh"), true)
    } finally {
      f.cleanup()
    }
  })

  it("drops a stale resident row the fetched page no longer has", async () => {
    const instanceId = "opencode-merge-stale-row"
    let reads = 0
    const f = fixture(instanceId, async () => {
      reads += 1
      await new Promise<void>((resolve) => setImmediate(resolve))
      return { data: [assistant("live", "base", 100)], cursor: {} }
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
})
