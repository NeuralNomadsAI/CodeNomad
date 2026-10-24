import assert from "node:assert/strict"
import test from "node:test"
import type { OpenCodeClient, SessionInfo } from "@opencode/client"
import { MAX_MISSION_DESCENDANTS, readNativeMissionFamily, readNativeMissionFamilyTree } from "./native-session-family"

const root = { id: "root", projectID: "project", location: { directory: "/owned" } } as SessionInfo
const child = (id: string, parentID = root.id) => ({ ...root, id, parentID })
const native = (list: (parentID: string, cursor?: string) => unknown) => ({ session: { list: async (input: { parentID: string; limit: number; cursor?: string }, options: { signal: AbortSignal }) => {
  assert.equal(input.limit, MAX_MISSION_DESCENDANTS + 1)
  assert.ok(options.signal instanceof AbortSignal)
  return list(input.parentID, input.cursor)
} } }) as unknown as OpenCodeClient

test("native family inventory includes exactly verified ancestry, at most 32 descendants", async () => {
  let reads = 0
  const client = native(parentID => {
    reads++
    return { data: parentID === "root" ? Array.from({ length: 32 }, (_, index) => child(`child-${index}`)) : [], cursor: { next: null } }
  })
  const ids = await readNativeMissionFamily(client, root, new AbortController().signal)
  assert.equal(ids.size, 33)
  assert.equal(reads, 33)
})

test("partial, cyclical, foreign, relocated and oversized ancestry never implies idle", async () => {
  for (const response of [
    { data: [], cursor: { next: "another-page" } },
    { data: [child("wrong-parent", "other")], cursor: { next: null } },
    { data: [child("root")], cursor: { next: null } },
    { data: [child("same"), child("same")], cursor: { next: null } },
    { data: [{ ...child("foreign"), projectID: "foreign" }], cursor: { next: null } },
    { data: [{ ...child("moved"), location: { directory: "/foreign" } }], cursor: { next: null } },
    { data: Array.from({ length: 33 }, (_, index) => child(`child-${index}`)), cursor: { next: null } },
  ]) await assert.rejects(readNativeMissionFamily(native(() => response), root, new AbortController().signal), /Incomplete|inconsistent/)
})

test("cancellation fences the next ancestry read", async () => {
  const controller = new AbortController()
  let reads = 0
  const client = native(() => {
    reads++
    controller.abort()
    return { data: [child("child")], cursor: { next: null } }
  })
  await assert.rejects(readNativeMissionFamily(client, root, controller.signal), { name: "AbortError" })
  assert.equal(reads, 1)
})

test("native nonempty-page cursors are followed even for a short last page", async () => {
  const reads: Array<[string, string | undefined]> = []
  const client = native((parentID, cursor) => {
    reads.push([parentID, cursor])
    if (parentID === "root" && !cursor) return { data: [child("child")], cursor: { next: "root-end" } }
    return { data: [], cursor: { next: null } }
  })
  assert.deepEqual([...await readNativeMissionFamily(client, root, new AbortController().signal)], ["root", "child"])
  assert.deepEqual(reads, [["root", undefined], ["root", "root-end"], ["child", undefined]])
})

test("every descendant must retain the full root Location, including workspaceID", async () => {
  for (const rootWorkspace of [undefined, "workspace-owned"]) {
    for (const childWorkspace of [undefined, "workspace-owned", "workspace-foreign"]) {
      if (rootWorkspace === childWorkspace) continue
      const scopedRoot = { ...root, location: { ...root.location, workspaceID: rootWorkspace } } as SessionInfo
      const client = native(parentID => ({ data: parentID === "root" ? [
        { ...child("child"), location: scopedRoot.location },
      ] : parentID === "child" ? [
        { ...child("grandchild", "child"), location: { ...root.location, workspaceID: childWorkspace } },
      ] : [], cursor: { next: null } }))
      await assert.rejects(readNativeMissionFamily(client, scopedRoot, new AbortController().signal), /inconsistent/)
    }
  }
})

test("a deep same-Location family remains readable without claiming admission authority", async () => {
  const scopedRoot = { ...root, location: { ...root.location, workspaceID: "workspace-owned" } } as SessionInfo
  const client = native(parentID => {
    const next = parentID === "root" ? 1 : Number(parentID.slice(6)) + 1
    return { data: next <= MAX_MISSION_DESCENDANTS ? [{ ...child(`child-${next}`, parentID), location: scopedRoot.location }] : [], cursor: { next: null } }
  })
  const ids = await readNativeMissionFamily(client, scopedRoot, new AbortController().signal)
  assert.equal(ids.size, MAX_MISSION_DESCENDANTS + 1)
  assert.ok(ids.has("child-32"))
})

test("multiple parents cannot claim the same descendant even across otherwise valid pages", async () => {
  const client = native(parentID => ({ data: parentID === "root" ? [child("left"), child("right")]
    : parentID === "left" || parentID === "right" ? [child("shared", parentID)] : [], cursor: { next: null } }))
  await assert.rejects(readNativeMissionFamily(client, root, new AbortController().signal), /inconsistent/)
})

test("descendant cycles and repeated cursors are rejected before unbounded traversal", async () => {
  const cyclic = native(parentID => ({ data: [child(parentID === "root" ? "child" : "root", parentID)], cursor: { next: null } }))
  await assert.rejects(readNativeMissionFamily(cyclic, root, new AbortController().signal), /inconsistent/)
  const repeating = native((_parentID, cursor) => ({ data: [child(cursor ? "second" : "first")], cursor: { next: "same-cursor" } }))
  await assert.rejects(readNativeMissionFamily(repeating, root, new AbortController().signal), /Incomplete/)
})

test("cancellation during the final empty page cannot return a complete family", async () => {
  const controller = new AbortController()
  const client = native(() => { controller.abort(); return { data: [], cursor: { next: null } } })
  await assert.rejects(readNativeMissionFamily(client, root, controller.signal), { name: "AbortError" })
})

test("tree and ID views use the same bounded catalog reads and preserve actual native parent identities", async () => {
  const calls: string[] = []
  const client = native(parentID => {
    calls.push(parentID)
    return { data: parentID === "root" ? [child("right"), child("left")]
      : parentID === "left" ? [child("deep", "left")] : [], cursor: { next: null } }
  })
  const family = await readNativeMissionFamilyTree(client, root, new AbortController().signal)
  assert.deepEqual(calls, ["root", "right", "left", "deep"])
  assert.deepEqual([...family.values()].map(value => [value.id, value.parentID]),
    [["root", undefined], ["right", "root"], ["left", "root"], ["deep", "left"]])
  calls.length = 0
  assert.deepEqual([...await readNativeMissionFamily(client, root, new AbortController().signal)], [...family.keys()])
  assert.equal(calls.length, 4)
})

test("caller currentness fences entry, post-read and return without inventing connection proof", async () => {
  let current = false, reads = 0
  const assertCurrent = () => { if (!current) throw new Error("Changed connection") }
  const client = native(() => { reads++; current = false; return { data: [], cursor: { next: null } } })
  await assert.rejects(readNativeMissionFamilyTree(client, root, new AbortController().signal, { assertCurrent }), /Changed connection/)
  assert.equal(reads, 0)
  current = true
  await assert.rejects(readNativeMissionFamilyTree(client, root, new AbortController().signal, { assertCurrent }), /Changed connection/)
  assert.equal(reads, 1)
  let checks = 0
  await assert.rejects(readNativeMissionFamilyTree(native(() => ({ data: [], cursor: { next: null } })), root,
    new AbortController().signal, { assertCurrent: () => { if (++checks === 4) throw new Error("Changed at return") } }), /Changed at return/)
})

test("a caller-owned shared read budget rejects before another native read", async () => {
  let reads = 0, budget = 1
  const client = native(() => { reads++; return { data: [child("child")], cursor: { next: null } } })
  await assert.rejects(readNativeMissionFamilyTree(client, root, new AbortController().signal,
    { consumeRead: () => { if (--budget < 0) throw new Error("Shared budget exhausted") } }), /Shared budget exhausted/)
  assert.equal(reads, 1)
})

test("malformed child IDs and a self-parented root never enter a displayed native tree", async () => {
  for (const id of ["", " ", 42]) {
    await assert.rejects(readNativeMissionFamilyTree(native(() => ({ data: [child(id as string)], cursor: { next: null } })),
      root, new AbortController().signal), /inconsistent/)
  }
  await assert.rejects(readNativeMissionFamilyTree(native(() => ({ data: [], cursor: { next: null } })),
    { ...root, parentID: root.id }, new AbortController().signal), /inconsistent/)
})
