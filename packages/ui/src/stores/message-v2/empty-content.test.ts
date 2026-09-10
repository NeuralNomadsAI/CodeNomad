import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createInstanceMessageStore } from "./instance-store"
import { buildRecordDisplayData } from "./record-display-cache"

describe("authoritative empty content after pruning", () => {
  for (const mode of ["upsert", "hydrate"] as const) {
    it(`${mode} clears a technical-only message while metadata-only updates preserve content`, () => {
      const store = createInstanceMessageStore(`empty-${mode}`)
      const base = { id: "assistant", sessionId: "session", role: "assistant" as const, status: "complete" as const }
      const part = { id: "thought", type: "reasoning" as const, text: "Removed private reasoning" }
      store.upsertMessage({ ...base, parts: [part] })
      const display = buildRecordDisplayData(`empty-${mode}`, store.getMessage(base.id)!)
      const update = (parts?: typeof part[]) => mode === "upsert"
        ? store.upsertMessage({ ...base, parts })
        : store.hydrateMessages(base.sessionId, [{ ...base, parts }])

      update()
      assert.deepEqual(store.getMessage(base.id)?.partIds, [part.id], "metadata does not erase content")
      const revision = store.getMessage(base.id)!.revision
      update([])
      const cleared = store.getMessage(base.id)!
      assert.deepEqual(cleared.partIds, [])
      assert.deepEqual(cleared.parts, {})
      assert(cleared.revision > revision, "invalidates derived rendering")
      const emptyDisplay = buildRecordDisplayData(`empty-${mode}`, cleared)
      assert.notEqual(emptyDisplay, display)
      assert.deepEqual(emptyDisplay.orderedParts, [])

      update()
      update([])
      assert.deepEqual(store.getMessage(base.id)?.partIds, [], "subsequent reconciliation cannot resurrect removed content")
      assert.deepEqual(store.getSessionMessageIds(base.sessionId), [base.id], "preserves the message envelope")
    })
  }
})
