import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  getPersistedGenerationRecovery,
  mergeFetchedSessionRuntimeState,
  resolveAuthoritativeGenerationRecovery,
  resolveHydratedGenerationRecovery,
} from "./session-generation-recovery.ts"
import type { Session } from "../types/session.ts"

function session(state: Partial<Session>): Session {
  return {
    id: "session",
    instanceId: "instance",
    parentId: null,
    title: "Session",
    agent: "build",
    model: { providerId: "provider", modelId: "model" },
    version: "1",
    time: { created: 1, updated: 1 },
    status: "idle",
    ...state,
  } as Session
}

describe("session generation recovery", () => {
  it("passively reconnects when the runtime is still working", () => {
    assert.equal(resolveHydratedGenerationRecovery("working", "working", true), null)
    assert.equal(resolveHydratedGenerationRecovery("working", "compacting", true), null)
  })

  it("marks prior work interrupted only after authoritative idle", () => {
    assert.equal(resolveHydratedGenerationRecovery("working", "idle", false), "pending")
    assert.equal(resolveHydratedGenerationRecovery("working", "idle", true), "interrupted")
    assert.equal(resolveAuthoritativeGenerationRecovery("pending", "idle"), "interrupted")
  })

  it("keeps an interruption across restarts until new work is admitted", () => {
    assert.equal(resolveHydratedGenerationRecovery("interrupted", "idle", false), "interrupted")
    assert.equal(getPersistedGenerationRecovery("idle", "interrupted"), "interrupted")
  })

  it("clears recovery when authoritative work resumes", () => {
    assert.equal(resolveAuthoritativeGenerationRecovery("pending", "working"), null)
    assert.equal(resolveAuthoritativeGenerationRecovery("interrupted", "working"), null)
  })

  it("persists active and unresolved work without persisting ordinary idle sessions", () => {
    assert.equal(getPersistedGenerationRecovery("working", null), "working")
    assert.equal(getPersistedGenerationRecovery("compacting", null), "working")
    assert.equal(getPersistedGenerationRecovery("idle", "pending"), "working")
    assert.equal(getPersistedGenerationRecovery("idle", null), null)
  })

  it("preserves a newer SSE state over a stale session fetch", () => {
    const captured = session({ title: "Captured", status: "idle", runtimeStatusKnown: false })
    const fetched = session({
      title: "Stale fetch",
      metadata: { source: "fetch" },
      time: { created: 1, updated: 2 },
      status: "idle",
      runtimeStatusKnown: true,
      generationRecovery: "interrupted",
    })
    const latest = session({
      title: "New SSE title",
      metadata: { source: "sse" },
      time: { created: 1, updated: 3 },
      status: "working",
      runtimeStatusKnown: true,
      generationRecovery: null,
    })

    const merged = mergeFetchedSessionRuntimeState(fetched, captured, latest)
    assert.ok(merged)
    assert.equal(merged.status, "working")
    assert.equal(merged.generationRecovery, null)
    assert.equal(merged.title, "New SSE title")
    assert.deepEqual(merged.metadata, { source: "sse" })
    assert.equal(merged.time.updated, 3)
  })

  it("preserves an in-flight admission even when it predates the fetch snapshot", () => {
    const admission = session({
      status: "idle",
      runtimeStatusKnown: false,
      generationRecovery: "pending",
      generationAdmissionToken: 1,
    })
    const fetched = session({ status: "idle", runtimeStatusKnown: true, generationRecovery: "interrupted" })

    const merged = mergeFetchedSessionRuntimeState(fetched, admission, admission)
    assert.ok(merged)
    assert.equal(merged.runtimeStatusKnown, false)
    assert.equal(merged.generationRecovery, "pending")
    assert.equal(merged.generationAdmissionToken, 1)
  })

  it("does not resurrect a session deleted while its fetch was pending", () => {
    const captured = session({ status: "idle" })
    const fetched = session({ status: "idle" })
    assert.equal(mergeFetchedSessionRuntimeState(fetched, captured, undefined), null)
    assert.equal(mergeFetchedSessionRuntimeState(fetched, undefined, undefined, true), null)
  })
})
