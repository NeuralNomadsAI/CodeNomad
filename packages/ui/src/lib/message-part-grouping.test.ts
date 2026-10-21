import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getTechnicalCleanupParts, groupTechnicalParts, hasVisibleUsage, isResponseTextPart, projectTranscriptTechnicalGroups, projectUsageLines, segmentExplorationItems, technicalPartKey, type TechnicalCleanupTranscriptItem, type UsageStep } from "./message-part-grouping.ts"
import type { ClientPart, MessageInfo } from "../types/message.ts"

const part = (id: string, type: ClientPart["type"], tool?: string) => ({ id, type, ...(tool ? { tool } : {}) }) as ClientPart

describe("message technical part grouping", () => {
  it("matches the TUI reasoning and exploration boundaries", () => {
    const groups = groupTechnicalParts([
      part("r1", "reasoning"),
      part("r2", "reasoning"),
      part("read", "tool", "Read"),
      part("grep", "tool", "grep"),
      part("bash", "tool", "bash"),
      part("glob", "tool", "glob"),
      part("text", "text"),
      part("r3", "reasoning"),
    ])

    assert.deepEqual(groups.map((group) => group.kind === "part"
      ? [group.kind, group.part.id]
      : [group.kind, group.parts.map((item) => item.id)]), [
      ["reasoning", ["r1", "r2"]],
      ["exploration", ["read", "grep"]],
      ["shell", ["bash"]],
      ["exploration", ["glob"]],
      ["part", "text"],
      ["reasoning", ["r3"]],
    ])
  })

  it("keeps pending exploration tools in place and splits surrounding groups", () => {
    const segments = segmentExplorationItems(["read", "grep", "glob"], (item) => item === "grep")

    assert.deepEqual(segments, [
      { kind: "group", items: ["read"] },
      { kind: "pending", item: "grep" },
      { kind: "group", items: ["glob"] },
    ])
  })

  it("groups technical parts across assistant messages until a visible boundary", () => {
    const item = (messageId: string, value: ClientPart, completed = true) => ({
      messageId,
      partId: value.id!,
      part: value,
      completed,
      revision: "1",
    })
    const reasoning1 = part("r1", "reasoning")
    const reasoning2 = part("r2", "reasoning")
    const read = part("read", "tool", "read")
    const grep = part("grep", "tool", "grep")
    const glob = part("glob", "tool", "glob")
    const projection = projectTranscriptTechnicalGroups([
      item("assistant-1", reasoning1),
      item("assistant-2", reasoning2),
      item("assistant-2", read),
      item("assistant-3", grep),
      null,
      item("assistant-4", glob, false),
    ])

    assert.deepEqual(projection.groups.map((group) => [
      group.kind,
      group.parts.map((entry) => technicalPartKey(entry.messageId, entry.partId)),
      group.completed,
    ]), [
      ["reasoning", ["assistant-1:r1", "assistant-2:r2"], true],
      ["exploration", ["assistant-2:read", "assistant-3:grep"], true],
      ["exploration", ["assistant-4:glob"], false],
    ])
    assert.equal(projection.byPartKey.get("assistant-3:grep"), projection.groups[1])
    assert.deepEqual(
      groupTechnicalParts([read, grep], (value) => projection.byPartKey.get(technicalPartKey(
        value === read ? "assistant-2" : "assistant-3",
        value.id!,
      ))?.id).map((group) => group.kind),
      ["exploration"],
    )
    assert.equal(groupTechnicalParts([read, glob], (value) => value.id).length, 2)
  })

  it("groups consecutive shell tools until another kind", () => {
    const groups = groupTechnicalParts([
      part("bash-1", "tool", "bash"),
      part("shell-2", "tool", "shell"),
      part("read", "tool", "read"),
      part("bash-3", "tool", "bash"),
    ])

    assert.deepEqual(groups.map((group) => group.kind === "part"
      ? [group.kind, group.part.id]
      : [group.kind, group.parts.map((item) => item.id)]), [
      ["shell", ["bash-1", "shell-2"]],
      ["exploration", ["read"]],
      ["shell", ["bash-3"]],
    ])
  })

  it("selects only technical parts between the previous boundary and the targeted response", () => {
    const items: TechnicalCleanupTranscriptItem[] = [
      null,
      { messageId: "assistant-1", partId: "reasoning-1", type: "reasoning" },
      { messageId: "assistant-2", partId: "tool-1", type: "tool" },
      { messageId: "assistant-2", partId: "response-1", type: "boundary" },
      { messageId: "assistant-2", partId: "tool-after", type: "tool" },
      { messageId: "assistant-3", partId: "reasoning-2", type: "reasoning" },
      { messageId: "assistant-3", partId: "response-2", type: "boundary" },
    ]

    assert.deepEqual(getTechnicalCleanupParts(items, "assistant-2", "response-1"), [
      { messageId: "assistant-1", partId: "reasoning-1", type: "reasoning" },
      { messageId: "assistant-2", partId: "tool-1", type: "tool" },
    ])
    assert.deepEqual(getTechnicalCleanupParts(items, "assistant-3", "response-2"), [
      { messageId: "assistant-2", partId: "tool-after", type: "tool" },
      { messageId: "assistant-3", partId: "reasoning-2", type: "reasoning" },
    ])
  })

  it("shows usage only for settled assistant steps while the preference is visible", () => {
    const info = (role: MessageInfo["role"], tokens?: MessageInfo["tokens"]) => ({ id: "m", sessionID: "s", role, time: { created: 1 }, tokens }) as MessageInfo
    assert.equal(hasVisibleUsage(undefined, true), false)
    assert.equal(hasVisibleUsage(info("assistant"), true), false, "a running step has no usage yet")
    assert.equal(hasVisibleUsage(info("assistant", { input: 1 }), true), true)
    assert.equal(hasVisibleUsage(info("assistant", { input: 1 }), false), false)
    assert.equal(hasVisibleUsage(info("user", { input: 1 }), true), false)
  })

  it("shows one usage line after every agent message, summed since the previous one", () => {
    const step = (messageId: string, input?: number, hasResponseText = false): UsageStep => ({ messageId, hasResponseText,
      info: { id: messageId, sessionID: "s", role: "assistant", time: { created: 1 }, cost: input,
        ...(input === undefined ? {} : { tokens: { input, output: 1, cache: { read: 2 } } }) } })
    const end = (messageId: string): UsageStep => ({ messageId, endsTurn: true })
    const lines = (steps: UsageStep[]) => Object.fromEntries([...projectUsageLines(steps)].map(([id, line]) =>
      [id, [line.info.tokens?.input, line.info.tokens?.output, line.info.tokens?.cache?.read, line.info.cost]]))

    assert.deepEqual(lines([end("prompt"), step("looking-then-read", 10, true), step("read", 20), step("grep", 30), step("answer", 40, true), end("idle")]),
      { "looking-then-read": [10, 1, 2, 10], answer: [90, 3, 6, 90] }, "tool-only steps count toward the next message")
    assert.deepEqual(lines([end("prompt"), step("answer", 10, true), step("read", 20), end("idle")]), { answer: [10, 1, 2, 10] },
      "a turn ending without a message shows no line for its last steps")
    assert.deepEqual(lines([end("prompt"), step("read", 20), step("streaming", undefined, true)]), {},
      "an open turn shows nothing until its response settles")
    assert.deepEqual(lines([step("read", 20), end("next-prompt"), step("answer", 40, true)]), { answer: [40, 1, 2, 40] },
      "a prompt drops the previous turn's unanswered steps")
    const failed = step("partial-answer", 30, true)
    failed.info!.error = { name: "MessageAbortedError", type: "aborted", message: "Interrupted" } as MessageInfo["error"]
    assert.deepEqual(lines([end("prompt"), step("read", 20), failed, end("idle")]), {}, "a failed step shows no line, even after some text")
  })

  it("counts only visible, non-synthetic text as an agent message", () => {
    const text = (id: string, value: string, synthetic = false) => ({ id, type: "text", text: value, ...(synthetic ? { synthetic } : {}) }) as ClientPart
    assert.equal(isResponseTextPart(text("t", "Looking")), true)
    assert.equal(isResponseTextPart(text("error", "")), false, "an error placeholder is no message")
    assert.equal(isResponseTextPart(text("s", "hidden", true)), false)
    assert.equal(isResponseTextPart(part("read", "tool", "read")), false)
  })
})
