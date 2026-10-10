import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Session } from "../types/session.ts"
import { getPersistedGenerationRecovery, mergeFetchedSessionRuntimeState, reconcileFetchedSessionRuntime, resolveAuthoritativeGenerationRecovery, resolveHydratedGenerationRecovery } from "./session-generation-recovery.ts"
const session = (state: Partial<Session> = {}): Session => ({
  id: "session", instanceId: "instance", parentId: null, title: "Session", agent: "build",
  model: { providerId: "provider", modelId: "model" },
  time: { created: 1, updated: 1 }, status: "idle", ...state,
} as Session)
const runtime = (value: Session) => ({
  title: value.title, status: value.status, runtimeStatusKnown: value.runtimeStatusKnown,
  generationRecovery: value.generationRecovery, token: value.generationAdmissionToken, source: value.version, updated: value.time.updated,
})
describe("session generation recovery", () => {
  it("resolves hydrated, authoritative, and persisted recovery states", () => {
    const cases: Array<[string, () => unknown, unknown]> = [
      ["working reconnect", () => resolveHydratedGenerationRecovery("working", "working", true), null],
      ["compacting reconnect", () => resolveHydratedGenerationRecovery("working", "compacting", true), null],
      ["idle before authority", () => resolveHydratedGenerationRecovery("working", "idle", false), "pending"],
      ["idle authority without outcome remains unknown", () => resolveHydratedGenerationRecovery("working", "idle", true), "pending"],
      ["idle event is not an interruption", () => resolveAuthoritativeGenerationRecovery("pending", "idle"), "pending"],
      ["legacy interruption requires native proof", () => resolveHydratedGenerationRecovery("interrupted", "idle", false), "pending"],
      ["normal completion while absent", () => resolveHydratedGenerationRecovery("working", "idle", true, "succeeded"), null],
      ["failure is not interruption", () => resolveHydratedGenerationRecovery("working", "idle", true, "failed"), null],
      ["native interruption survives hydration", () => resolveHydratedGenerationRecovery("working", "idle", true, "interrupted"), "interrupted"],
      ["old inferred interruption corrected", () => resolveHydratedGenerationRecovery("interrupted", "idle", true, "succeeded"), null],
      ["outcome without activity authority is inconclusive", () => resolveHydratedGenerationRecovery("working", "idle", false, "succeeded"), "pending"],
      ["active overrides old interruption", () => resolveHydratedGenerationRecovery("working", "working", true, "interrupted"), null],
      ["interruption persists", () => getPersistedGenerationRecovery("idle", "interrupted"), "interrupted"],
      ["working clears pending", () => resolveAuthoritativeGenerationRecovery("pending", "working"), null],
      ["working clears interruption", () => resolveAuthoritativeGenerationRecovery("interrupted", "working"), null],
      ["working persists", () => getPersistedGenerationRecovery("working", null), "working"],
      ["compacting persists", () => getPersistedGenerationRecovery("compacting", null), "working"],
      ["pending persists as work", () => getPersistedGenerationRecovery("idle", "pending"), "working"],
      ["ordinary idle omitted", () => getPersistedGenerationRecovery("idle", null), null],
    ]
    for (const [label, actual, expected] of cases) assert.equal(actual(), expected, label)
  })
  for (const outcome of ["succeeded", "failed", "interrupted", undefined] as const) {
    it(`reconciles idle with native outcome ${outcome ?? "unknown"}`, () => {
      const baseline = session({ generationRecovery: "pending", runtimeStatusKnown: false })
      const result = reconcileFetchedSessionRuntime(session({ outcome }), baseline, {})
      assert.equal(result.status, "idle")
      assert.equal(result.runtimeStatusKnown, true)
      assert.equal(result.outcome, outcome)
      assert.equal(result.generationRecovery, outcome === "interrupted" ? "interrupted" : outcome === undefined ? "pending" : null)
    })
    it(`active authority clears historical ${outcome ?? "unknown"} outcome`, () => {
      const result = reconcileFetchedSessionRuntime(session({ outcome }), session({ generationRecovery: "interrupted" }), { session: {} })
      assert.equal(result.status, "working")
      assert.equal(result.outcome, undefined)
      assert.equal(result.generationRecovery, null)
    })
  }
  it("retains fetched outcome until the non-blocking activity read arrives", () => {
    const baseline = session({ status: "working", generationRecovery: "pending" })
    const partial = reconcileFetchedSessionRuntime(session({ outcome: "succeeded" }), baseline, null)
    assert.equal(partial.outcome, "succeeded")
    assert.equal(partial.generationRecovery, "pending")
    const settled = reconcileFetchedSessionRuntime(partial, baseline, {})
    assert.equal(settled.generationRecovery, null)
  })
  it("does not graft a stale outcome onto a newer idle event", () => {
    const baseline = session({ generationRecovery: "pending", runtimeStatusKnown: false })
    const latest = session({ runtimeStatusKnown: true, generationRecovery: null })
    const fetched = session({ outcome: "interrupted", runtimeStatusKnown: true, generationRecovery: "interrupted" })
    const merged = mergeFetchedSessionRuntimeState(fetched, baseline, latest)
    assert.equal(merged?.generationRecovery, null)
    assert.equal(merged?.outcome, undefined)
  })
  it("fences an idle outcome fetched during a new admission, including its completion", () => {
    const baseline = session({ generationRecovery: "pending", runtimeStatusKnown: false, generationAdmissionToken: 1 })
    const fetched = session({ outcome: "succeeded", runtimeStatusKnown: true, generationRecovery: null })
    assert.equal(mergeFetchedSessionRuntimeState(fetched, baseline, baseline)?.generationRecovery, "pending")
    const completed = session({ generationRecovery: "pending", runtimeStatusKnown: false })
    const merged = mergeFetchedSessionRuntimeState(fetched, baseline, completed)
    assert.equal(merged?.generationRecovery, "pending")
    assert.equal(merged?.outcome, undefined)
    assert.equal(merged?.runtimeStatusKnown, false)
  })
  const mergeCases = [
    ["newer SSE state supersedes a stale fetch", {
      captured: session({ title: "Captured", runtimeStatusKnown: false }),
      fetched: session({ title: "Stale fetch", version: "fetch", time: { created: 1, updated: 2 }, runtimeStatusKnown: true, generationRecovery: "interrupted" }),
      latest: session({ title: "New SSE title", version: "sse", time: { created: 1, updated: 3 }, status: "working", runtimeStatusKnown: true, generationRecovery: null }),
      expected: { title: "New SSE title", status: "working", runtimeStatusKnown: true, generationRecovery: null, token: undefined, source: "sse", updated: 3 },
    }],
    ["in-flight admission survives a fetch snapshot", {
      captured: session({ runtimeStatusKnown: false, generationRecovery: "pending", generationAdmissionToken: 1 }),
      fetched: session({ runtimeStatusKnown: true, generationRecovery: "interrupted" }),
      latest: null,
      expected: { title: "Session", status: "idle", runtimeStatusKnown: false, generationRecovery: "pending", token: 1, source: undefined, updated: 1 },
    }],
    ["active fetch wins after a captured admission completes", {
      captured: session({ title: "Captured", runtimeStatusKnown: true, generationRecovery: "interrupted" }),
      fetched: session({ title: "Fetched", status: "working", runtimeStatusKnown: true, generationRecovery: null }),
      latest: session({ title: "New SSE title", version: "sse", time: { created: 1, updated: 3 }, runtimeStatusKnown: false, generationRecovery: "pending" }),
      expected: { title: "New SSE title", status: "working", runtimeStatusKnown: true, generationRecovery: null, token: undefined, source: "sse", updated: 3 },
    }],
    ["active authority clears a captured admission token", {
      captured: session({ runtimeStatusKnown: false, generationRecovery: "pending", generationAdmissionToken: 1 }),
      fetched: session({ status: "working", runtimeStatusKnown: true, generationRecovery: null }),
      latest: session({ runtimeStatusKnown: false, generationRecovery: "pending", generationAdmissionToken: undefined }),
      expected: { title: "Session", status: "working", runtimeStatusKnown: true, generationRecovery: null, token: undefined, source: undefined, updated: 1 },
    }],
    ["newer local state preserves optional field deletion", {
      captured: session({ retry: { attempt: 1, message: "retrying", next: 10 } }),
      fetched: session({ retry: { attempt: 2, message: "stale", next: 20 } }),
      latest: session(),
      expected: { title: "Session", status: "idle", runtimeStatusKnown: undefined, generationRecovery: undefined, token: undefined, source: undefined, updated: 1 },
    }],
  ] as const
  for (const [label, test] of mergeCases) {
    it(label, () => {
      const merged = mergeFetchedSessionRuntimeState(test.fetched, test.captured, test.latest ?? test.captured)
      assert.ok(merged)
      assert.deepEqual(runtime(merged), test.expected)
    })
  }
  it("does not resurrect a session deleted while its fetch was pending", () => {
    const fetched = session()
    assert.equal(mergeFetchedSessionRuntimeState(fetched, session(), undefined), null)
    assert.equal(mergeFetchedSessionRuntimeState(fetched, undefined, undefined, true), null)
  })
})
