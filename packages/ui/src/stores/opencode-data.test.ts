import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { messageStoreBus } from "./message-v2/bus.ts"
import { seedSessionMessagesV2 } from "./message-v2/bridge.ts"
import { normalizeSessionMessage } from "./message-v2/normalizers.ts"
import { applyOpenCodeDataEvent, destroyOpenCodeData, projectOpenCodeMessages } from "./opencode-data.ts"

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
})
