import assert from "node:assert/strict"
import test from "node:test"

import { createOrientationDrawerMemory } from "./drawer-orientation.ts"

test("portrait starts closed and each orientation returns its own drawers", () => {
  const rotate = createOrientationDrawerMemory({ left: true, right: true })
  assert.deepEqual(rotate("landscape", "portrait", { left: true, right: false }), { left: false, right: false })
  // The user opens the left drawer in portrait only.
  assert.deepEqual(rotate("portrait", "landscape", { left: true, right: false }), { left: true, right: false })
  assert.deepEqual(rotate("landscape", "portrait", { left: true, right: true }), { left: true, right: false })
  assert.deepEqual(rotate("portrait", "landscape", { left: false, right: false }), { left: true, right: true })
})

test("a portrait start leaves landscape closed until the user opens a drawer there", () => {
  const rotate = createOrientationDrawerMemory({ left: false, right: false })
  assert.deepEqual(rotate("portrait", "landscape", { left: false, right: false }), { left: false, right: false })
})
