import assert from "node:assert/strict"
import test from "node:test"

import { clampEmbeddedDrawerWidth, resolveEmbeddedDrawers } from "./drawer-layout.ts"

const widths = {
  minimumCenterWidth: 480,
  minimumLeftWidth: 220,
  minimumRightWidth: 200,
  leftWidth: 320,
  rightWidth: 400,
  leftOpen: true,
  rightOpen: true,
}

test("drawers shrink before progressively overlaying", () => {
  assert.deepEqual(resolveEmbeddedDrawers({ ...widths, hostWidth: 1_200 }), {
    left: true,
    right: true,
    leftWidth: 320,
    rightWidth: 400,
  })
  assert.deepEqual(resolveEmbeddedDrawers({ ...widths, hostWidth: 1_000 }), {
    left: true,
    right: true,
    leftWidth: 320,
    rightWidth: 200,
  })
  assert.deepEqual(resolveEmbeddedDrawers({ ...widths, hostWidth: 900 }), {
    left: true,
    right: true,
    leftWidth: 220,
    rightWidth: 200,
  })
  assert.deepEqual(resolveEmbeddedDrawers({ ...widths, hostWidth: 700 }), {
    left: true,
    right: false,
    leftWidth: 220,
    rightWidth: 400,
  })
  assert.deepEqual(resolveEmbeddedDrawers({ ...widths, hostWidth: 699 }), {
    left: false,
    right: false,
    leftWidth: 320,
    rightWidth: 400,
  })
  assert.deepEqual(resolveEmbeddedDrawers({ ...widths, hostWidth: 900, leftOpen: false }), {
    left: false,
    right: true,
    leftWidth: 320,
    rightWidth: 400,
  })
})

test("manual drawer resizing stops at the minimum center width", () => {
  assert.equal(clampEmbeddedDrawerWidth(221, 220, 220, 320), 320)
  assert.equal(clampEmbeddedDrawerWidth(299, 200, 300, 400), 299)
  assert.equal(clampEmbeddedDrawerWidth(500, 220, 420, 320), 420)
})
