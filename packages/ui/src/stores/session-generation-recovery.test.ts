import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Session } from "../types/session.ts"
import { getPersistedGenerationRecovery, mergeFetchedSessionRuntimeState, resolveAuthoritativeGenerationRecovery, resolveHydratedGenerationRecovery } from "./session-generation-recovery.ts"
const session = (state: Partial<Session> = {}): Session => ({
  id: "session", instanceId: "instance", parentId: null, title: "Session", agent: "build",
  model: { providerId: "provider", modelId: "model" }, version: "1",
  time: { created: 1, updated: 1 }, status: "idle", ...state,
} as Session)
const runtime = (value: Session) => ({
  title: value.title, status: value.status, runtimeStatusKnown: value.runtimeStatusKnown,
  generationRecovery: value.generationRecovery, token: value.generationAdmissionToken, source: value.metadata?.source, updated: value.time.updated,
})
describe("session generation recovery", () => {
  it("resolves hydrated, authoritative, and persisted recovery states", () => {
    const cases: Array<[string, () => unknown, unknown]> = [
      ["working reconnect", () => resolveHydratedGenerationRecovery("working", "working", true), null],
      ["compacting reconnect", () => resolveHydratedGenerationRecovery("working", "compacting", true), null],
      ["idle before authority", () => resolveHydratedGenerationRecovery("working", "idle", false), "pending"],
      ["authoritative idle hydration", () => resolveHydratedGenerationRecovery("working", "idle", true), "interrupted"],
      ["authoritative idle event", () => resolveAuthoritativeGenerationRecovery("pending", "idle"), "interrupted"],
      ["interruption survives hydration", () => resolveHydratedGenerationRecovery("interrupted", "idle", false), "interrupted"],
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
  const mergeCases = [
    ["newer SSE state supersedes a stale fetch", {
      captured: session({ title: "Captured", runtimeStatusKnown: false }),
      fetched: session({ title: "Stale fetch", metadata: { source: "fetch" }, time: { created: 1, updated: 2 }, runtimeStatusKnown: true, generationRecovery: "interrupted" }),
      latest: session({ title: "New SSE title", metadata: { source: "sse" }, time: { created: 1, updated: 3 }, status: "working", runtimeStatusKnown: true, generationRecovery: null }),
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
      latest: session({ title: "New SSE title", metadata: { source: "sse" }, time: { created: 1, updated: 3 }, runtimeStatusKnown: false, generationRecovery: "pending" }),
      expected: { title: "New SSE title", status: "working", runtimeStatusKnown: true, generationRecovery: null, token: undefined, source: "sse", updated: 3 },
    }],
    ["active authority clears a captured admission token", {
      captured: session({ runtimeStatusKnown: false, generationRecovery: "pending", generationAdmissionToken: 1 }),
      fetched: session({ status: "working", runtimeStatusKnown: true, generationRecovery: null, generationAdmissionToken: 1 }),
      latest: session({ runtimeStatusKnown: false, generationRecovery: "pending", generationAdmissionToken: undefined }),
      expected: { title: "Session", status: "working", runtimeStatusKnown: true, generationRecovery: null, token: undefined, source: undefined, updated: 1 },
    }],
    ["active fetch overrides an unresolved admission token", {
      captured: session({ runtimeStatusKnown: false, generationRecovery: "pending", generationAdmissionToken: 1 }),
      fetched: session({ status: "working", runtimeStatusKnown: true, generationRecovery: null, generationAdmissionToken: 1 }),
      latest: null,
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
  it("keeps fetched revert authority while preserving an admission token", () => {
    const captured = session({ generationAdmissionToken: 1, revert: { messageID: "stale" } })
    const merged = mergeFetchedSessionRuntimeState(
      session({ revert: { messageID: "authoritative" } }),
      captured,
      captured,
    )
    assert.equal(merged?.generationAdmissionToken, 1)
    assert.equal(merged?.revert?.messageID, "authoritative")
  })
})
