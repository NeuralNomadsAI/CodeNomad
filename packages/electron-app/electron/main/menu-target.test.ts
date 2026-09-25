import assert from "node:assert/strict"
import test from "node:test"
import { NEW_WINDOW_ACCELERATOR, resolveFocusedLocalTarget, resolveWindowTarget } from "./menu-target"

test("New Window has its dedicated shortcut and menu actions target focused then MRU local windows", () => {
  const local = { kind: "local" }
  const other = { kind: "local" }
  const remote = { kind: "remote" }
  const isLocal = (window: { kind: string }) => window.kind === "local"
  assert.equal(NEW_WINDOW_ACCELERATOR, "CmdOrCtrl+Shift+N")
  assert.equal(resolveFocusedLocalTarget(local, other, isLocal), local)
  assert.equal(resolveFocusedLocalTarget(remote, other, isLocal), null)
  assert.equal(resolveFocusedLocalTarget(remote, remote, isLocal), null)
  assert.equal(resolveFocusedLocalTarget(null, other, isLocal), other)
  assert.equal(resolveWindowTarget(remote, other), remote)
  assert.equal(resolveWindowTarget(null, other), other)
})
