import assert from "node:assert/strict"
import { test } from "node:test"
import { withHiddenWindow } from "./hide-console-windows.mjs"

const callback = () => {}
const hidden = { windowsHide: true }

test("exec and execSync calls default to a hidden window, keeping their callback and options", () => {
  assert.deepEqual(withHiddenWindow(["net use"], false), ["net use", hidden])
  assert.deepEqual(withHiddenWindow(["net use", callback], false), ["net use", hidden, callback])
  assert.deepEqual(withHiddenWindow(["net use", undefined, callback], false), ["net use", hidden, callback])
  assert.deepEqual(withHiddenWindow(["net use", null, callback], false), ["net use", hidden, callback])
  assert.deepEqual(withHiddenWindow(["net use", { cwd: "x" }, callback], false), ["net use", { windowsHide: true, cwd: "x" }, callback])
  assert.deepEqual(withHiddenWindow(["net use", { windowsHide: false }], false), ["net use", { windowsHide: false }])
})

test("spawn and execFile calls default to a hidden window, whatever form their argument list takes", () => {
  assert.deepEqual(withHiddenWindow(["git"], true), ["git", hidden])
  assert.deepEqual(withHiddenWindow(["git", ["status"]], true), ["git", ["status"], hidden])
  assert.deepEqual(withHiddenWindow(["git", { cwd: "x" }], true), ["git", { windowsHide: true, cwd: "x" }])
  assert.deepEqual(withHiddenWindow(["git", ["status"], { cwd: "x" }], true), ["git", ["status"], { windowsHide: true, cwd: "x" }])
  assert.deepEqual(withHiddenWindow(["git", undefined], true), ["git", hidden])
  // An explicit nullish argument list keeps the options and callback that follow it.
  assert.deepEqual(withHiddenWindow(["git", undefined, { cwd: "x", windowsHide: false }], true), ["git", [], { cwd: "x", windowsHide: false }])
  assert.deepEqual(withHiddenWindow(["git", null, { cwd: "x" }, callback], true), ["git", [], { windowsHide: true, cwd: "x" }, callback])
  assert.deepEqual(withHiddenWindow(["git", undefined, callback], true), ["git", [], hidden, callback])
  assert.deepEqual(withHiddenWindow(["git", callback], true), ["git", hidden, callback])
  assert.deepEqual(withHiddenWindow(["git", ["status"], undefined, callback], true), ["git", ["status"], hidden, callback])
  assert.deepEqual(withHiddenWindow(["git", ["status"], callback], true), ["git", ["status"], hidden, callback])
})
