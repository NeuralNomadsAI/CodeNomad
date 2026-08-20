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

async function blobReferenceSnapshot(dataPartitions: string[], blobs: Record<string, string>) {
  const document = canonicalJson({
    format: 2,
    draft: "keep only if the attachment is complete",
    attachments: [{
      id: "blob", type: "file", display: "[Image #1]", url: "", filename: "blob.bin",
      mediaType: "application/octet-stream",
      source: { type: "file", path: "blob.bin", mime: "application/octet-stream", dataPartitions },
    }],
  })
  const documentPartition = await sha256(document)
  const leafKeys = [...new Set([documentPartition, ...Object.keys(blobs)])].sort()
  const workspaceDocument = canonicalJson({
    format: 2,
    activeSessionId: "selected",
    sessions: { selected: { documentPartition, partitionKeys: leafKeys } },
  })
  const workspacePartition = await sha256(workspaceDocument)
  const manifest = canonicalJson({
    format: 2,
    session: { tabs: [{ kind: "workspace", folder: "/work", workspacePartition }], activeTabIndex: 0 },
  })
  const sessionPartition = await sha256(manifest)
  const partitions = { ...blobs, [documentPartition]: document, [workspacePartition]: workspaceDocument,
    [sessionPartition]: manifest }
  const partitionKeys = Object.keys(partitions).sort()
  return {
    root: { version: 2 as const, revision: 1, savedAt: 2, layout: {}, sessionPartition, partitionKeys },
    partitions,
    partitionKeys,
  }
}

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

it("drops only a missing or corrupt inactive session leaf", async () => {
  const snapshot = graphSnapshot()
  const inactive = snapshot.session!.tabs[1] as RestorableWorkspaceTabState
  inactive.drafts.stale = "optional stale draft"
  inactive.attachments.stale = [attachment("stale-attachment")]
  const encoded = await encodeClientSnapshotV2(snapshot)
  const manifest = JSON.parse(encoded.partitions[encoded.root.sessionPartition]!)
  const inactiveWorkspace = JSON.parse(encoded.partitions[manifest.session.tabs[1].workspacePartition]!)
  const inactiveDocument = inactiveWorkspace.sessions.stale.documentPartition

  for (const failure of ["missing", "corrupt"] as const) {
    const load = async (key: string) => key === inactiveDocument
      ? failure === "missing" ? null : `${encoded.partitions[key]} `
      : encoded.partitions[key] ?? null
    const decoded = await decodeClientSnapshotV2(encoded.root, 1, load)
    const tab = decoded?.session?.tabs[1]
    assert.equal(decoded?.session?.tabs.length, 2, failure)
    assert.equal(tab?.kind === "workspace" ? tab.drafts["session-1"] : undefined, "second draft", failure)
    assert.equal(tab?.kind === "workspace" ? tab.drafts.stale : undefined, undefined, failure)
    assert.equal(tab?.kind === "workspace" ? tab.attachments.stale : undefined, undefined, failure)
    assert.equal(tab?.kind === "workspace" ? tab.activeSessionId : undefined, "session-1", failure)
  }
})

it("clears selection and all optional state when the selected leaf is corrupt", async () => {
  const encoded = await encodeClientSnapshotV2(graphSnapshot())
  const manifest = JSON.parse(encoded.partitions[encoded.root.sessionPartition]!)
  const workspaceDocument = JSON.parse(encoded.partitions[manifest.session.tabs[0].workspacePartition]!)
  const selectedDocument = workspaceDocument.sessions["session-1"].documentPartition
  const decoded = await decodeClientSnapshotV2(encoded.root, 1, async (key) =>
    key === selectedDocument ? null : encoded.partitions[key] ?? null)
  const tab = decoded?.session?.tabs[0]

  assert.equal(tab?.kind, "workspace")
  if (tab?.kind !== "workspace") return
  assert.equal(tab.activeSessionId, undefined)
  assert.equal(tab.activeParentSessionId, "parent")
  assert.deepEqual(tab.expandedSessionIds, ["parent"])
  assert.equal(tab.drafts["session-1"], undefined)
  assert.equal(tab.attachments["session-1"], undefined)
  assert.equal(tab.scrollSnapshots["session-1"], undefined)
})

it("chunks and round trips attachments larger than the former 8 MiB commit limit", async () => {
  const data = new Uint8Array(9 * 1024 * 1024 + 17)
  const tab = workspace(0, "Review [Image #1]")
  tab.attachments["session-1"] = [{
    ...attachment("large-image"), type: "file", display: "[Image #1]", filename: "large.bin",
    mediaType: "application/octet-stream",
    source: { type: "file", path: "large.bin", mime: "application/octet-stream",
      data: Buffer.from(data).toString("base64") },
  }]
  const snapshot = { ...graphSnapshot(), session: { tabs: [tab], activeTabIndex: 0 } }
  const encoded = await encodeClientSnapshotV2(snapshot)
  const decoded = await decodeClientSnapshotV2(encoded.root, 1, loader(encoded))
  const restored = decoded?.session?.tabs[0]
  const source = restored?.kind === "workspace" ? restored.attachments["session-1"]?.[0]?.source : undefined

  assert.ok(Object.values(encoded.partitions).every((value) => Buffer.byteLength(value, "utf8") < 1024 * 1024))
  assert.ok(Object.values(encoded.partitions).reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0) > 8 * 1024 * 1024)
  assert.ok(encoded.partitionKeys.length > 4, "attachment was split into content partitions")
  assert.equal(source?.type, "file")
  assert.deepEqual(source?.type === "file" ? Buffer.from(source.data ?? "", "base64") : null, Buffer.from(data))
})

it("rejects duplicate and excessive blob chunk references without loading amplification chunks", async () => {
  const first = canonicalJson({ format: 2, index: 0, data: "YQ==" })
  const firstKey = await sha256(first)
  const duplicate = await blobReferenceSnapshot([firstKey, firstKey], { [firstKey]: first })
  const duplicateDecoded = await decodeClientSnapshotV2(duplicate.root, 1, async (key) => duplicate.partitions[key] ?? null)
  const duplicateTab = duplicateDecoded?.session?.tabs[0]
  assert.equal(duplicateTab?.kind === "workspace" ? duplicateTab.activeSessionId : "missing", undefined)
  assert.deepEqual(duplicateTab?.kind === "workspace" ? { ...duplicateTab.drafts } : null, {})

  const blobs: Record<string, string> = {}
  const keys: string[] = []
  for (let index = 0; index < 257; index += 1) {
    const chunk = canonicalJson({ format: 2, index, data: "" })
    const key = await sha256(chunk)
    blobs[key] = chunk
    keys.push(key)
  }
  const excessive = await blobReferenceSnapshot(keys, blobs)
  const blobKeys = new Set(keys)
  let blobLoads = 0
  const excessiveDecoded = await decodeClientSnapshotV2(excessive.root, 1, async (key) => {
    if (blobKeys.has(key)) blobLoads += 1
    return excessive.partitions[key] ?? null
  })
  const excessiveTab = excessiveDecoded?.session?.tabs[0]
  assert.equal(excessiveTab?.kind === "workspace" ? excessiveTab.activeSessionId : "missing", undefined)
  assert.equal(blobLoads, 0)
})

it("round trips many attachment sessions without count-based truncation", async () => {
  const tab = workspace(0, "draft")
  tab.attachments = Object.fromEntries(Array.from({ length: 40 }, (_, sessionIndex) => [
    `many-${sessionIndex}`,
    Array.from({ length: 12 }, (_, attachmentIndex) => attachment(`item-${sessionIndex}-${attachmentIndex}`)),
  ]))
  const snapshot = { ...graphSnapshot(), session: { tabs: [tab], activeTabIndex: 0 } }
  const encoded = await encodeClientSnapshotV2(snapshot)
  const decoded = await decodeClientSnapshotV2(encoded.root, 1, loader(encoded))
  const restored = decoded?.session?.tabs[0]

  assert.equal(restored?.kind === "workspace" ? Object.keys(restored.attachments).length : 0, 40)
  assert.ok(restored?.kind === "workspace" && Object.values(restored.attachments).every((values) => values.length === 12))
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
