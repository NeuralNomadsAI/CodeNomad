import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { SessionMessageInfo } from "@opencode-ai/client"
import { normalizeSessionMessage } from "./normalizers.ts"

describe("native session message normalization", () => {
  it("maps native user text into the existing render model", () => {
    const result = normalizeSessionMessage("session", {
      id: "user",
      type: "user",
      text: "hello &amp; goodbye",
      time: { created: 1 },
    })

    assert.equal(result.info.role, "user")
    assert.equal(result.message.parts[0]?.type, "text")
    assert.equal((result.message.parts[0] as { text?: string }).text, "hello & goodbye")
  })

  it("maps assistant metadata and tool output without exposing the native union", () => {
    const source: SessionMessageInfo = {
      id: "assistant",
      type: "assistant",
      agent: "build",
      model: { providerID: "provider", id: "model", variant: "high" },
      time: { created: 2, completed: 3 },
      content: [{
        id: "tool",
        type: "tool",
        name: "bash",
        time: { created: 2, completed: 3 },
        state: { status: "completed", input: { command: "pwd" }, content: [{ type: "text", text: "/repo" }] },
      }],
    }
    const result = normalizeSessionMessage("session", source)
    const part = result.message.parts[0] as any

    assert.deepEqual(
      { role: result.info.role, provider: result.info.providerID, model: result.info.modelID, variant: result.info.variant },
      { role: "assistant", provider: "provider", model: "model", variant: "high" },
    )
    assert.deepEqual({ type: part.type, tool: part.tool, callID: part.callID, output: part.state.output }, {
      type: "tool", tool: "bash", callID: "tool", output: "/repo",
    })
    assert.equal(result.message.status, "complete")
  })

  it("normalizes native streaming tool input to the renderer pending state", () => {
    const source: SessionMessageInfo = {
      id: "assistant",
      type: "assistant",
      agent: "build",
      model: { providerID: "provider", id: "model" },
      time: { created: 2 },
      content: [{
        id: "tool",
        type: "tool",
        name: "bash",
        time: { created: 2 },
        state: { status: "streaming", input: "{\"command\":" },
      }],
    }

    const part = normalizeSessionMessage("session", source).message.parts[0] as any
    assert.deepEqual(part.state, { status: "pending" })
  })

  it("normalizes native reasoning text for the existing renderer", () => {
    const source: SessionMessageInfo = {
      id: "assistant",
      type: "assistant",
      agent: "build",
      model: { providerID: "provider", id: "model" },
      time: { created: 2 },
      content: [{ type: "reasoning", text: "one &lt; two" }],
    }

    const part = normalizeSessionMessage("session", source).message.parts[0] as any
    assert.deepEqual({ type: part.type, text: part.text }, { type: "reasoning", text: "one < two" })
  })
})
