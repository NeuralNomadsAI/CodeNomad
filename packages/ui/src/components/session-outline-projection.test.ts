import assert from "node:assert/strict"
import { test } from "node:test"

import type { OutlineEntry } from "../../../server/src/opencode/session-pruning/navigation-contract"
import { createSessionOutlineProjection } from "./session-outline-projection"
import type { TimelineSegment } from "./message-timeline"

const t = (key: string) => key
const entry = (toolName = "shell"): OutlineEntry => ({
  id: "message", seq: 1, type: "assistant", tools: 1, reasoning: 0, toolName,
})
const resident = (toolName: string): TimelineSegment[] => [{
  id: "message:tool", messageId: "message", type: "tool", label: "tool", tooltip: toolName,
  toolName, toolPartIds: ["part"], totalChars: 10,
}, {
  id: "message:assistant", messageId: "message", type: "assistant", label: "assistant", tooltip: "done", totalChars: 4,
}]

test("outline tool groups retain a representative icon name without loading message bodies", () => {
  const project = createSessionOutlineProjection()
  const indexed = project([entry("shell")], [], t)
  assert.equal(indexed.find(segment => segment.type === "tool")?.toolName, "shell")

  const hydrated = project([entry("shell")], resident("read"), t)
  assert.equal(hydrated.find(segment => segment.type === "tool")?.toolName, "read")

  const updated = project([entry("grep")], [], t)
  assert.equal(updated.find(segment => segment.type === "tool")?.toolName, "grep",
    "marker identity caching must not retain an obsolete icon")
})
