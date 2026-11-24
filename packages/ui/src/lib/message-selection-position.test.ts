import assert from "node:assert/strict"
import { test } from "node:test"
import { getMessageSelectionActionPosition } from "./message-selection-position.ts"

test("places touch selection actions below the final line while desktop stays above", () => {
  const rects = [
    { top: 180, bottom: 200, left: 120 },
    { top: 220, bottom: 240, left: 80 },
  ]
  const shell = { top: 100, left: 20 }

  assert.deepEqual(getMessageSelectionActionPosition(rects, rects[0]!, shell, 400, 300, false), {
    top: 40,
    left: 100,
  })
  assert.deepEqual(getMessageSelectionActionPosition(rects, rects[0]!, shell, 400, 300, true), {
    top: 172,
    left: 60,
  })
})

test("keeps touch selection actions visible near the bottom edge", () => {
  const rect = { top: 340, bottom: 360, left: 80 }

  assert.deepEqual(
    getMessageSelectionActionPosition([rect], rect, { top: 100, left: 20 }, 400, 300, true),
    { top: 8, left: 60 },
  )
})
