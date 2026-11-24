import assert from "node:assert/strict"
import test from "node:test"
import { createRoot, createSignal } from "solid-js"
import type { PermissionRequest } from "../types/permission"
import { createPermissionDiffReviews } from "./permission-diff-review"

const request = (diff = "x".repeat(20_001)): PermissionRequest => ({
  id: "request", sessionID: "session", action: "edit", resources: ["a.ts"], metadata: { diff, path: "a.ts" },
})

test("same-request reconciliation preserves access but diff/path changes invalidate it", () => {
  createRoot((dispose) => {
    const initial = request()
    const [queue, setQueue] = createSignal([initial])
    const review = createPermissionDiffReviews(() => "instance", queue)
    const first = review(initial)!
    first.complete()
    assert.equal(first.reviewed(), true)
    setQueue([{ ...initial, metadata: { ...initial.metadata, refreshed: true } }])
    assert.equal(review(initial), first)
    setQueue([request("changed".repeat(3_000))])
    assert.equal(review(initial)!.reviewed(), false)
    first.complete()
    assert.equal(review(initial)!.reviewed(), false)
    setQueue([initial])
    assert.notEqual(review(initial), first)
    assert.equal(review(initial)!.reviewed(), false)
    review(initial)!.complete()
    // Reconciliation must invalidate even if a closed view never reads the interim diff.
    setQueue([request("interim")])
    setQueue([initial])
    assert.equal(review(initial)!.reviewed(), false)
    review(initial)!.complete()
    setQueue([{ ...initial, metadata: { ...initial.metadata, path: "b.ts" } }])
    assert.equal(review(initial)!.reviewed(), false)
    dispose()
  })
})

test("access stays scoped to instance/session/request and late completion is fenced", () => {
  createRoot((dispose) => {
    const initial = request()
    const [queue, setQueue] = createSignal([initial])
    const [instance, setInstance] = createSignal("instance")
    const review = createPermissionDiffReviews(instance, queue)
    const first = review(initial)!
    first.complete()
    const sibling = { ...initial, id: "sibling" }
    setQueue([initial, sibling])
    assert.equal(review(sibling)!.reviewed(), false)
    const moved = { ...initial, sessionID: "other-session" }
    setQueue([moved])
    assert.equal(review(moved)!.reviewed(), false)
    review(moved)!.complete()
    setInstance("other-instance")
    assert.equal(review(moved)!.reviewed(), false)
    const removed = review(moved)!
    setQueue([])
    removed.complete()
    assert.equal(removed.reviewed(), false)
    setQueue([moved])
    const disposed = review(moved)!
    dispose()
    disposed.complete()
    assert.equal(disposed.reviewed(), false)
  })
})
