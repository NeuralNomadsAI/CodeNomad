import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { after, test } from "node:test"
import type { FileSystemEntry } from "../../../../../../server/src/api-types"

const fixture = { listings: new Map<string, FileSystemEntry[]>(), reads: [] as string[] }
;(globalThis as any).__workspaceTreeFixture = fixture
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "solid-js") return nextResolve("solid-js/dist/solid.js", context)
    if (context.parentURL?.endsWith("/useWorkspaceTree.ts") && specifier === "../../../../lib/api-client") {
      const source = `const f = globalThis.__workspaceTreeFixture;
        export const serverApi = { listWorkspaceFiles: async (_id, path, directory) => {
          const key = directory + ':' + path; f.reads.push(key); return f.listings.get(key) ?? [];
        } };`
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` }
    }
    return nextResolve(specifier, context)
  },
})
after(() => { hooks.deregister(); delete (globalThis as any).__workspaceTreeFixture })
const { createRoot, createSignal } = await import("solid-js")
const { useWorkspaceTree } = await import("./useWorkspaceTree")
const { invalidateFilesystemCaches } = await import("../../../../lib/filesystem-events")
const file = (path: string, type: "file" | "directory" = "file"): FileSystemEntry => ({ path, name: path.split("/").pop()!, type })
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(predicate(), "tree settled before timeout")
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
