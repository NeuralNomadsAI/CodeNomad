import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { after, it, mock } from "node:test"

// Run the real stores in CI's ordinary Node unit step with Solid's client runtime.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "solid-js") return nextResolve("solid-js/dist/solid.js", context)
    if (specifier === "solid-js/web") return nextResolve("solid-js/web/dist/web.js", context)
    return nextResolve(specifier, context)
  },
})
after(() => hooks.deregister())
const { captureSessionSurfaceIntent } = await import("./session-surface")
const { activeParentSessionId, activeSessionId, sessions, setSessions, setActiveParentSession, setActiveSession } = await import("./session-state")
const { removeSessionRuntimeState } = await import("./session-api")
const { addInstance, removeInstance } = await import("./instances")
const { captureState } = await import("../lib/hooks/use-app-session-capture")
const { attachInstanceTabMembership, detachInstanceTabMembership } = await import("./app-tab-membership")

it("10,000 deletions retain one selection reconciliation and clear the deleted family in capture", () => {
  const id = "bounded-deleted-selection"
  addInstance({ id, folder: "/bounded-repo", port: 0, pid: 0, proxyPath: "", status: "ready", client: null })
  attachInstanceTabMembership(id)
  const inventory = new Map(Array.from({ length: 10_000 }, (_, index) => {
    const sessionId = index === 0 ? "parent" : index === 1 ? "child" : `other-${index}`
    return [sessionId, { id: sessionId, parentId: index === 1 ? "parent" : null } as any] as const
  }))
  setSessions(previous => new Map(previous).set(id, inventory))
  setActiveParentSession(id, "parent")
  setActiveSession(id, "child")
  const held = captureSessionSurfaceIntent({ instanceId: id, sessionId: "child" })
  let pending: Map<string, unknown> | undefined
  const set = Map.prototype.set
  const spy = mock.method(Map.prototype, "set", function (this: Map<any, any>, key: any, value: any) {
    if (typeof key === "string" && key.startsWith("session-deletion")) pending = this
    return set.call(this, key, value)
  })
  try {
    for (const sessionId of [...inventory.keys()]) removeSessionRuntimeState(id, sessionId)
    assert.equal(pending?.size, 1, "retained callbacks stay O(1), including unrelated deletions")
    assert.equal(held.current(), true)
    assert.deepEqual([activeParentSessionId().get(id), activeSessionId().get(id)], ["parent", "child"])
    held.release()
    assert.deepEqual([activeParentSessionId().get(id), activeSessionId().get(id)], [undefined, undefined])
    assert.equal(sessions().get(id), undefined)
    const captured = captureState(new Map()).state.tabs.find(tab => tab.kind === "workspace" && tab.folder === "/bounded-repo")
    assert.ok(captured?.kind === "workspace")
    assert.deepEqual([captured.activeParentSessionId, captured.activeSessionId], [undefined, undefined])
  } finally {
    spy.mock.restore()
    held.release()
    detachInstanceTabMembership(id)
    removeInstance(id)
  }
})
