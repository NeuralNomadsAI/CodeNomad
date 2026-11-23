import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import type { ClientSnapshotV1, RestorableWorkspaceTabState } from "./client-state-codec"
import { normalizeRestorableSession } from "./client-state-codec"
import { canonicalJson, canCommitClientSnapshotV2, decodeClientSnapshotV2, encodeClientSnapshotV2 } from "./client-state-partitions"
import { captureSessionCatalog, normalizeSessionCatalog, type PersistedSessionCatalogEntry } from "./session-catalog-persistence"
import { encodeCatalogPartitions } from "./client-state-catalog-partitions"
import type { Session } from "../types/session"

const row = (i: number): PersistedSessionCatalogEntry => ({
  id: `session-${i}`, title: `Conversation ${i} 日本語`, parentId: i % 3 ? `session-${i - 1}` : null,
  projectID: "project", location: { directory: i % 3 ? "/repo/linked" : "/repo" },
  time: { created: 1, updated: i + 1 }, agent: "build", model: { providerId: "provider", modelId: "model" },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})
function snapshot(count = 12000): ClientSnapshotV1 {
  return { version: 1, revision: 1, savedAt: 1, layout: {}, session: { activeTabIndex: 0, tabs: [{
    kind: "workspace", folder: "/repo", activeSessionId: "session-2", activeParentSessionId: "session-0",
    expandedSessionIds: ["session-0", "session-1"], drafts: { "session-2": "unsent" }, attachments: {},
    scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {}, sessionCatalog: Array.from({ length: count }, (_, i) => row(i)),
  }] } }
}

test("catalog capture detects in-place live metadata changes and only rebuilds affected chunks", async () => {
  const owner = {}
  const rows = Array.from({ length: 100 }, (_, i) => ({
    ...row(i), title: "x".repeat(16_000),
  })) as Session[]
  const original = captureSessionCatalog(rows, owner)!
  const first = await encodeCatalogPartitions(original)
  assert.ok(first.chunks.length > 1)
  assert.strictEqual(captureSessionCatalog(rows.slice(), owner), original)
  rows[1]!.model.modelId = "newer"
  const changed = captureSessionCatalog(rows, owner)!
  assert.strictEqual(normalizeSessionCatalog(changed), changed)
  assert.strictEqual(changed[0], original[0])
  assert.equal(original[1]!.model.modelId, "model")
  assert.equal(changed[1]!.model.modelId, "newer")
  const second = await encodeCatalogPartitions(changed, first)
  assert.notEqual(second.chunks[0]!.partition.key, first.chunks[0]!.partition.key)
  assert.strictEqual(second.chunks[1]!.partition, first.chunks[1]!.partition)
})

test("all 12000 roots and descendants survive normalization and chunked persistence independently of draft budgets", async () => {
  const source = snapshot()
  source.session = normalizeRestorableSession(source.session)
  assert.equal((source.session!.tabs[0] as RestorableWorkspaceTabState).sessionCatalog!.length, 12000)
  const encoded = await encodeClientSnapshotV2(source)
  assert.deepEqual(encoded.root.extensions, ["session-catalog-v1"])
  assert(canCommitClientSnapshotV2(encoded))
  assert(Object.values(encoded.partitions).every(text => Buffer.byteLength(text) <= 1024 * 1024))
  const restored = await decodeClientSnapshotV2(encoded.root, 1, async key => encoded.partitions[key] ?? null)
  assert.equal(canonicalJson(restored), canonicalJson(source))
  const chunks = Object.keys(encoded.partitions).filter(key => JSON.parse(encoded.partitions[key]).entries)
  assert(chunks.length > 1)
  ;(source.session!.tabs[0] as RestorableWorkspaceTabState).drafts["session-2"] = "edited draft"
  const edited = await encodeClientSnapshotV2(source)
  assert(chunks.every(key => edited.partitions[key] === encoded.partitions[key]), "draft edits reuse catalog leaves")
})

test("catalog partitions retain exact canonical text, UTF-8 sizes and digests", async () => {
  const encoded = await encodeCatalogPartitions([{
    ...row(1), subpath: "文", time: { created: 1, updated: 2, archived: 3 },
    location: { directory: "/repo/文", workspaceID: "workspace" },
  }])
  const { partition } = encoded.chunks[0]!
  const text = canonicalJson({ format: 1, index: 0, entries: encoded.rows })
  assert.equal(partition.text, text)
  assert.equal(partition.bytes, Buffer.byteLength(text))
  assert.equal(partition.key, createHash("sha256").update(text).digest("hex"))
})

test("a damaged catalog leaf drops only the optional catalog, preserving selection and drafts", async () => {
  const encoded = await encodeClientSnapshotV2(snapshot())
  const key = Object.keys(encoded.partitions).find(key => JSON.parse(encoded.partitions[key]).index === 1)!
  for (const damaged of [null, "corrupt"]) {
    const restored = await decodeClientSnapshotV2(encoded.root, 1, async candidate => candidate === key ? damaged : encoded.partitions[candidate] ?? null)
    const tab = restored?.session?.tabs[0] as RestorableWorkspaceTabState
    assert.equal(tab.activeSessionId, "session-2")
    assert.equal(tab.drafts["session-2"], "unsent")
    assert.equal(tab.sessionCatalog, undefined)
  }
})

test("catalog is display-only and rejects invalid records without affecting legacy snapshots", async () => {
  const normalized = normalizeSessionCatalog([{ ...row(0), messages: ["private body"], pendingPermission: true, status: "working" }])!
  assert.equal(canonicalJson(normalized), canonicalJson([row(0)]))
  assert.equal(normalizeSessionCatalog([row(0), row(0)]), undefined)
  assert.equal(normalizeSessionCatalog([{ ...row(0), id: "__proto__" }]), undefined)
  const legacy = snapshot(0)
  delete (legacy.session!.tabs[0] as RestorableWorkspaceTabState).sessionCatalog
  const encoded = await encodeClientSnapshotV2(legacy)
  assert.equal(encoded.root.extensions, undefined)
  assert.equal(canonicalJson(await decodeClientSnapshotV2(encoded.root, 1, async key => encoded.partitions[key] ?? null)), canonicalJson(legacy))
})
