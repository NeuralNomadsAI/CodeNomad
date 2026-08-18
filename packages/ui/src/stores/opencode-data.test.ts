import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { messageStoreBus } from "./message-v2/bus.ts"
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
})
