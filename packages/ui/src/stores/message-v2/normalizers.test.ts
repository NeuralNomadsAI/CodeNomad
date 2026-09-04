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

  it("maps assistant messages that omit model metadata", () => {
    const result = normalizeSessionMessage("session", {
      id: "assistant",
      type: "assistant",
      agent: "build",
      time: { created: 2 },
      content: [],
    } as unknown as SessionMessageInfo)

    assert.equal(result.info.role, "assistant")
    assert.equal(result.info.providerID, undefined)
    assert.equal(result.info.modelID, undefined)
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

  it("reconstructs inline base64 files and preserves URI sources", () => {
    const inline = normalizeSessionMessage("session", {
      id: "inline", type: "user", text: "image", time: { created: 1 },
      files: [{ data: "aGVsbG8=", mime: "image/png", source: { type: "inline" }, name: "image.png" }],
    }).message.parts[1] as any
    const uri = normalizeSessionMessage("session", {
      id: "uri", type: "user", text: "file", time: { created: 1 },
      files: [{ data: "", mime: "text/plain", source: { type: "uri", uri: "file:///repo/readme.txt" } }],
    }).message.parts[1] as any

    assert.equal(inline.url, "data:image/png;base64,aGVsbG8=")
    assert.equal(uri.url, "file:///repo/readme.txt")
  })

  it("completes immutable control records instead of marking them as streaming", () => {
    const controls: SessionMessageInfo[] = [
      { id: "agent", type: "agent-switched", agent: "build", time: { created: 1 } },
      { id: "model", type: "model-switched", model: { providerID: "p", id: "m" }, time: { created: 1 } },
      { id: "location", type: "location-switched", location: { directory: "/repo" }, time: { created: 1 } },
      { id: "system", type: "system", text: "notice", time: { created: 1 } },
    ]

    assert.deepEqual(controls.map((source) => normalizeSessionMessage("session", source).message.status), [
      "complete", "complete", "complete", "complete",
    ])
  })

  it("maps shell and compaction records to display statuses and text", () => {
    const shell = normalizeSessionMessage("session", {
      id: "shell", type: "shell", shellID: "sh", command: "pwd", status: "exited", exit: 0,
      output: { output: "/repo", cursor: 5, size: 5, truncated: false }, time: { created: 1, completed: 2 },
    }).message
    const compacted = normalizeSessionMessage("session", {
      id: "compact", type: "compaction", status: "completed", reason: "manual", summary: "summary", recent: "recent",
      time: { created: 1 },
    }).message
    const running = normalizeSessionMessage("session", {
      id: "running", type: "compaction", status: "running", reason: "auto", summary: "partial", recent: "recent",
      time: { created: 1 },
    }).message
    const failed = normalizeSessionMessage("session", {
      id: "failed", type: "compaction", status: "failed", reason: "auto",
      error: { type: "CompactionError", message: "too large", status: 413 }, time: { created: 1 },
    })

    assert.equal(shell.status, "complete")
    assert.equal(compacted.status, "complete")
    assert.equal((compacted.parts[0] as any).text, "summary")
    assert.equal(running.status, "sent")
    assert.equal((running.parts[0] as any).text, "partial")
    assert.equal(failed.message.status, "error")
    assert.equal((failed.message.parts[0] as any).text, "too large")
    assert.deepEqual(failed.info.error, {
      type: "CompactionError", message: "too large", status: 413,
      name: "CompactionError", data: { message: "too large" },
    })
  })

  it("keeps assistant prompt errors structured", () => {
    const result = normalizeSessionMessage("session", {
      id: "assistant-error", type: "assistant", agent: "build", model: { providerID: "p", id: "m" },
      content: [], error: { type: "ProviderError", message: "rate limited", status: 429 }, time: { created: 1 },
    })

    assert.equal(result.message.status, "error")
    assert.deepEqual(result.info.error, {
      type: "ProviderError", message: "rate limited", status: 429,
      name: "ProviderError", data: { message: "rate limited" },
    })

    const aborted = normalizeSessionMessage("session", {
      id: "assistant-aborted", type: "assistant", agent: "build", model: { providerID: "p", id: "m" },
      content: [], error: { type: "aborted", message: "Step interrupted" }, time: { created: 1 },
    })
    assert.equal(aborted.info.error?.name, "MessageAbortedError")
    assert.equal(aborted.message.parts.length, 1)
  })
})
