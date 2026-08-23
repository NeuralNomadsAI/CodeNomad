import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { messageStoreBus } from "./message-v2/bus.ts"
import { seedSessionMessagesV2 } from "./message-v2/bridge.ts"
import { normalizeSessionMessage } from "./message-v2/normalizers.ts"
import { applyOpenCodeDataEvent, destroyOpenCodeData, projectOpenCodeMessages } from "./opencode-data.ts"
import { emptyLatestWindow } from "./message-v2/message-window.ts"
import { getRootClient } from "./opencode-client.ts"
import { sdkManager } from "../lib/sdk-manager.ts"

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

      apply("permission.asked", { id: "permission", sessionID: "session", action: "read", resources: ["*"] })
      assert.equal(data.session.permission.list("session")?.[0]?.id, "permission")

      applyOpenCodeDataEvent(instanceId, "/work", {
        id: "form", type: "form.created", created: 4, location: { directory: "/work" },
        data: { form: { id: "form", sessionID: "session", title: "Input", fields: [] } },
      } as any)
      assert.equal(data.session.form.list("session")?.[0]?.id, "form")
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
