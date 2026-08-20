import assert from "node:assert/strict"
import { it } from "node:test"

import type { ClientSnapshotV1, RestorableWorkspaceTabState } from "./client-state-codec.ts"
import { canCommitClientSnapshotV2, canonicalJson, decodeClientSnapshotV2, encodeClientSnapshotV2, sha256 } from "./client-state-partitions.ts"

const attachment = (id: string) => ({
  id,
  type: "text" as const,
  display: `@${id}`,
  url: "",
  filename: `${id}.txt`,
  mediaType: "text/plain",
  source: { type: "text" as const, value: id },
})
const workspace = (occurrence: number, draft: string): RestorableWorkspaceTabState => ({
  kind: "workspace",
  folder: "/same-folder",
  occurrence,
  projectName: "same-project",
  activeParentSessionId: "parent",
  activeSessionId: "session-1",
  expandedSessionIds: ["parent", "session-1"],
  drafts: {
    "session-1": draft,
    ...(occurrence === 1 ? { __no_session_draft__: "new session prompt" } : {}),
  },
  attachments: { "session-1": [attachment(`attachment-${occurrence}`)] },
  scrollSnapshots: {
    "session-1": { scrollTop: occurrence * 100, atBottom: occurrence === 0, updatedAt: occurrence + 10 },
  },
  unseenIdleSince: { "session-1": occurrence + 20 },
  generationRecovery: { "session-1": occurrence === 0 ? "working" : "interrupted" },
})
const graphSnapshot = (): ClientSnapshotV1 => ({
  version: 1,
  revision: 1,
  savedAt: 2,
  layout: { panel: "320" },
  session: { tabs: [workspace(0, "first draft"), workspace(1, "second draft")], activeTabIndex: 0 },
})
const sidecarSnapshot: ClientSnapshotV1 = {
  version: 1,
  revision: 1,
  savedAt: 2,
  layout: { panel: "320" },
  session: { tabs: [{ kind: "sidecar", sidecarId: "docs" }], activeTabIndex: 0 },
}
const loader = (encoded: Awaited<ReturnType<typeof encodeClientSnapshotV2>>) =>
  async (key: string) => encoded.partitions[key] ?? null

it("canonicalizes recursively without reordering arrays and hashes the exact UTF-8 text", async () => {
  const value = { z: [{ y: 2, x: 1 }, "first"], a: { d: 4, c: 3 } }
  const reordered = { a: { c: 3, d: 4 }, z: [{ x: 1, y: 2 }, "first"] }
  const canonical = '{"a":{"c":3,"d":4},"z":[{"x":1,"y":2},"first"]}'

  assert.equal(canonicalJson(value), canonical)
  assert.equal(canonicalJson(reordered), canonical)
  assert.notEqual(canonicalJson({ values: [1, 2] }), canonicalJson({ values: [2, 1] }))
  assert.equal(await sha256(canonical), "23ed87995559a7cb383a758e7e2728ae0da9d8796565f005b92a4a7b2ba67d00")
})

it("round trips the complete graph without matching duplicate workspaces or session IDs", async () => {
  const snapshot = graphSnapshot()
  const encoded = await encodeClientSnapshotV2(snapshot)
  const manifest = JSON.parse(encoded.partitions[encoded.root.sessionPartition]!)
  const firstShell = manifest.session.tabs[0]
  const secondShell = manifest.session.tabs[1]

  assert.notEqual(firstShell.workspacePartition, secondShell.workspacePartition)
  assert.equal(firstShell.folder, secondShell.folder)
  assert.equal(Object.prototype.hasOwnProperty.call(firstShell, "drafts"), false)
  assert.equal(Object.prototype.hasOwnProperty.call(secondShell, "drafts"), false)
  assert.equal(
    canonicalJson(await decodeClientSnapshotV2(encoded.root, 1, loader(encoded))),
    canonicalJson(snapshot),
  )
})

it("produces stable deduplicated hashes and complete sorted partition keys", async () => {
  const tab = workspace(0, "same draft")
  const snapshot: ClientSnapshotV1 = {
    ...graphSnapshot(),
    session: { tabs: [tab, structuredClone(tab)], activeTabIndex: 0 },
  }
  const first = await encodeClientSnapshotV2(snapshot)
  const second = await encodeClientSnapshotV2(snapshot)
  const manifest = JSON.parse(first.partitions[first.root.sessionPartition]!)

  assert.deepEqual(first, second)
  assert.equal(manifest.session.tabs.length, 2)
  assert.equal(manifest.session.tabs[0].workspacePartition, manifest.session.tabs[1].workspacePartition)
  assert.deepEqual(first.partitionKeys, [...new Set(first.partitionKeys)].sort())
  assert.deepEqual(first.root.partitionKeys, first.partitionKeys)
  assert.deepEqual(Object.keys(first.partitions), first.partitionKeys)
  assert.ok(first.partitionKeys.includes(first.root.sessionPartition))
})

it("uses the native graph cap without truncating the encoded key list", async () => {
  const encoded = await encodeClientSnapshotV2(sidecarSnapshot)
  assert.equal(canCommitClientSnapshotV2({ ...encoded, partitionKeys: Array(4096).fill("key") }), true)
  assert.equal(canCommitClientSnapshotV2({ ...encoded, partitionKeys: Array(4097).fill("key") }), false)
})

it("rejects a missing or corrupt inactive session document", async () => {
  const encoded = await encodeClientSnapshotV2(graphSnapshot())
  const manifest = JSON.parse(encoded.partitions[encoded.root.sessionPartition]!)
  const inactiveWorkspace = JSON.parse(encoded.partitions[manifest.session.tabs[1].workspacePartition]!)
  const inactiveDocument = inactiveWorkspace.sessions["session-1"]

  for (const failure of ["missing", "corrupt"] as const) {
    const load = async (key: string) => key === inactiveDocument
      ? failure === "missing" ? null : `${encoded.partitions[key]} `
      : encoded.partitions[key] ?? null
    assert.equal(await decodeClientSnapshotV2(encoded.root, 1, load), null, failure)
  }
})

it("rejects missing, reordered, and disconnected root graph keys", async () => {
  const encoded = await encodeClientSnapshotV2(graphSnapshot())
  const removable = encoded.root.partitionKeys.find((key) => key !== encoded.root.sessionPartition)!
  const withoutReachable = encoded.root.partitionKeys.filter((key) => key !== removable)
  const extraContent = canonicalJson({ disconnected: true })
  const extraKey = await sha256(extraContent)
  const withExtra = [...encoded.root.partitionKeys, extraKey].sort()
  const partitions = { ...encoded.partitions, [extraKey]: extraContent }

  assert.equal(await decodeClientSnapshotV2(
    { ...encoded.root, partitionKeys: withoutReachable }, 1, loader(encoded),
  ), null)
  assert.equal(await decodeClientSnapshotV2(
    { ...encoded.root, partitionKeys: [...encoded.root.partitionKeys].reverse() }, 1, loader(encoded),
  ), null)
  assert.equal(await decodeClientSnapshotV2(
    { ...encoded.root, partitionKeys: withExtra }, 1, async (key) => partitions[key] ?? null,
  ), null)
})

it("rejects root and legacy session data changed by normalization", async () => {
  const partition = canonicalJson({
    ...sidecarSnapshot.session,
    tabs: [{ ...sidecarSnapshot.session!.tabs[0], dropped: true }],
  })
  const partitionKey = await sha256(partition)
  const encoded = await encodeClientSnapshotV2(sidecarSnapshot)

  assert.equal(await decodeClientSnapshotV2(
    { ...encoded.root, layout: { ...encoded.root.layout, dropped: 42 } },
    1,
    loader(encoded),
  ), null)
  assert.equal(await decodeClientSnapshotV2(
    { ...encoded.root, sessionPartition: partitionKey },
    1,
    async () => partition,
  ), null)
})

it("rejects unsafe persisted workspace session IDs", async () => {
  for (const unsafe of ["__proto__", "constructor", "prototype", "x".repeat(513)]) {
    for (const field of ["records", "activeParentSessionId", "activeSessionId", "expandedSessionIds"] as const) {
      const tab = workspace(0, "draft")
      if (field === "records") tab.drafts = Object.assign(Object.create(null), { [unsafe]: "draft" })
      else if (field === "expandedSessionIds") tab.expandedSessionIds = [unsafe]
      else tab[field] = unsafe
      const encoded = await encodeClientSnapshotV2({
        ...graphSnapshot(), session: { tabs: [tab], activeTabIndex: 0 },
      })
      assert.equal(await decodeClientSnapshotV2(encoded.root, 1, loader(encoded)), null, `${field}: ${unsafe}`)
    }
  }
})

it("rejects noncanonical graph documents with duplicate record keys", async () => {
  const partition = '{"format":2,"format":2,"session":null}'
  const partitionKey = await sha256(partition)
  const encoded = await encodeClientSnapshotV2({ ...sidecarSnapshot, session: null })

  assert.equal(await decodeClientSnapshotV2(
    { ...encoded.root, sessionPartition: partitionKey },
    1,
    async () => partition,
  ), null)
})
