import assert from "node:assert/strict"
import test from "node:test"
import {
  extractReasoningTextForCopy,
  extractReasoningTextForRender,
  extractReasoningTitleForRender,
  REASONING_RENDER_CHARACTER_LIMIT,
  REASONING_RENDER_NODE_LIMIT,
  REASONING_TITLE_CHARACTER_LIMIT,
} from "../lib/message-render-cache.ts"
import { buildRecordDisplayData, MESSAGE_PART_DISPLAY_LIMIT } from "../stores/message-v2/record-display-cache.ts"
import type { MessageRecord } from "../stores/message-v2/types.ts"

test("caps parts before traversing or cloning the record tail", () => {
  const accessed: string[] = []
  const partIds = Array.from({ length: MESSAGE_PART_DISPLAY_LIMIT + 1 }, (_, index) => `part-${index}`)
  const parts = new Proxy({}, {
    get(_target, partId: string) {
      accessed.push(partId)
      return { revision: 1, data: { id: partId, type: "text", text: partId } }
    },
  })
  const record = { id: "bounded-message", revision: 1, partIds, parts } as unknown as MessageRecord

  const display = buildRecordDisplayData("render-limit-test", record)

  assert.equal(display.orderedParts.length, MESSAGE_PART_DISPLAY_LIMIT)
  assert.equal(display.truncated, true)
  assert.equal(accessed.length, MESSAGE_PART_DISPLAY_LIMIT)
  assert.equal(accessed.includes(`part-${MESSAGE_PART_DISPLAY_LIMIT}`), false)
})

test("bounds reasoning display work while copy remains authoritative and lazy", () => {
  const tail = "COPY_ONLY_TAIL"
  const part = { type: "reasoning", text: `${"x".repeat(REASONING_RENDER_CHARACTER_LIMIT)}${tail}` }
  const rendered = extractReasoningTextForRender(part)

  assert.equal(rendered.length, REASONING_RENDER_CHARACTER_LIMIT)
  assert.equal(rendered.includes(tail), false)
  assert.equal(extractReasoningTextForCopy(part).endsWith(tail), true)
  assert.equal(extractReasoningTitleForRender(`\n**bounded title**\n${"t".repeat(REASONING_TITLE_CHARACTER_LIMIT)}`), "bounded title")
})

test("stops traversing nested reasoning at the display node budget", () => {
  let furthestIndex = -1
  const content = new Proxy(Array.from({ length: REASONING_RENDER_NODE_LIMIT }, (_, index) => String(index)), {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) furthestIndex = Number(key)
      return Reflect.get(target, key, receiver)
    },
  })

  extractReasoningTextForRender({ type: "reasoning", content })

  assert.ok(furthestIndex >= 0)
  assert.ok(furthestIndex < content.length - 1)
})
