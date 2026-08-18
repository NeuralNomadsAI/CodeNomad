import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  resolveFormToolTarget,
  resolveInlineFormToolTarget,
  shouldRenderFormInFallback,
  shouldRenderLegacyQuestionBlock,
} from "./form-request-tool-target.ts"

function store(messages: Record<string, any>, ids = Object.keys(messages)) {
  return {
    getSessionMessageIds: () => ids,
    getMessage: (messageId: string) => messages[messageId],
  }
}

describe("form request tool target", () => {
  it("resolves the explicit question tool reference", () => {
    const form = {
      id: "form-question", sessionID: "session", title: "Questions", fields: [],
      metadata: { kind: "question", tool: { messageID: "message-1", id: "call-1" } },
    } as any
    const target = resolveFormToolTarget(form, store({
      "message-1": { partIds: ["part-1"], parts: { "part-1": { data: { id: "part-1", type: "tool", tool: "question", callID: "call-1" } } } },
    }))

    assert.deepEqual(target, { messageId: "message-1", partId: "part-1" })
  })

  it("attaches web search provider selection to the latest websearch call", () => {
    const form = {
      id: "form-websearch", sessionID: "session", title: "Web Search", fields: [],
      metadata: { kind: "websearch.provider" },
    } as any
    const target = resolveFormToolTarget(form, store({
      old: { partIds: ["old-part"], parts: { "old-part": { data: { type: "tool", tool: "websearch" } } } },
      current: { partIds: ["current-part"], parts: { "current-part": { data: { type: "tool", tool: "websearch" } } } },
    }, ["old", "current"]))

    assert.deepEqual(target, { messageId: "current", partId: "current-part" })
  })

  it("leaves global forms unscoped", () => {
    const form = { id: "global", sessionID: "session", title: "Global", fields: [] } as any
    assert.equal(resolveFormToolTarget(form, store({})), null)
  })

  it("lets a native form replace the legacy question block for its tool call", () => {
    const form = { id: "form-question", sessionID: "session", title: "Questions", fields: [] } as any

    assert.equal(shouldRenderLegacyQuestionBlock(form), false)
    assert.equal(shouldRenderLegacyQuestionBlock(undefined), true)
  })

  it("uses floating fallback when the resolved tool belongs to another session", () => {
    const form = {
      id: "form-question", sessionID: "other", title: "Questions", fields: [],
      metadata: { tool: { messageID: "message-1", id: "call-1" } },
    } as any
    const reader = store({
      "message-1": { partIds: ["part-1"], parts: { "part-1": { data: { id: "part-1", type: "tool", callID: "call-1" } } } },
    })

    assert.equal(resolveInlineFormToolTarget(form, reader, "current"), null)
    assert.deepEqual(resolveInlineFormToolTarget(form, reader, "other"), { messageId: "message-1", partId: "part-1" })
    assert.equal(shouldRenderFormInFallback(form, reader, "current"), true)
    assert.equal(shouldRenderFormInFallback(form, reader, "other"), false)
  })
})
