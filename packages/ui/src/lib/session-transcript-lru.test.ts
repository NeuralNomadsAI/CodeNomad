import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  isSessionTranscriptProtected,
  SessionTranscriptLru,
  selectTranscriptEvictions,
  type TranscriptLruEntry,
  type TranscriptProtectionState,
} from "./session-transcript-lru.ts"

const entry = (instanceId: string, sessionId: string, bytes: number, lastUsed: number): TranscriptLruEntry => ({
  instanceId, sessionId, bytes, lastUsed,
})

describe("session transcript LRU", () => {
  it("selects the least-recently-used bytes globally across workspaces", () => {
    const entries = [entry("a", "new", 5, 3), entry("b", "old", 4, 1), entry("a", "middle", 4, 2)]
    assert.deepEqual(
      selectTranscriptEvictions(entries, 6, () => false).map(({ instanceId, sessionId }) => `${instanceId}/${sessionId}`),
      ["b/old", "a/middle"],
    )
  })

  it("skips every protected state and permits temporary protected overage", () => {
    const states: Record<string, TranscriptProtectionState> = {
       visible: { visible: true }, loading: { loading: true },
      working: { status: "working" }, compacting: { status: "compacting" },
      sending: { liveMessages: true }, streaming: { liveMessages: true }, pendingSend: { liveMessages: true },
      permission: { permissionBlocked: true }, question: { questionBlocked: true },
      generation: { generationPending: true },
    }
    const entries = Object.keys(states).map((sessionId, index) => entry("a", sessionId, 2, index))
    entries.push(entry("b", "inactive", 2, entries.length))
    assert.deepEqual(
      selectTranscriptEvictions(entries, 1, ({ sessionId }) => isSessionTranscriptProtected(states[sessionId] ?? {})).map(({ sessionId }) => sessionId),
      ["inactive"],
    )
  })

  it("touches entries without changing byte accounting", () => {
    const sizes = new Map([["a/old", 6], ["b/new", 6]])
    const evicted: string[] = []
    const lru = new SessionTranscriptLru({
      byteBudget: 12,
      isProtected: () => false,
      evict: (instanceId, sessionId) => evicted.push(`${instanceId}/${sessionId}`),
    })
    lru.account("a", "old", sizes.get("a/old")!)
    lru.account("b", "new", sizes.get("b/new")!)
    lru.touch("a", "old")
    sizes.set("b/third", 6)
    lru.account("b", "third", sizes.get("b/third")!)
    assert.deepEqual(evicted, ["b/new"])
  })
})
