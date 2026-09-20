import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizePersistedOutline, normalizeOutlineIndexes, outlineBudget } from "./session-outline-persistence"
import { canonicalJson, decodeClientSnapshotV2, encodeClientSnapshotV2, canCommitClientSnapshotV2 } from "./client-state-partitions"
import type { ClientSnapshotV1, RestorableWorkspaceTabState } from "./client-state-codec"

function index(count = 20000) {
  return normalizePersistedOutline({ format: 1, directory: "/repo", projectID: "p",
    entries: Array.from({ length: count }, (_, seq) => ({ id: `message-${seq}`, seq, type: "assistant", tools: seq % 2, reasoning: 1 })),
    checkpoints: Array.from({ length: Math.ceil(count / 512) }, (_, chunk) => ({ after: chunk * 512 - 1,
      through: Math.min(count, (chunk + 1) * 512) - 1, digest: "a".repeat(64) })),
  })!
}
function snapshot(): ClientSnapshotV1 {
  return { version: 1, revision: 1, savedAt: 1, layout: {}, session: { activeTabIndex: 0, tabs: [{
    kind: "workspace", folder: "/repo", activeSessionId: "s", drafts: { s: "unsent draft" }, attachments: {},
    scrollSnapshots: { s: { scrollTop: 12, atBottom: false, updatedAt: 1 } }, unseenIdleSince: {}, generationRecovery: {},
    outlineIndexes: { s: index() },
  }] } }
}

test("large indexes round trip through bounded native partitions and reuse their leaves after draft edits", async () => {
  const source = snapshot(), encoded = await encodeClientSnapshotV2(source)
  assert.deepEqual(encoded.root.extensions, ["outline-index-v1"], "older renderers must fence the new graph rather than discard a draft leaf")
  assert(canCommitClientSnapshotV2(encoded))
  assert(Object.values(encoded.partitions).every(value => Buffer.byteLength(value) <= 1024 * 1024))
  const decoded = await decodeClientSnapshotV2(encoded.root, 1, async key => encoded.partitions[key] ?? null)
  assert.equal(canonicalJson(decoded), canonicalJson(source))
  const tab = source.session!.tabs[0] as RestorableWorkspaceTabState
  tab.drafts.s = "changed draft"
  const edited = await encodeClientSnapshotV2(source)
  const indexKeys = Object.entries(encoded.partitions).filter(([, value]) => Array.isArray(JSON.parse(value).entries)).map(([key]) => key)
  assert.equal(indexKeys.length, 40)
  assert(indexKeys.every(key => edited.partitions[key] === encoded.partitions[key]))
})

test("a missing or corrupt optional index chunk preserves the selected session, draft and scroll", async () => {
  const encoded = await encodeClientSnapshotV2(snapshot())
  const key = Object.keys(encoded.partitions).find(key => JSON.parse(encoded.partitions[key]).index === 1)!
  for (const damaged of [null, "corrupt"]) {
    const decoded = await decodeClientSnapshotV2(encoded.root, 1, async candidate => candidate === key ? damaged : encoded.partitions[candidate] ?? null)
    const tab = decoded?.session?.tabs[0] as RestorableWorkspaceTabState
    assert.equal(tab.activeSessionId, "s")
    assert.equal(tab.drafts.s, "unsent draft")
    assert.equal(tab.scrollSnapshots.s.scrollTop, 12)
    assert.equal(tab.outlineIndexes, undefined)
  }
})

test("index normalization bounds optional storage, rejects invalid ordering and never stores excerpts", () => {
  const valid = index(2)
  assert.equal(normalizePersistedOutline(valid), valid, "verified immutable indexes avoid repeated traversal on capture")
  assert.equal(normalizePersistedOutline({ ...valid, entries: [valid.entries[1], valid.entries[0]] }), undefined)
  assert.equal(normalizePersistedOutline({ ...valid, checkpoints: [{ after: 0, through: 1, digest: "a".repeat(64) }] }), undefined)
  const sanitized = normalizePersistedOutline({ ...valid, entries: valid.entries.map(entry => ({ ...entry, preview: "do not persist bodies" })) })!
  assert(!JSON.stringify(sanitized).includes("preview"))
  const indexes = Object.fromEntries(Array.from({ length: 20 }, (_, id) => [`s${id}`, valid]))
  const normalized = normalizeOutlineIndexes(indexes, outlineBudget(), "s19")!
  assert.equal(Object.keys(normalized).length, 16)
  assert(normalized.s19)
  assert.equal(normalizeOutlineIndexes(indexes, { bytes: 1, entries: 200000, indexes: 16 }), undefined)
})
