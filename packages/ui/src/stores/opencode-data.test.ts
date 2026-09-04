import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createEffect, createRoot } from "solid-js"
import { messageStoreBus } from "./message-v2/bus.ts"
import { seedSessionMessagesV2 } from "./message-v2/bridge.ts"
import { normalizeSessionMessage } from "./message-v2/normalizers.ts"
import { applyOpenCodeDataEvent, destroyOpenCodeData, getOpenCodeMessageRevision, getOpenCodeMutationRevision, getOpenCodeSessionInbox, projectOpenCodeMessages } from "./opencode-data.ts"
import { emptyLatestWindow } from "./message-v2/message-window.ts"
import { getRootClient } from "./opencode-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"
import { sseManager } from "../lib/sse-manager.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function stubAuthoritativeSession(client: any, sessionId: string, messages: () => Promise<any>) {
  client.session.get = async () => ({
    id: sessionId, title: sessionId, projectID: "project", location: { directory: "/work" },
    time: { created: 1, updated: 1 }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  client.session.active = async () => ({})
  client.session.inbox = { list: async () => [] }
  client.permission.list = async () => []
  client.form.list = async () => []
  client.message.list = messages
}

describe("OpenCode data projection", () => {
  it("uses createData to reduce messages, permissions, and forms", () => {
    const instanceId = "opencode-data"
    const base = { sessionID: "session", assistantMessageID: "assistant" }
    const apply = (type: string, data: Record<string, unknown>, created = 1) =>
      applyOpenCodeDataEvent(instanceId, "/work", { id: type, type, created, data } as any)

    try {
      apply("session.step.started", { ...base, agent: "build", model: { providerID: "provider", id: "model" } })
      apply("session.text.started", base)
      apply("session.text.delta", { ...base, ordinal: 0, delta: "hello" })
      apply("session.tool.input.started", { ...base, id: "tool", name: "bash" })
      apply("session.tool.called", { ...base, id: "tool", input: { command: "pwd" } }, 2)
      const data = apply("session.tool.success", { ...base, id: "tool", content: [{ type: "text", text: "ok" }], metadata: {} }, 3)
      projectOpenCodeMessages(instanceId, "session", data)

      const message = messageStoreBus.getOrCreate(instanceId).getMessage("assistant")
      assert.equal((message?.parts["assistant-text-0"]?.data as any)?.text, "hello")
      assert.equal((message?.parts.tool?.data as any)?.state.output, "ok")

      const permissionData = apply("permission.asked", { id: "permission", sessionID: "session", action: "read", resources: ["*"] })
      assert.equal(permissionData.session.permission.list("session")?.[0]?.id, "permission")

      const formData = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "form", type: "form.created", created: 4, location: { directory: "/work" },
        data: { form: { id: "form", sessionID: "session", title: "Input", fields: [] } },
      } as any)
      assert.equal(formData.session.form.list("session")?.[0]?.id, "form")
    } finally {
      destroyOpenCodeData(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("projects streamed-step timing and authoritative assistant content replacements", () => {
    const instanceId = "opencode-data-content-update"
    const sessionId = "session"
    const base = { sessionID: sessionId, assistantMessageID: "assistant" }
    const apply = (type: string, data: Record<string, unknown>, created: number) =>
      applyOpenCodeDataEvent(instanceId, "/work", { id: type, type, created, data } as any)

    try {
      apply("session.step.started", { ...base, agent: "build", model: { providerID: "provider", id: "model" } }, 1)
      apply("session.text.started", base, 2)
      apply("session.text.delta", { ...base, ordinal: 0, delta: "draft" }, 3)
      apply("session.step.streamed", base, 4)
      const data = apply("session.message.content.updated", {
        sessionID: sessionId,
        messageID: "assistant",
        content: [{ type: "text", text: "edited" }],
      }, 5)
      projectOpenCodeMessages(instanceId, sessionId, data)

      const store = messageStoreBus.getOrCreate(instanceId)
      assert.equal((store.getMessage("assistant")?.parts["assistant-text-0"]?.data as any)?.text, "edited")
      assert.equal(store.getMessageInfo("assistant")?.time?.streamed, 4)
    } finally {
      destroyOpenCodeData(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("merges the first live event into REST-loaded history", () => {
    const instanceId = "opencode-data-rest-history"
    const sessionId = "session"
    const infos = new Map()
    const history = Array.from({ length: 100 }, (_, index) => {
      const item = {
        id: `history-${index}`,
        type: "assistant",
        agent: "build",
        model: { providerID: "provider", id: "model" },
        time: { created: index + 1, completed: index + 1 },
        content: [],
      } as any
      const normalized = normalizeSessionMessage(sessionId, item)
      infos.set(normalized.info.id, normalized.info)
      return normalized.message
    })

    try {
      seedSessionMessagesV2(instanceId, { id: sessionId }, history, infos)
      const data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "live", type: "session.step.started", created: 101,
        data: {
          sessionID: sessionId,
          assistantMessageID: "live",
          agent: "build",
          model: { providerID: "provider", id: "model" },
        },
      } as any)
      projectOpenCodeMessages(instanceId, sessionId, data)

      const ids = messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId)
      assert.equal(ids.length, 101)
      assert.equal(ids.includes("history-0"), true)
      assert.equal(ids.includes("live"), true)
    } finally {
      destroyOpenCodeData(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("does not revise unchanged historical messages during repeated projection", () => {
    const instanceId = "opencode-data-unchanged"
    const sessionId = "session"
    try {
      const data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "live", type: "session.step.started", created: 1,
        data: {
          sessionID: sessionId,
          assistantMessageID: "assistant",
          agent: "build",
          model: { providerID: "provider", id: "model" },
        },
      } as any)
      projectOpenCodeMessages(instanceId, sessionId, data)
      const store = messageStoreBus.getOrCreate(instanceId)
      const revision = store.getMessage("assistant")?.revision

      projectOpenCodeMessages(instanceId, sessionId, data)

      assert.equal(store.getMessage("assistant")?.revision, revision)
    } finally {
      destroyOpenCodeData(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("clears normalized messages from an authoritative empty SDK projection", () => {
    const instanceId = "opencode-data-authoritative-empty"
    const sessionId = "session"
    try {
      let data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "message", type: "session.step.started", created: 1,
        data: { sessionID: sessionId, assistantMessageID: "message", agent: "build", model: { providerID: "provider", id: "model" } },
      } as any)
      projectOpenCodeMessages(instanceId, sessionId, data)
      data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "revert", type: "session.revert.committed", created: 2,
        data: { sessionID: sessionId, to: "message" },
      } as any)
      projectOpenCodeMessages(instanceId, sessionId, data, false)

      assert.deepEqual(data.session.message.list(sessionId), [])
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), [])
    } finally {
      destroyOpenCodeData(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("bounds the settled live reducer and resident projection to one message window", async () => {
    const instanceId = "opencode-data-bounded"
    const sessionId = "session"
    try {
      let data!: ReturnType<typeof applyOpenCodeDataEvent>
      for (let index = 0; index < 205; index += 1) {
        data = applyOpenCodeDataEvent(instanceId, "/work", {
          id: `live-${index}`,
          type: "session.step.started",
          created: index + 1,
          data: {
            sessionID: sessionId,
            assistantMessageID: `live-${index}`,
            agent: "build",
            model: { providerID: "provider", id: "model" },
          },
        } as any, (next) => projectOpenCodeMessages(instanceId, sessionId, next))
        projectOpenCodeMessages(instanceId, sessionId, data)
        data = applyOpenCodeDataEvent(instanceId, "/work", {
          id: `ended-${index}`, type: "session.step.ended", created: index + 2,
          data: { sessionID: sessionId, assistantMessageID: `live-${index}`, finish: "stop" },
        } as any, (next) => projectOpenCodeMessages(instanceId, sessionId, next))
        projectOpenCodeMessages(instanceId, sessionId, data)
        await new Promise<void>((resolve) => setImmediate(resolve))
        assert.ok(data.session.message.list(sessionId).length <= 200)
      }

      const ids = messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId)
      assert.equal(ids.length, 200)
      assert.equal(ids.includes("live-0"), false)
      assert.equal(ids.includes("live-204"), true)
    } finally {
      destroyOpenCodeData(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("does not evict another message when compaction completion updates its running row", async () => {
    const instanceId = "opencode-data-compaction-boundary"
    const sessionId = "session"
    try {
      let data!: ReturnType<typeof applyOpenCodeDataEvent>
      for (let index = 0; index < 200; index += 1) {
        data = applyOpenCodeDataEvent(instanceId, "/work", {
          id: `start-${index}`, type: "session.step.started", created: index * 2 + 1,
          data: { sessionID: sessionId, assistantMessageID: `m${index}`, agent: "build", model: { providerID: "provider", id: "model" } },
        } as any)
        data = applyOpenCodeDataEvent(instanceId, "/work", {
          id: `end-${index}`, type: "session.step.ended", created: index * 2 + 2,
          data: { sessionID: sessionId, assistantMessageID: `m${index}`, finish: "stop" },
        } as any)
      }
      data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "compact", type: "session.compaction.started", created: 401,
        data: { sessionID: sessionId, inputID: "compact", reason: "manual", recent: "" },
      } as any)
      await new Promise<void>((resolve) => setImmediate(resolve))

      data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "compact-end", type: "session.compaction.ended", created: 402,
        data: { sessionID: sessionId, reason: "manual", text: "summary", recent: "" },
      } as any)

      assert.equal(data.session.message.list(sessionId).length, 200)
      assert.ok(data.session.message.get(sessionId, "m1"))
      assert.equal((data.session.message.get(sessionId, "compact") as any).status, "completed")
    } finally {
      destroyOpenCodeData(instanceId)
    }
  })

  it("bounds one transcript without disposing instance data or replaying boundary events", async () => {
    const instanceId = "opencode-data-isolated-bound"
    const primary = applyOpenCodeDataEvent(instanceId, "/work", {
      id: "permission", type: "permission.asked", created: 1,
      data: { id: "permission", sessionID: "other", action: "read", resources: ["*"] },
    } as any)
    try {
      for (let index = 0; index <= 200; index += 1) {
        let data = applyOpenCodeDataEvent(instanceId, "/work", {
          id: `live-${index}`, type: "session.step.started", created: index + 1,
          data: { sessionID: "session", assistantMessageID: `live-${index}`, agent: "build", model: { providerID: "provider", id: "model" } },
        } as any, (next) => projectOpenCodeMessages(instanceId, "session", next))
        projectOpenCodeMessages(instanceId, "session", data)
        data = applyOpenCodeDataEvent(instanceId, "/work", {
          id: `ended-${index}`, type: "session.step.ended", created: index + 2,
          data: { sessionID: "session", assistantMessageID: `live-${index}`, finish: "stop" },
        } as any, (next) => projectOpenCodeMessages(instanceId, "session", next))
        projectOpenCodeMessages(instanceId, "session", data)
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      const current = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "replied", type: "permission.replied", created: 203,
        data: { sessionID: "other", requestID: "missing" },
      } as any)

      assert.strictEqual(current, primary)
      assert.equal(current.session.permission.list("other")?.[0]?.id, "permission")
      const ids = messageStoreBus.getOrCreate(instanceId).getSessionMessageIds("session")
      assert.equal(ids.length, 200)
      assert.equal(ids.includes("live-200"), true)
    } finally {
      destroyOpenCodeData(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("preserves SDK step, snapshot, reasoning, cancel, and revert semantics through rotation", async () => {
    const instanceId = "opencode-data-rotation-parity"
    const sessionId = "session"
    try {
      let data!: ReturnType<typeof applyOpenCodeDataEvent>
      for (let index = 0; index < 199; index += 1) {
        const id = `m${String(index).padStart(3, "0")}`
        data = applyOpenCodeDataEvent(instanceId, "/work", {
          id, type: "session.step.started", created: index + 1,
          data: { sessionID: sessionId, assistantMessageID: id, agent: "build", model: { providerID: "provider", id: "model" } },
        } as any)
        data = applyOpenCodeDataEvent(instanceId, "/work", {
          id: `ended-${id}`, type: "session.step.ended", created: index + 2,
          data: { sessionID: sessionId, assistantMessageID: id, finish: "stop" },
        } as any)
      }
      data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "m199", type: "session.step.started", created: 200,
        data: { sessionID: sessionId, assistantMessageID: "m199", agent: "build", model: { providerID: "provider", id: "model" }, snapshot: "prior-start" },
      } as any)
      data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "m200", type: "session.step.started", created: 201,
        data: { sessionID: sessionId, assistantMessageID: "m200", agent: "build", model: { providerID: "provider", id: "model" }, snapshot: "next-start" },
      } as any)
      applyOpenCodeDataEvent(instanceId, "/work", { id: "reason-start", type: "session.reasoning.started", created: 202, data: { sessionID: sessionId, assistantMessageID: "m200", state: { phase: "start" } } } as any)
      applyOpenCodeDataEvent(instanceId, "/work", { id: "reason-delta", type: "session.reasoning.delta", created: 203, data: { sessionID: sessionId, assistantMessageID: "m200", delta: "thinking" } } as any)
      applyOpenCodeDataEvent(instanceId, "/work", { id: "reason-end", type: "session.reasoning.ended", created: 204, data: { sessionID: sessionId, assistantMessageID: "m200", text: "thought", state: { phase: "done" } } } as any)
      data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "next-end", type: "session.step.ended", created: 205,
        data: { sessionID: sessionId, assistantMessageID: "m200", finish: "stop", snapshot: "next-end" },
      } as any)
      await new Promise<void>((resolve) => setImmediate(resolve))

      const prior = data.session.message.get(sessionId, "m199") as any
      const next = data.session.message.get(sessionId, "m200") as any
      assert.equal(prior.time.completed, 201)
      assert.equal(prior.snapshot.start, "prior-start")
      assert.deepEqual(next.snapshot, { start: "next-start", end: "next-end" })
      assert.equal(next.content[0].text, "thought")
      assert.deepEqual(next.content[0].state, { phase: "done" })
      projectOpenCodeMessages(instanceId, sessionId, data)
      assert.equal(data.session.message.list(sessionId).length, 200)

      const store = messageStoreBus.getOrCreate(instanceId)
      data = applyOpenCodeDataEvent(instanceId, "/work", { id: "cancel", type: "session.inbox.cancelled", created: 206, data: { sessionID: sessionId, inboxID: "m010" } } as any)
      data = applyOpenCodeDataEvent(instanceId, "/work", { id: "revert", type: "session.revert.committed", created: 207, data: { sessionID: sessionId, to: "m199" } } as any)
      assert.equal(data.session.message.get(sessionId, "m010"), undefined)
      assert.equal(data.session.message.get(sessionId, "m199"), undefined)
      assert.equal(data.session.message.get(sessionId, "m200"), undefined)

      data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "m300", type: "session.step.started", created: 208,
        data: { sessionID: sessionId, assistantMessageID: "m300", agent: "build", model: { providerID: "provider", id: "model" } },
      } as any)
      projectOpenCodeMessages(instanceId, sessionId, data)
      assert.ok(data.session.message.get(sessionId, "m300"))
      assert.ok(store.getMessage("m300"))
    } finally {
      destroyOpenCodeData(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("keeps a synchronous 1000-event burst within the hard reducer ceiling", async () => {
    const instanceId = "opencode-data-active-bound"
    const sessionId = "session"
    try {
      let data!: ReturnType<typeof applyOpenCodeDataEvent>
      for (let index = 0; index < 1000; index += 1) {
        const id = `m${String(index).padStart(4, "0")}`
        data = applyOpenCodeDataEvent(instanceId, "/work", {
          id, type: "session.step.started", created: index + 1,
          data: { sessionID: sessionId, assistantMessageID: id, agent: "build", model: { providerID: "provider", id: "model" } },
        } as any)
        assert.ok(data.session.message.list(sessionId).length <= 200)
      }
      await new Promise<void>((resolve) => setImmediate(resolve))

      const messages = data.session.message.list(sessionId) as any[]
      assert.ok(messages.length <= 200)
      assert.equal(messages.at(-1)?.id, "m0999")
      assert.equal(messages.at(-1)?.time.completed, undefined)
      assert.ok(messages.slice(0, -1).every((message) => message.time.completed !== undefined))

      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "text", type: "session.text.started", created: 261,
        data: { sessionID: sessionId, assistantMessageID: "m0999" },
      } as any)
      data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "delta", type: "session.text.delta", created: 262,
        data: { sessionID: sessionId, assistantMessageID: "m0999", ordinal: 0, delta: "still active" },
      } as any)
      assert.equal((data.session.message.get(sessionId, "m0999") as any).content[0].text, "still active")
    } finally {
      destroyOpenCodeData(instanceId)
    }
  })

  it("serializes an event injected while the SDK snapshot sync is awaited", async () => {
    const instanceId = "opencode-data-rotation-serialization"
    const sessionId = "session"
    let deferredApplications = 0
    try {
      let data!: ReturnType<typeof applyOpenCodeDataEvent>
      for (let index = 0; index < 200; index += 1) {
        const id = `m${String(index).padStart(3, "0")}`
        data = applyOpenCodeDataEvent(instanceId, "/work", {
          id, type: "session.step.started", created: index * 2 + 1,
          data: { sessionID: sessionId, assistantMessageID: id, agent: "build", model: { providerID: "provider", id: "model" } },
        } as any)
        data = applyOpenCodeDataEvent(instanceId, "/work", {
          id: `${id}-end`, type: "session.step.ended", created: index * 2 + 2,
          data: { sessionID: sessionId, assistantMessageID: id, finish: "stop" },
        } as any)
      }
      data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "m200", type: "session.step.started", created: 401,
        data: { sessionID: sessionId, assistantMessageID: "m200", agent: "build", model: { providerID: "provider", id: "model" } },
      } as any, () => { deferredApplications += 1 })
      queueMicrotask(() => {
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: "m201", type: "session.step.started", created: 402,
          data: { sessionID: sessionId, assistantMessageID: "m201", agent: "build", model: { providerID: "provider", id: "model" } },
        } as any, () => { deferredApplications += 1 })
      })
      await new Promise<void>((resolve) => setImmediate(resolve))

      const ids = data.session.message.list(sessionId).map((message) => message.id)
      assert.equal(deferredApplications, 2)
      assert.equal(new Set(ids).size, ids.length)
      assert.equal((data.session.message.get(sessionId, "m200") as any).time.completed, 402)
      assert.equal((data.session.message.get(sessionId, "m201") as any).time.completed, undefined)
    } finally {
      destroyOpenCodeData(instanceId)
    }
  })

  it("applies queued cancellation and revert removal after preceding projections", async () => {
    for (const mutation of ["cancel", "revert"] as const) {
      const instanceId = `opencode-data-queued-${mutation}`
      const sessionId = "session"
      const targetId = "z-target"
      const store = messageStoreBus.getOrCreate(instanceId)
      const applyProjection = (data: ReturnType<typeof applyOpenCodeDataEvent>) => {
        projectOpenCodeMessages(instanceId, sessionId, data)
        if (mutation === "cancel") store.removeMessage(targetId, sessionId)
        else for (const id of store.getSessionMessageIds(sessionId)) if (id >= targetId) store.removeMessage(id, sessionId)
      }
      try {
        let data!: ReturnType<typeof applyOpenCodeDataEvent>
        for (let index = 0; index < 200; index += 1) {
          const id = `m${String(index).padStart(3, "0")}`
          data = applyOpenCodeDataEvent(instanceId, "/work", {
            id, type: "session.step.started", created: index * 2 + 1,
            data: { sessionID: sessionId, assistantMessageID: id, agent: "build", model: { providerID: "provider", id: "model" } },
          } as any)
          data = applyOpenCodeDataEvent(instanceId, "/work", {
            id: `end-${id}`, type: "session.step.ended", created: index * 2 + 2,
            data: { sessionID: sessionId, assistantMessageID: id, finish: "stop" },
          } as any)
        }
        projectOpenCodeMessages(instanceId, sessionId, data)
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: "append", type: "session.inbox.enqueued", created: 401,
          data: { sessionID: sessionId, inboxID: targetId, item: { type: "user", payload: { text: "queued" }, delivery: "queue" } },
        } as any, (next) => projectOpenCodeMessages(instanceId, sessionId, next))
        data = applyOpenCodeDataEvent(instanceId, "/work", mutation === "cancel"
          ? { id: "cancel", type: "session.inbox.cancelled", created: 402, data: { sessionID: sessionId, inboxID: targetId } } as any
          : { id: "revert", type: "session.revert.committed", created: 402, data: { sessionID: sessionId, to: targetId } } as any,
        applyProjection)
        applyProjection(data)
        await new Promise<void>((resolve) => setImmediate(resolve))

        assert.equal(data.session.message.get(sessionId, targetId), undefined)
        assert.equal(store.getMessage(targetId), undefined)
      } finally {
        destroyOpenCodeData(instanceId)
        messageStoreBus.unregisterInstance(instanceId)
      }
    }
  })

  it("does not swap or callback after deletion or reconnect during a fresh sync", async () => {
    for (const invalidation of ["delete", "reconnect"] as const) {
      const instanceId = `opencode-data-fresh-${invalidation}`
      const sessionId = "session"
      const pending = deferred<any>()
      const client = getRootClient(instanceId)
      let callbacks = 0
      stubAuthoritativeSession(client, sessionId, () => pending.promise)
      if (invalidation === "reconnect") {
        client.location.get = (async () => ({ directory: "/work" })) as any
        client.vcs.get = (async () => ({ location: { directory: "/work" }, data: {} })) as any
        client.project.list = (async () => []) as any
      }
      try {
        let stale!: ReturnType<typeof applyOpenCodeDataEvent>
        for (let index = 0; index < 4296; index += 1) {
          const id = `m${String(index).padStart(4, "0")}`
          stale = applyOpenCodeDataEvent(instanceId, "/work", {
            id, type: "session.step.started", created: index + 1,
            data: { sessionID: sessionId, assistantMessageID: id, agent: "build", model: { providerID: "provider", id: "model" } },
          } as any, () => { callbacks += 1 })
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 40))
        if (invalidation === "delete") {
          applyOpenCodeDataEvent(instanceId, "/work", { id: "delete", type: "session.deleted", created: 5000, data: { sessionID: sessionId } } as any)
        } else {
          applyOpenCodeDataEvent(instanceId, "/work", { id: "connect", type: "server.connected", created: 5000, data: {} } as any)
        }
        pending.resolve({ data: [{ id: "stale", type: "assistant", agent: "build", model: { providerID: "provider", id: "model" }, content: [], time: { created: 1 } }], cursor: {} })
        await new Promise<void>((resolve) => setImmediate(resolve))

        assert.equal(callbacks, 0)
        const current = applyOpenCodeDataEvent(instanceId, "/work", {
          id: "current", type: "session.step.started", created: 6000,
          data: { sessionID: sessionId, assistantMessageID: "current", agent: "build", model: { providerID: "provider", id: "model" } },
        } as any)
        assert.equal(current.session.message.get(sessionId, "stale"), undefined)
        assert.notStrictEqual(current, stale)
      } finally {
        destroyOpenCodeData(instanceId)
        sdkManager.destroyClientsForInstance(instanceId)
      }
    }
  })

  it("does not double-apply text, reasoning, or tool deltas already in the stable snapshot", async () => {
    const instanceId = "opencode-data-stable-deltas"
    const sessionId = "session"
    const client = getRootClient(instanceId)
    const authoritative = {
      id: "target", type: "assistant", agent: "build", model: { providerID: "provider", id: "model" },
      content: [
        { type: "text", text: "hello" },
        { type: "reasoning", text: "thought", time: { created: 201, completed: 202 } },
        { type: "tool", id: "tool", name: "read", time: { created: 203, ran: 204, completed: 205 }, state: { status: "completed", input: {}, metadata: {}, content: [] } },
      ],
      time: { created: 200 },
    }
    let reads = 0
    let callbacks = 0
    let freshData: ReturnType<typeof applyOpenCodeDataEvent> | undefined
    stubAuthoritativeSession(client, sessionId, async () => {
      reads += 1
      return { data: [authoritative], cursor: {} }
    })
    try {
      for (let index = 0; index < 199; index += 1) {
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: `seed-${index}`, type: "session.step.started", created: index * 2 + 1,
          data: { sessionID: sessionId, assistantMessageID: `seed-${index}`, agent: "build", model: { providerID: "provider", id: "model" } },
        } as any)
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: `seed-${index}-end`, type: "session.step.ended", created: index * 2 + 2,
          data: { sessionID: sessionId, assistantMessageID: `seed-${index}`, finish: "stop" },
        } as any)
      }
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "target", type: "session.step.started", created: 200,
        data: { sessionID: sessionId, assistantMessageID: "target", agent: "build", model: { providerID: "provider", id: "model" } },
      } as any)
      const queued: any[] = [
        { id: "next", type: "session.step.started", created: 201, data: { sessionID: sessionId, assistantMessageID: "next", agent: "build", model: { providerID: "provider", id: "model" } } },
        { id: "text-start", type: "session.text.started", created: 202, data: { sessionID: sessionId, assistantMessageID: "target" } },
        { id: "text-delta", type: "session.text.delta", created: 203, data: { sessionID: sessionId, assistantMessageID: "target", ordinal: 0, delta: "hello" } },
        { id: "reason-start", type: "session.reasoning.started", created: 204, data: { sessionID: sessionId, assistantMessageID: "target" } },
        { id: "reason-delta", type: "session.reasoning.delta", created: 205, data: { sessionID: sessionId, assistantMessageID: "target", delta: "thought" } },
        { id: "tool-start", type: "session.tool.input.started", created: 206, data: { sessionID: sessionId, assistantMessageID: "target", id: "tool", name: "read" } },
        { id: "tool-delta", type: "session.tool.input.delta", created: 207, data: { sessionID: sessionId, assistantMessageID: "target", id: "tool", delta: "{}" } },
        { id: "tool-call", type: "session.tool.called", created: 208, data: { sessionID: sessionId, assistantMessageID: "target", id: "tool", input: {} } },
      ]
      while (queued.length < 4096) {
        const index = queued.length
        queued.push({ id: `overflow-${index}`, type: "session.step.started", created: 300 + index, data: {
          sessionID: sessionId, assistantMessageID: `overflow-${index}`, agent: "build", model: { providerID: "provider", id: "model" },
        } })
      }
      for (const event of queued) {
        applyOpenCodeDataEvent(instanceId, "/work", event, () => { callbacks += 1 }, (next) => {
          freshData = next
          projectOpenCodeMessages(instanceId, sessionId, next, false)
        })
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50))

      assert.equal(reads, 1)
      assert.equal(callbacks, 0)
      const content = (freshData?.session.message.get(sessionId, "target") as any)?.content
      assert.equal(content.filter((part: any) => part.type === "text").length, 1)
      assert.equal(content.find((part: any) => part.type === "text")?.text, "hello")
      assert.equal(content.filter((part: any) => part.type === "reasoning").length, 1)
      assert.equal(content.find((part: any) => part.type === "reasoning")?.text, "thought")
      assert.equal(content.filter((part: any) => part.type === "tool").length, 1)
    } finally {
      destroyOpenCodeData(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  it("invalidates one fresh sync for permission and form collapse bursts", async () => {
    const instanceId = "opencode-data-singleflight"
    const sessionId = "session"
    const client = getRootClient(instanceId)
    const firstRead = deferred<any>()
    const stable = { id: "stable", type: "assistant", agent: "build", model: { providerID: "provider", id: "model" }, content: [], time: { created: 9000 } }
    let reads = 0
    let active = 0
    let maxActive = 0
    let callbacks = 0
    let freshData: ReturnType<typeof applyOpenCodeDataEvent> | undefined
    stubAuthoritativeSession(client, sessionId, async () => {
      reads += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        if (reads === 1) return await firstRead.promise
        return { data: [stable], cursor: {} }
      } finally {
        active -= 1
      }
    })
    try {
      for (let index = 0; index < 4296; index += 1) {
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: `seed-${index}`, type: "session.step.started", created: index + 1,
          data: { sessionID: sessionId, assistantMessageID: `seed-${index}`, agent: "build", model: { providerID: "provider", id: "model" } },
        } as any, () => { callbacks += 1 }, (next) => { freshData = next })
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 40))
      assert.equal(reads, 1)

      for (let burst = 0; burst < 3; burst += 1) {
        for (let index = 0; index < 20; index += 1) {
          const id = `burst-${burst}-${index}`
          const event = index % 2 === 0
            ? { id, type: "permission.asked", created: 5000 + burst * 20 + index,
                data: { id: `permission-${burst}-${index}`, sessionID: sessionId, action: "read", resources: ["*"] } }
            : { id, type: "form.created", created: 5000 + burst * 20 + index, location: { directory: "/work" },
                data: { form: { id: `form-${burst}-${index}`, sessionID: sessionId, title: "Input", fields: [] } } }
          applyOpenCodeDataEvent(instanceId, "/work", event as any, () => { callbacks += 1 }, (next) => { freshData = next })
        }
      }
      assert.equal(reads, 1)
      assert.equal(maxActive, 1)

      firstRead.resolve({ data: [{ ...stable, id: "stale" }], cursor: {} })
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(freshData, undefined)
      await new Promise<void>((resolve) => setTimeout(resolve, 40))

      assert.equal(reads, 2)
      assert.equal(maxActive, 1)
      assert.equal(callbacks, 0)
      const stableData = freshData as ReturnType<typeof applyOpenCodeDataEvent> | undefined
      assert.ok(stableData?.session.message.get(sessionId, "stable"))
      assert.equal(stableData?.session.message.get(sessionId, "stale"), undefined)
    } finally {
      destroyOpenCodeData(instanceId)
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  it("keeps a post-revert native message from the fresh authoritative snapshot", async () => {
    const instanceId = "opencode-data-fresh-revert"
    const sessionId = "session"
    const client = getRootClient(instanceId)
    const m300 = {
      id: "m300", type: "assistant", agent: "build", model: { providerID: "provider", id: "model" },
      content: [], time: { created: 5000 },
    }
    let freshData: ReturnType<typeof applyOpenCodeDataEvent> | undefined
    let callbacks = 0
    stubAuthoritativeSession(client, sessionId, async () => ({ data: [m300], cursor: {} }))
    try {
      for (let index = 0; index < 200; index += 1) {
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: `seed-${index}`, type: "session.step.started", created: index + 1,
          data: { sessionID: sessionId, assistantMessageID: `seed-${index}`, agent: "build", model: { providerID: "provider", id: "model" } },
        } as any)
      }
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "queued", type: "session.step.started", created: 300,
        data: { sessionID: sessionId, assistantMessageID: "queued", agent: "build", model: { providerID: "provider", id: "model" } },
      } as any, () => { callbacks += 1 })
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "revert", type: "session.revert.committed", created: 301,
        data: { sessionID: sessionId, to: "m200" },
      } as any, () => { callbacks += 1 })
      for (let index = 0; index < 4094; index += 1) {
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: `overflow-${index}`, type: "session.step.started", created: 400 + index,
          data: { sessionID: sessionId, assistantMessageID: `overflow-${index}`, agent: "build", model: { providerID: "provider", id: "model" } },
        } as any, () => { callbacks += 1 }, (next) => {
          freshData = next
          projectOpenCodeMessages(instanceId, sessionId, next, false)
        })
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50))

      assert.equal(callbacks, 0)
      assert.ok(freshData?.session.message.get(sessionId, "m300"))
      assert.ok(messageStoreBus.getOrCreate(instanceId).getMessage("m300"))
    } finally {
      destroyOpenCodeData(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  it("preserves queued inbox cancellation across append overflow", async () => {
    const instanceId = "opencode-data-overflow-cancel"
    const sessionId = "session"
    const targetId = "queued-inbox"
    const client = getRootClient(instanceId)
    const store = messageStoreBus.getOrCreate(instanceId)
    let reads = 0
    let callbacks = 0
    let freshData: ReturnType<typeof applyOpenCodeDataEvent> | undefined
    stubAuthoritativeSession(client, sessionId, async () => {
      reads += 1
      return { data: [], cursor: {} }
    })
    const project = (data: ReturnType<typeof applyOpenCodeDataEvent>) => projectOpenCodeMessages(instanceId, sessionId, data)
    const cancel = (data: ReturnType<typeof applyOpenCodeDataEvent>) => {
      callbacks += 1
      project(data)
      store.removeMessage(targetId, sessionId)
    }
    try {
      let data!: ReturnType<typeof applyOpenCodeDataEvent>
      for (let index = 0; index < 200; index += 1) {
        const id = `seed-${index}`
        data = applyOpenCodeDataEvent(instanceId, "/work", {
          id, type: "session.step.started", created: index * 2 + 1,
          data: { sessionID: sessionId, assistantMessageID: id, agent: "build", model: { providerID: "provider", id: "model" } },
        } as any)
        data = applyOpenCodeDataEvent(instanceId, "/work", {
          id: `${id}-end`, type: "session.step.ended", created: index * 2 + 2,
          data: { sessionID: sessionId, assistantMessageID: id, finish: "stop" },
        } as any)
      }
      project(data)
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "admit", type: "session.inbox.enqueued", created: 401,
        data: { sessionID: sessionId, inboxID: targetId, item: { type: "user", payload: { text: "cancel me" }, delivery: "queue" } },
      } as any, (next) => { callbacks += 1; project(next) }, (next) => {
        freshData = next
        projectOpenCodeMessages(instanceId, sessionId, next, false)
      })
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "cancel", type: "session.inbox.cancelled", created: 402,
        data: { sessionID: sessionId, inboxID: targetId },
      } as any, cancel)
      for (let index = 0; index < 4200; index += 1) {
        const id = `overflow-${index}`
        data = applyOpenCodeDataEvent(instanceId, "/work", {
          id, type: "session.step.started", created: 500 + index,
          data: { sessionID: sessionId, assistantMessageID: id, agent: "build", model: { providerID: "provider", id: "model" } },
        } as any, () => { callbacks += 1 })
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50))

      assert.equal(reads, 1)
      assert.equal(callbacks, 0)
      assert.equal(freshData?.session.message.get(sessionId, targetId), undefined)
      assert.equal(store.getMessage(targetId), undefined)
      assert.ok((freshData?.session.message.list(sessionId).length ?? 0) <= 200)
    } finally {
      destroyOpenCodeData(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  it("replaces stale inbox, permission, and form state with the fresh native state", async () => {
    const instanceId = "opencode-data-fresh-complete-state"
    const sessionId = "session"
    const client = getRootClient(instanceId)
    let freshData: ReturnType<typeof applyOpenCodeDataEvent> | undefined
    stubAuthoritativeSession(client, sessionId, async () => ({ data: [], cursor: {} }))
    try {
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "permission", type: "permission.asked", created: 1,
        data: { id: "permission", sessionID: sessionId, action: "read", resources: ["*"] },
      } as any)
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "form", type: "form.created", created: 2, location: { directory: "/work" },
        data: { form: { id: "form", sessionID: sessionId, title: "Input", fields: [] } },
      } as any)
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "inbox", type: "session.inbox.enqueued", created: 3,
        data: { sessionID: sessionId, inboxID: "inbox", item: { type: "user", payload: { text: "stale" }, delivery: "queue" } },
      } as any)
      for (let index = 0; index < 199; index += 1) {
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: `seed-${index}`, type: "session.step.started", created: 10 + index,
          data: { sessionID: sessionId, assistantMessageID: `seed-${index}`, agent: "build", model: { providerID: "provider", id: "model" } },
        } as any)
      }
      for (let index = 0; index < 4096; index += 1) {
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: `overflow-${index}`, type: "session.step.started", created: 500 + index,
          data: { sessionID: sessionId, assistantMessageID: `overflow-${index}`, agent: "build", model: { providerID: "provider", id: "model" } },
        } as any, undefined, (next) => { freshData = next })
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50))

      assert.deepEqual(freshData?.session.pending.list(sessionId), [])
      assert.deepEqual(freshData?.session.input.list(sessionId), [])
      assert.deepEqual(freshData?.session.permission.list(sessionId), [])
      assert.deepEqual(freshData?.session.form.list(sessionId), [])
      assert.equal(freshData?.session.message.get(sessionId, "inbox"), undefined)
    } finally {
      destroyOpenCodeData(instanceId)
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  it("keeps 5000 state events out of the queue and converges after quiet", async () => {
    const instanceId = "opencode-data-state-overflow"
    const sessionId = "session"
    const client = getRootClient(instanceId)
    const firstRead = deferred<any>()
    const authoritative: any[] = []
    let messageReads = 0
    let callbacks = 0
    let freshData: ReturnType<typeof applyOpenCodeDataEvent> | undefined
    stubAuthoritativeSession(client, sessionId, async () => {
      messageReads += 1
      if (messageReads === 1) return firstRead.promise
      return { data: [], cursor: {} }
    })
    client.permission.list = async () => authoritative
    try {
      for (let index = 0; index < 4296; index += 1) {
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: `seed-${index}`, type: "session.step.started", created: index + 1,
          data: { sessionID: sessionId, assistantMessageID: `seed-${index}`, agent: "build", model: { providerID: "provider", id: "model" } },
        } as any)
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 40))
      assert.equal(messageReads, 1)

      let liveData!: ReturnType<typeof applyOpenCodeDataEvent>
      for (let index = 0; index < 5000; index += 1) {
        const permission = { id: `permission-${index}`, sessionID: sessionId, action: "read", resources: ["*"] }
        authoritative.push(permission)
        liveData = applyOpenCodeDataEvent(instanceId, "/work", {
          id: permission.id, type: "permission.asked", created: 5000 + index, data: permission,
        } as any, () => { callbacks += 1 }, (next) => { freshData = next })
      }
      assert.equal(messageReads, 1)
      assert.equal(callbacks, 0)
      assert.equal(liveData.session.permission.list(sessionId)?.length ?? 0, 0)
      firstRead.resolve({ data: [], cursor: {} })
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(freshData, undefined)
      await new Promise<void>((resolve) => setTimeout(resolve, 40))

      assert.equal(messageReads, 2)
      assert.equal(callbacks, 0)
      const stableData = freshData as ReturnType<typeof applyOpenCodeDataEvent> | undefined
      assert.equal(stableData?.session.permission.list(sessionId)?.length, 5000)
    } finally {
      destroyOpenCodeData(instanceId)
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  it("retries a failed overflow resync in a quiet session", async () => {
    const instanceId = "opencode-data-overflow-retry"
    const sessionId = "session"
    const client = getRootClient(instanceId)
    const authoritative = {
      id: "recovered", type: "assistant", agent: "build",
      model: { providerID: "provider", id: "model" }, content: [],
      time: { created: 5000 },
    }
    let reads = 0
    let freshData: ReturnType<typeof applyOpenCodeDataEvent> | undefined
    stubAuthoritativeSession(client, sessionId, async () => {
      reads += 1
      if (reads === 1) throw new Error("temporary failure")
      return { data: [authoritative], cursor: {} }
    })
    try {
      let data!: ReturnType<typeof applyOpenCodeDataEvent>
      for (let index = 0; index < 200; index += 1) {
        const id = `seed-${index}`
        data = applyOpenCodeDataEvent(instanceId, "/work", {
          id, type: "session.step.started", created: index * 2 + 1,
          data: { sessionID: sessionId, assistantMessageID: id, agent: "build", model: { providerID: "provider", id: "model" } },
        } as any)
        data = applyOpenCodeDataEvent(instanceId, "/work", {
          id: `${id}-end`, type: "session.step.ended", created: index * 2 + 2,
          data: { sessionID: sessionId, assistantMessageID: id, finish: "stop" },
        } as any)
      }
      for (let index = 0; index < 4200; index += 1) {
        const id = `overflow-${index}`
        data = applyOpenCodeDataEvent(instanceId, "/work", {
          id, type: "session.step.started", created: 500 + index,
          data: { sessionID: sessionId, assistantMessageID: id, agent: "build", model: { providerID: "provider", id: "model" } },
        } as any, undefined, (next) => {
          freshData = next
          projectOpenCodeMessages(instanceId, sessionId, next, false)
        })
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 40))
      assert.equal(reads, 1)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))

      assert.equal(reads, 2)
      assert.deepEqual(freshData?.session.message.list(sessionId).map((message) => message.id), ["recovered"])
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["recovered"])
    } finally {
      destroyOpenCodeData(instanceId)
      messageStoreBus.unregisterInstance(instanceId)
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  it("tracks more than 200 cancellations with one scalar revision", () => {
    const instanceId = "opencode-data-mutation-revision"
    const sessionId = "session"
    try {
      for (let index = 0; index <= 200; index += 1) {
        applyOpenCodeDataEvent(instanceId, "/work", {
          id: `cancel-${index}`, type: "session.inbox.cancelled", created: index + 1,
          data: { sessionID: sessionId, inboxID: `m${String(index).padStart(3, "0")}` },
        } as any)
      }
      assert.equal(getOpenCodeMutationRevision(instanceId, sessionId), 201)
    } finally {
      destroyOpenCodeData(instanceId)
    }
  })

  it("drops per-session message revision state on deletion", () => {
    const instanceId = "opencode-data-message-revision-cleanup"
    const sessionId = "session"
    try {
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "message", type: "session.step.started", created: 1,
        data: { sessionID: sessionId, assistantMessageID: "message", agent: "build", model: { providerID: "provider", id: "model" } },
      } as any)
      assert.equal(getOpenCodeMessageRevision(instanceId, sessionId), 1)

      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "deleted", type: "session.deleted", created: 2, data: { sessionID: sessionId },
      } as any)
      assert.equal(getOpenCodeMessageRevision(instanceId, sessionId), 0)
    } finally {
      destroyOpenCodeData(instanceId)
    }
  })

  it("processes a rotation-boundary side-effect event exactly once", async () => {
    const instanceId = "opencode-data-single-side-effect"
    const sessionId = "session"
    sseManager.seedStatus(instanceId, "connected")
    const client = getRootClient(instanceId)
    let reads = 0
    ;(client.session as any).message = async ({ messageID }: { messageID: string }) => {
      reads += 1
      return { id: messageID, type: "model-switched", model: { providerID: "provider", id: "next" }, time: { created: 500 } }
    }
    try {
      let data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "seed", type: "session.step.started", created: 1,
        data: { sessionID: sessionId, assistantMessageID: "seed", agent: "build", model: { providerID: "provider", id: "model" } },
      } as any)
      data.session.remember({
        id: sessionId, title: sessionId, projectID: "project", location: { directory: "/work" },
        time: { created: 1, updated: 1 }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as any)
      for (let index = 1; index < 200; index += 1) {
        data = applyOpenCodeDataEvent(instanceId, "/work", {
          id: `fill-${index}`, type: "session.step.started", created: index + 1,
          data: { sessionID: sessionId, assistantMessageID: `fill-${index}`, agent: "build", model: { providerID: "provider", id: "model" } },
        } as any)
        data = applyOpenCodeDataEvent(instanceId, "/work", {
          id: `end-${index}`, type: "session.step.ended", created: index + 2,
          data: { sessionID: sessionId, assistantMessageID: `fill-${index}`, finish: "stop" },
        } as any)
      }
      data = applyOpenCodeDataEvent(instanceId, "/work", { id: "model", type: "session.model.selected", created: 501, data: { sessionID: sessionId, model: { providerID: "provider", id: "next" } } } as any,
        (next) => projectOpenCodeMessages(instanceId, sessionId, next))
      projectOpenCodeMessages(instanceId, sessionId, data)
      await new Promise<void>((resolve) => setImmediate(resolve))

      assert.equal(reads, 1)
      assert.ok(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId).includes("model"))
    } finally {
      destroyOpenCodeData(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  it("drops stale live state before a reconnect generation", () => {
    const instanceId = "opencode-data-reconnect"
    const event = (id: string) => ({
      id, type: "session.step.started", created: 1,
      data: { sessionID: "session", assistantMessageID: id, agent: "build", model: { providerID: "provider", id: "model" } },
    } as any)
    try {
      applyOpenCodeDataEvent(instanceId, "/work", event("old"))
      destroyOpenCodeData(instanceId)
      const data = applyOpenCodeDataEvent(instanceId, "/work", event("new"))
      assert.deepEqual(data.session.message.list("session").map((message) => message.id), ["new"])
    } finally {
      destroyOpenCodeData(instanceId)
    }
  })

  it("drops stale live projection after server.connected without clearing REST state", () => {
    const instanceId = "opencode-data-server-connected"
    const client = getRootClient(instanceId)
    ;(client.session as any).active = async () => ({})
    ;(client.location as any).get = async () => ({ directory: "/work" })
    ;(client.vcs as any).get = async () => ({ location: { directory: "/work" }, data: { branch: "main" } })
    ;(client.project as any).list = async () => []
    try {
      const before = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "old",
        type: "session.step.started",
        created: 1,
        data: {
          sessionID: "session", assistantMessageID: "old", agent: "build",
          model: { providerID: "provider", id: "model" },
        },
      } as any)
      projectOpenCodeMessages(instanceId, "session", before)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds("session"), ["old"])

      const after = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "connected", type: "server.connected", created: 2, data: {},
      } as any)
      assert.notStrictEqual(after, before)
      assert.deepEqual(after.session.message.list("session"), [])
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds("session"), ["old"])

      const rest = normalizeSessionMessage("session", {
        id: "rest", type: "assistant", agent: "build", model: { providerID: "provider", id: "model" },
        time: { created: 2, completed: 2 }, content: [],
      } as any)
      seedSessionMessagesV2(instanceId, { id: "session" }, [rest.message], new Map([[rest.info.id, rest.info]]))

      const live = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "new", type: "session.step.started", created: 3,
        data: {
          sessionID: "session", assistantMessageID: "new", agent: "build",
          model: { providerID: "provider", id: "model" },
        },
      } as any)
      projectOpenCodeMessages(instanceId, "session", live)
      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds("session"), ["rest", "new"])
    } finally {
      destroyOpenCodeData(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  it("rebinds inbox observers after server.connected", () => {
    const instanceId = "opencode-data-inbox-reconnect"
    const sessionId = "session"
    const client = getRootClient(instanceId)
    ;(client.location as any).get = async () => ({ directory: "/work" })
    ;(client.vcs as any).get = async () => ({ location: { directory: "/work" }, data: {} })
    ;(client.project as any).list = async () => []
    let ids: string[] = []
    const dispose = createRoot((dispose) => {
      createEffect(() => {
        ids = getOpenCodeSessionInbox(instanceId, sessionId, "/work").map((item) => item.id)
      })
      return dispose
    })
    try {
      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "queued", type: "session.inbox.enqueued", created: 1,
        data: { sessionID: sessionId, inboxID: "queued", item: { type: "user", payload: { text: "old" }, delivery: "queue" } },
      } as any)
      assert.deepEqual(ids, ["queued"])

      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "connected", type: "server.connected", created: 2, data: {},
      } as any)
      assert.deepEqual(ids, [])
    } finally {
      dispose()
      destroyOpenCodeData(instanceId)
      sdkManager.destroyClientsForInstance(instanceId)
    }
  })

  it("replaces the optimistic prompt part with its native projection", () => {
    const instanceId = "opencode-data-optimistic-prompt"
    const sessionId = "session"
    const messageId = "message"
    const store = messageStoreBus.getOrCreate(instanceId)
    try {
      store.upsertMessage({
        id: messageId,
        sessionId,
        role: "user",
        status: "sending",
        isEphemeral: true,
        parts: [{ id: "optimistic-text", type: "text", text: "ping", messageID: messageId, sessionID: sessionId } as any],
      })
      store.markSendPending(messageId)
      const data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "inbox-event",
        type: "session.inbox.enqueued",
        created: 1,
        durable: { aggregateID: sessionId, seq: 1, version: 1 },
        data: {
          sessionID: sessionId,
          inboxID: messageId,
          item: { type: "user", payload: { text: "ping" }, delivery: "queue" },
        },
      } as any)
      projectOpenCodeMessages(instanceId, sessionId, data)

      const message = store.getMessage(messageId)
      assert.deepEqual(message?.partIds, [`${messageId}-text`])
      assert.equal((message?.parts[`${messageId}-text`]?.data as any)?.text, "ping")
    } finally {
      destroyOpenCodeData(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("does not project live events into a historical window", () => {
    const instanceId = "opencode-data-history-window"
    const sessionId = "session"
    const store = messageStoreBus.getOrCreate(instanceId)
    try {
      const rest = normalizeSessionMessage(sessionId, {
        id: "old", type: "assistant", agent: "build", model: { providerID: "provider", id: "model" },
        time: { created: 1, completed: 1 }, content: [],
      } as any)
      seedSessionMessagesV2(instanceId, { id: sessionId }, [rest.message], new Map([[rest.info.id, rest.info]]))
      store.setMessageWindow(sessionId, { kind: "history", resumeCursor: "c1", newerCursors: [null] })
      const data = applyOpenCodeDataEvent(instanceId, "/work", {
        id: "live", type: "session.step.started", created: 2,
        data: { sessionID: sessionId, assistantMessageID: "live", agent: "build", model: { providerID: "provider", id: "model" } },
      } as any)
      if (!store.getMessageWindow(sessionId) || store.getMessageWindow(sessionId)?.kind === "latest") projectOpenCodeMessages(instanceId, sessionId, data)
      assert.deepEqual(store.getSessionMessageIds(sessionId), ["old"])
      store.setMessageWindow(sessionId, emptyLatestWindow())
      projectOpenCodeMessages(instanceId, sessionId, data)
      assert.deepEqual(store.getSessionMessageIds(sessionId), ["old", "live"])
    } finally {
      destroyOpenCodeData(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    }
  })

  it("projects native inbox delivery order", () => {
    const instanceId = "opencode-data-delivery-order"
    const sessionId = "session"
    const apply = (event: any) => {
      const data = applyOpenCodeDataEvent(instanceId, "/work", event)
      projectOpenCodeMessages(instanceId, sessionId, data)
    }
    try {
      apply({ id: "queued", type: "session.inbox.enqueued", created: 1, data: {
        sessionID: sessionId, inboxID: "queued", item: { type: "user", payload: { text: "queued" }, delivery: "queue" },
      } })
      apply({ id: "other", type: "session.inbox.enqueued", created: 2, data: {
        sessionID: sessionId, inboxID: "other", item: { type: "user", payload: { text: "other" }, delivery: "queue" },
      } })
      apply({ id: "delivered", type: "session.inbox.delivered", created: 3, data: { sessionID: sessionId, inboxID: "queued" } })

      assert.deepEqual(messageStoreBus.getOrCreate(instanceId).getSessionMessageIds(sessionId), ["other", "queued"])
    } finally {
      destroyOpenCodeData(instanceId)
      if (messageStoreBus.getInstance(instanceId)) messageStoreBus.unregisterInstance(instanceId)
    }
  })
})
