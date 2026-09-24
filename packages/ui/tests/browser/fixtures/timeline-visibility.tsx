import { buildTimelineSegments, hasTimelineSegments } from "../../../src/components/message-timeline"
import { clearRecordDisplayCacheForInstance } from "../../../src/stores/message-v2/record-display-cache"
import type { MessageRecord } from "../../../src/stores/message-v2/types"
import type { ClientPart } from "../../../src/types/message"

const instanceId = "timeline-visibility"
const t = (key: string) => key
const text = (value: string) => ({ type: "text", text: value })
const reasoning = (value: string) => ({ type: "reasoning", text: value })
const tool = { type: "tool", tool: "shell", state: { status: "completed", input: { command: "pwd" }, output: "/fixture" } }
type Part = Record<string, unknown>
function record(id: string, parts: Part[], role: "user" | "assistant" = "assistant"): MessageRecord {
  return { id, sessionId: "session", role, status: "complete", createdAt: 1, updatedAt: 1, revision: 1,
    partIds: parts.map((_, i) => `${id}-${i}`),
    parts: Object.fromEntries(parts.map((part, i) => {
      const partId = `${id}-${i}`
      return [partId, { id: partId, revision: 1, data: { ...part, id: partId } as ClientPart }]
    })),
  }
}

;(window as any).fixture = {
  cases: () => {
    const cases: Array<{ name: string; parts: Part[]; expected: boolean; role?: "user" | "assistant" }> = [
      { name: "empty", parts: [], expected: false },
      { name: "blank text", parts: [text(" \n\t")], expected: false },
      { name: "assistant text", parts: [text("hello")], expected: true },
      { name: "synthetic text", parts: [{ ...text("hidden"), synthetic: true }], expected: false },
      { name: "hidden text after reasoning", parts: [reasoning("thinking"), { ...text("hidden"), synthetic: true }], expected: false },
      { name: "assistant reasoning only", parts: [reasoning("thinking")], expected: false },
      { name: "user reasoning only", parts: [reasoning("thinking")], expected: true, role: "user" },
      { name: "blank user reasoning", parts: [reasoning(" \n")], expected: false, role: "user" },
      { name: "nested reasoning", parts: [{ type: "reasoning", content: [{ text: "nested" }] }], expected: false },
      { name: "reasoning then text", parts: [reasoning("thinking"), text("answer")], expected: true },
      { name: "tool only", parts: [tool], expected: true },
      { name: "compacted tool", parts: [{ ...tool, state: { ...tool.state, time: { compacted: 1 } } }], expected: true },
      { name: "reasoning then tool", parts: [reasoning("thinking"), tool], expected: true },
      { name: "step metadata only", parts: [{ type: "step-start" }, { type: "step-finish" }, { type: "system", text: "metadata" }], expected: false },
      { name: "compaction", parts: [{ type: "compaction", auto: true }], expected: true },
      { name: "named file", parts: [{ type: "file", filename: "fixture.txt" }], expected: true },
      { name: "unnamed attachment", parts: [{ type: "file" }], expected: true },
      { name: "tool outside display window", parts: Array.from({ length: 201 }, (_, i) => i === 100 ? tool : { type: "step-start" }), expected: false },
      { name: "tool inside display tail", parts: Array.from({ length: 201 }, (_, i) => i === 101 ? tool : { type: "step-start" }), expected: true },
    ]
    try {
      return cases.map(({ name, parts, role, expected }, i) => {
        const message = record(`case-${i}`, parts, role)
        return { name, expected, present: hasTimelineSegments(instanceId, message, t), rendered: buildTimelineSegments(instanceId, message, t).length > 0 }
      })
    } finally { clearRecordDisplayCacheForInstance(instanceId) }
  },
  payloadReads: () => {
    let serialized = 0, outputReads = 0
    const input = { toJSON: () => { serialized++; return { command: "x".repeat(1024 * 1024) } } }
    const state = { status: "completed", input, get output() { outputReads++; return "x".repeat(1024 * 1024) } }
    const message = record("payload", [{ ...tool, state }])
    try {
      const present = hasTimelineSegments(instanceId, message, t)
      const presenceWork = { serialized, outputReads }
      const segments = buildTimelineSegments(instanceId, message, t)
      return { present, presenceWork, timelineWork: { serialized, outputReads }, totalChars: segments[0].totalChars }
    } finally { clearRecordDisplayCacheForInstance(instanceId) }
  },
}
