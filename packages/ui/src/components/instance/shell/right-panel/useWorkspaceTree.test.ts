import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { after, test } from "node:test"
import type { FileSystemEntry } from "../../../../../../server/src/api-types"

const fixture = { listings: new Map<string, FileSystemEntry[]>(), reads: [] as string[], gates: new Map<string, Promise<void>>() }
;(globalThis as any).__workspaceTreeFixture = fixture
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "solid-js") return nextResolve("solid-js/dist/solid.js", context)
    if (context.parentURL?.endsWith("/useWorkspaceTree.ts") && specifier === "../../../../lib/api-client") {
      const source = `const f = globalThis.__workspaceTreeFixture;
        export const serverApi = { listWorkspaceFiles: async (_id, path, directory) => {
          const key = directory + ':' + path; f.reads.push(key);
          const entries = f.listings.get(key) ?? []; await f.gates.get(key); return entries;
        } };`
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` }
    }
    return nextResolve(specifier, context)
  },
})

after(() => { hooks.deregister(); delete (globalThis as any).__workspaceTreeFixture })
const { createRoot, createSignal } = await import("solid-js")
const { useWorkspaceTree } = await import("./useWorkspaceTree")
const { invalidateFilesystemCaches, queueFilesystemInvalidation } = await import("../../../../lib/filesystem-events")
const file = (path: string, type: "file" | "directory" = "file", directoryIdentity?: string): FileSystemEntry => ({ path, name: path.split("/").pop()!, type,
  ...(directoryIdentity ? { directoryIdentity } : {}) })
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(predicate(), "tree settled before timeout")
}

for (const transition of ["worktree", "inactive"] as const) {
  test(`a fresh root cannot hide an expanded descendant cancelled by a ${transition} transition`, async () => {
    fixture.reads = []; fixture.gates.clear()
    fixture.listings = new Map([
      ["/a:.", [file("src", "directory"), file("collapsed", "directory")]],
      ["/a:src", [file("src/old.ts")]], ["/b:.", [file("b.txt")]],
    ])
    let release!: () => void, close!: () => void
    const h = createRoot(dispose => {
      close = dispose
      const [directory, move] = createSignal("/a"), [active, activate] = createSignal(true)
      return { tree: useWorkspaceTree(`partial-${transition}`, directory, active), move, activate }
    })
    try {
      await until(() => h.tree.rows().some(row => row.path === "src"))
      h.tree.toggle("src")
      await until(() => h.tree.rows().some(row => row.path === "src/old.ts") && !h.tree.busy().size)
      fixture.listings.set("/a:src", [file("src/new.ts")])
      fixture.gates.set("/a:src", new Promise<void>(resolve => { release = resolve }))
      invalidateFilesystemCaches(`partial-${transition}`)
      await until(() => fixture.reads.filter(key => key === "/a:src").length === 2 && !h.tree.busy().has("."))
      if (transition === "worktree") {
        h.move("/b")
        await until(() => h.tree.rows().some(row => row.path === "b.txt"))
      } else h.activate(false)
      fixture.gates.clear(); release()
      await new Promise(resolve => setTimeout(resolve, 0))
      if (transition === "worktree") h.move("/a")
      else h.activate(true)
      await until(() => h.tree.rows().some(row => row.path === "src/new.ts") && !h.tree.busy().size)
      assert.ok(!h.tree.rows().some(row => row.path === "src/old.ts"))
      assert.equal(fixture.reads.filter(key => key === "/a:src").length, 3)
      assert.ok(!fixture.reads.some(key => key.endsWith(":collapsed")), "collapsed subtrees stay outside read demand")
    } finally { release?.(); fixture.gates.clear(); close() }
  })
}
test("worktree revisits keep cache-first rows but revalidate snapshots invalidated while browsing elsewhere", async () => {
  fixture.reads = []
  fixture.listings = new Map([
    ["/a:.", [file("old.txt"), file("src", "directory")]],
    ["/a:src", [file("src/old.ts")]], ["/b:.", [file("b.txt")]],
  ])
  let close!: () => void
  const h = createRoot(dispose => {
    close = dispose
    const [directory, move] = createSignal("/a")
    return { tree: useWorkspaceTree("tree-test", directory, () => true), move }
  })
  try {
    await until(() => h.tree.rows().some(row => row.path === "old.txt"))
    h.tree.toggle("src")
    await until(() => h.tree.rows().some(row => row.path === "src/old.ts"))
    h.move("/b")
    await until(() => h.tree.rows().some(row => row.path === "b.txt"))
    h.move("/a")
    await until(() => !h.tree.busy().size)
    assert.equal(fixture.reads.filter(key => key === "/a:.").length, 1, "fresh cache does not rescan")
    h.move("/b")
    fixture.listings.set("/a:.", [file("new.txt"), file("src", "directory")])
    fixture.listings.set("/a:src", [file("src/new.ts")])
    invalidateFilesystemCaches("tree-test")
    await until(() => fixture.reads.filter(key => key === "/b:.").length === 2 && !h.tree.busy().size)
    h.move("/a")
    assert.ok(h.tree.rows().some(row => row.path === "old.txt"), "cached rows display before lazy response")
    await until(() => h.tree.rows().some(row => row.path === "src/new.ts") && !h.tree.busy().size)
    assert.ok(h.tree.rows().some(row => row.path === "new.txt"))
    assert.ok(!h.tree.rows().some(row => row.path.includes("old")))
    assert.equal(fixture.reads.filter(key => key === "/a:.").length, 2)
    assert.equal(fixture.reads.filter(key => key === "/a:src").length, 2)
  } finally { close() }
})

test("a coalesced multi-worktree file batch rereads only changed visible directories", async () => {
  fixture.reads = []; fixture.gates.clear()
  fixture.listings = new Map([
    ["/a:.", [file("src", "directory"), file("other", "directory")]],
    ["/a:src", [file("src/old.ts")]], ["/a:other", [file("other/unchanged.ts")]],
  ])
  let close!: () => void
  const tree = createRoot(dispose => { close = dispose; return useWorkspaceTree("scoped-tree", () => "/a", () => true) })
  try {
    await until(() => tree.rows().some(row => row.path === "src") && !tree.busy().size)
    tree.toggle("src"); tree.toggle("other")
    await until(() => tree.rows().some(row => row.path === "other/unchanged.ts") && !tree.busy().size)
    fixture.listings.set("/a:src", [file("src/new.ts")])
    const before = [...fixture.reads]
    queueFilesystemInvalidation("scoped-tree", [{ directory: "/b", path: "." }, { directory: "/a", path: "src" }])
    await until(() => tree.rows().some(row => row.path === "src/new.ts") && !tree.busy().size)
    assert.deepEqual(fixture.reads.slice(before.length), ["/a:src"], "neither another worktree nor an unchanged sibling/root is scanned")
    tree.refresh()
    await until(() => fixture.reads.length === before.length + 4 && !tree.busy().size)
    assert.ok(tree.rows().some(row => row.path === "other/unchanged.ts"))
  } finally { close(); invalidateFilesystemCaches("scoped-tree") }
})

test("a parent-only observation discards replaced directory snapshots and reloads expanded descendants", async () => {
  fixture.reads = []; fixture.gates.clear()
  fixture.listings = new Map([
    ["/a:.", [file("target", "directory", "inode-1")]],
    ["/a:target", [file("target/old.txt"), file("target/deep", "directory", "deep-1")]],
    ["/a:target/deep", [file("target/deep/old.txt")]],
  ])
  let close!: () => void
  const tree = createRoot(dispose => { close = dispose; return useWorkspaceTree("replaced-tree", () => "/a", () => true) })
  try {
    await until(() => tree.rows().some(row => row.path === "target") && !tree.busy().size)
    tree.toggle("target")
    await until(() => tree.rows().some(row => row.path === "target/deep"))
    tree.toggle("target/deep")
    await until(() => tree.rows().some(row => row.path === "target/deep/old.txt") && !tree.busy().size)
    fixture.listings.set("/a:.", [file("target", "directory", "inode-2")])
    fixture.listings.set("/a:target", [file("target/new.txt"), file("target/deep", "directory", "deep-2")])
    fixture.listings.set("/a:target/deep", [file("target/deep/new.txt")])
    const before = fixture.reads.length
    queueFilesystemInvalidation("replaced-tree", [{ directory: "/a", path: "." }])
    await until(() => tree.rows().some(row => row.path === "target/deep/new.txt") && !tree.busy().size)
    assert.ok(!tree.rows().some(row => row.path.endsWith("old.txt")))
    assert.deepEqual(fixture.reads.slice(before), ["/a:.", "/a:target", "/a:target/deep"])
    assert.ok(tree.state().expanded.has("target/deep"), "expansion is preserved through the replacement")
  } finally { close(); invalidateFilesystemCaches("replaced-tree") }
})

test("unchanged physical directory identities do not turn parent events into subtree scans", async () => {
  fixture.reads = []; fixture.gates.clear()
  fixture.listings = new Map([
    ["/a:.", [file("target", "directory", "same-inode")]],
    ["/a:target", [file("target/unchanged.txt")]],
  ])
  let close!: () => void
  const tree = createRoot(dispose => { close = dispose; return useWorkspaceTree("same-directory", () => "/a", () => true) })
  try {
    await until(() => tree.rows().some(row => row.path === "target") && !tree.busy().size)
    tree.toggle("target")
    await until(() => tree.rows().some(row => row.path === "target/unchanged.txt") && !tree.busy().size)
    fixture.listings.set("/a:.", [{ ...file("target", "directory", "same-inode"), modifiedAt: "2026-10-20T12:00:00Z" }])
    const before = fixture.reads.length
    queueFilesystemInvalidation("same-directory", [{ directory: "/a", path: "." }])
    await until(() => fixture.reads.length > before && !tree.busy().size)
    assert.deepEqual(fixture.reads.slice(before), ["/a:."])
  } finally { close(); invalidateFilesystemCaches("same-directory") }
})

test("an old in-flight listing cannot repopulate a directory after its parent detects replacement", async () => {
  fixture.reads = []; fixture.gates.clear()
  fixture.listings = new Map([["/a:.", [file("target", "directory", "old-inode")]], ["/a:target", [file("target/old.txt")]]])
  let close!: () => void, release!: () => void
  const tree = createRoot(dispose => { close = dispose; return useWorkspaceTree("replacement-flight", () => "/a", () => true) })
  try {
    await until(() => tree.rows().some(row => row.path === "target") && !tree.busy().size)
    tree.toggle("target")
    await until(() => tree.rows().some(row => row.path === "target/old.txt") && !tree.busy().size)
    fixture.gates.set("/a:target", new Promise<void>(resolve => { release = resolve }))
    const oldRead = tree.load("target", true)
    await until(() => fixture.reads.filter(key => key === "/a:target").length === 2)
    fixture.gates.delete("/a:target")
    fixture.listings.set("/a:.", [file("target", "directory", "new-inode")])
    fixture.listings.set("/a:target", [file("target/new.txt")])
    await tree.load(".", true)
    await until(() => tree.rows().some(row => row.path === "target/new.txt") && !tree.busy().size)
    release(); await oldRead
    assert.ok(!tree.rows().some(row => row.path === "target/old.txt"))
    assert.equal(fixture.reads.filter(key => key === "/a:target").length, 3)
  } finally { release?.(); fixture.gates.clear(); close() }
})
