import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { after, test } from "node:test"
import type { WorktreeGitStatusEntry } from "../../../../../../server/src/api-types"
import type { FilePreviewTarget } from "../../../../stores/files-preview"

// Native loader hooks isolate transport, while the actual reactive hook, model,
// filesystem invalidations and preview store execute with Solid's client runtime.
const fixture = {
  entries: [] as WorktreeGitStatusEntry[],
  requests: [] as Array<{ action: string; paths: string[] }>,
  mutationGate: null as Promise<void> | null,
  statusGate: null as Promise<void> | null,
}
;(globalThis as any).__filesGitFixture = fixture
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "solid-js") return nextResolve("solid-js/dist/solid.js", context)
    const sources: Record<string, string> = {
      "../../../../stores/opencode-client": "export const getRootClient = () => ({ vcs: { status: async () => ({ data: [] }) } })",
      "../../../../stores/instances": "export const instances = () => new Map()",
      "../../../../stores/worktrees": "export const getWorktrees = () => [{ slug: 'root', directory: '/repo' }]",
      "../../../../lib/notifications": "export const showToastNotification = () => {}",
      "../../../../lib/api-client": `
        const f = globalThis.__filesGitFixture;
        async function mutate(action, paths) {
          f.requests.push({ action, paths });
          await f.mutationGate;
          f.entries = f.entries.flatMap(entry => {
            if (action === 'commit') return entry.unstagedStatus ? [{ ...entry, stagedStatus: null }] : [];
            if (!paths.includes(entry.path)) return [entry];
            return [{ ...entry, stagedStatus: action === 'stage' ? 'modified' : null,
              unstagedStatus: action === 'unstage' ? 'modified' : null }];
          });
        }
        export const serverApi = {
          async fetchWorktreeGitStatus() { await f.statusGate; return f.entries; },
          stageWorktreeGitPaths: (_id, _slug, { paths }) => mutate('stage', paths),
          unstageWorktreeGitPaths: (_id, _slug, { paths }) => mutate('unstage', paths),
          commitWorktreeGitChanges: () => mutate('commit', []),
          fetchWorktreeGitDiff: () => { throw new Error('external diffs belong to the reader'); },
        };
      `,
    }
    if (context.parentURL?.endsWith("/useGitChanges.ts") && sources[specifier]) {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(sources[specifier])}` }
    }
    return nextResolve(specifier, context)
  },
})
after(() => { hooks.deregister(); delete (globalThis as any).__filesGitFixture })
const { createRoot, createEffect } = await import("solid-js")
const { useGitChanges } = await import("./useGitChanges")
const { buildGitChangeListItems } = await import("./git-changes-model")
const { getFilePreview, openFilePreview, closeFilePreview } = await import("../../../../stores/files-preview")
const { invalidateFilesystemCaches } = await import("../../../../lib/filesystem-events")

const entry = (path: string, staged = false): WorktreeGitStatusEntry => ({
  path, originalPath: null, stagedStatus: staged ? "modified" : null, unstagedStatus: staged ? null : "modified",
  stagedAdditions: 1, stagedDeletions: 0, unstagedAdditions: 1, unstagedDeletions: 0,
})
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(predicate(), "hook settled before timeout")
}
async function setup(entries = [entry("a.ts"), entry("b.ts"), entry("c.ts")]) {
  fixture.entries = entries
  fixture.requests = []
  fixture.mutationGate = null
  fixture.statusGate = null
  let dispose!: () => void
  const git = createRoot(cleanup => {
    dispose = cleanup
    return useGitChanges({
      instanceId: "test", isActive: () => true, t: key => key, rightPanelTab: () => "git-changes",
      worktreeSlug: () => "root", isPhoneLayout: () => false, promptInputApi: () => null,
      closeGitList: () => {}, externalDiff: true,
    })
  })
  await until(() => !git.gitStatusLoading() && git.gitStatusEntries() !== null)
  const item = (id: string) => {
    const result = buildGitChangeListItems(git.gitStatusEntries()).find(item => item.id === id)
    assert.ok(result, `missing ${id}`)
    return result
  }
  const click = (id: string, modifiers: Partial<MouseEvent> = {}) => {
    const selected = item(id)
    git.handleGitRowClick(selected, { preventDefault() {}, ...modifiers } as MouseEvent)
    if (!modifiers.ctrlKey && !modifiers.metaKey && !modifiers.shiftKey) {
      openFilePreview("test", { sessionId: "session", slug: "root", directory: "/repo",
        path: selected.path, scope: selected.section, originalPath: selected.originalPath })
    }
  }
  return { git, item, click, close() { dispose(); closeFilePreview("test") } }
}

test("stage and unstage move the central local preview with its sidebar selection", async () => {
  const h = await setup([{ ...entry("a.ts"), originalPath: "old.ts" }])
  try {
    h.click("unstaged:a.ts")
    h.git.stageGitFile(h.item("unstaged:a.ts"))
    await until(() => getFilePreview("test")?.scope === "staged")
    assert.equal(h.git.gitSelectedItemId(), "staged:a.ts")
    assert.equal(getFilePreview("test")?.originalPath, "old.ts")
    assert.equal(getFilePreview("test")?.sessionId, "session")
    h.git.unstageGitFile(h.item("staged:a.ts"))
    await until(() => getFilePreview("test")?.scope === "unstaged")
    assert.equal(h.git.gitSelectedItemId(), "unstaged:a.ts")
  } finally { h.close() }
})

test("commit closes a vanished preview instead of opening another file; partial commits retain the remaining scope", async () => {
  for (const partial of [false, true]) {
    const h = await setup([{ ...entry("a.ts", true), unstagedStatus: partial ? "modified" : null }, entry("b.ts")])
    try {
      h.click("staged:a.ts")
      h.git.setGitCommitMessage("Commit staged changes")
      await h.git.submitGitCommit()
      if (partial) {
        assert.equal(getFilePreview("test")?.scope, "unstaged")
        assert.equal(getFilePreview("test")?.path, "a.ts")
      } else assert.equal(getFilePreview("test"), null)
      assert.equal(h.git.gitCommitMessage(), "")
    } finally { h.close() }
  }
})

test("explicit refresh reloads an unchanged target and reconciles externally moved or removed changes", async () => {
  const h = await setup()
  let stop!: () => void
  try {
    h.click("unstaged:a.ts")
    let readerLoads = 0
    createRoot(dispose => { stop = dispose; createEffect(() => { getFilePreview("test"); readerLoads++ }) })
    await h.git.refreshGitStatus()
    assert.equal(readerLoads, 2, "target identity drives the real reader's load effect")
    fixture.entries = [entry("a.ts", true), entry("b.ts")]
    await h.git.refreshGitStatus()
    assert.equal(getFilePreview("test")?.scope, "staged")
    fixture.entries = [entry("b.ts")]
    await h.git.refreshGitStatus()
    assert.equal(getFilePreview("test"), null)
  } finally { stop?.(); h.close() }
})

test("passive filesystem reconciliation also moves the relevant local preview", async () => {
  const h = await setup()
  try {
    h.click("unstaged:a.ts")
    fixture.entries = [entry("a.ts", true)]
    invalidateFilesystemCaches("test")
    await until(() => getFilePreview("test")?.scope === "staged")
  } finally { h.close() }
})

test("refresh and mutation preserve unrelated previews and fence navigation during pending requests", async () => {
  const others: Partial<FilePreviewTarget>[] = [
    { kind: "workspace" }, { commit: "abcdef" }, { path: "b.ts" }, { slug: "other" }, { directory: "/other" },
  ]
  for (const other of others) {
    const h = await setup()
    try {
      h.click("unstaged:a.ts")
      const unrelated = { ...getFilePreview("test")!, ...other }
      openFilePreview("test", unrelated)
      await h.git.refreshGitStatus()
      assert.equal(getFilePreview("test"), unrelated)
      h.git.stageGitFile(h.item("unstaged:a.ts"))
      await until(() => h.git.gitSelectedItemId() === "staged:a.ts")
      assert.equal(getFilePreview("test"), unrelated)
    } finally { h.close() }
  }
  for (const operation of ["stage", "refresh", "commit"] as const) {
    const h = await setup([entry("a.ts", operation === "commit"), entry("b.ts")])
    try {
      const id = `${operation === "commit" ? "staged" : "unstaged"}:a.ts`
      h.click(id)
      const gate = deferred()
      if (operation === "refresh") fixture.statusGate = gate.promise
      else fixture.mutationGate = gate.promise
      h.git.setGitCommitMessage("commit")
      const pending = operation === "refresh" ? h.git.refreshGitStatus() : operation === "commit"
        ? h.git.submitGitCommit() : h.git.stageGitFile(h.item(id))
      h.click("unstaged:b.ts")
      const newer = getFilePreview("test")
      gate.resolve()
      await pending
      await until(() => !h.git.gitStatusLoading() && !h.git.gitCommitSubmitting())
      assert.equal(getFilePreview("test"), newer)
      assert.equal(h.git.gitSelectedItemId(), "unstaged:b.ts")
    } finally { h.close() }
  }
})

test("per-section Operations targets honor bulk selection excluding the previewed file", async () => {
  const h = await setup([entry("a.ts"), entry("b.ts"), entry("c.ts"), entry("d.ts", true)])
  try {
    h.click("unstaged:a.ts")
    h.click("unstaged:b.ts", { ctrlKey: true })
    h.click("unstaged:c.ts", { metaKey: true })
    h.click("staged:d.ts", { ctrlKey: true })
    const unstaged = h.git.gitActionItems().filter(item => item.section === "unstaged")
    const staged = h.git.gitActionItems().filter(item => item.section === "staged")
    assert.deepEqual(unstaged.map(item => item.path), ["b.ts", "c.ts"])
    assert.deepEqual(staged.map(item => item.path), ["d.ts"])
    h.git.stageGitFile(unstaged[0])
    await until(() => h.git.gitBulkSelectedItemIds().size === 0)
    assert.deepEqual(fixture.requests, [{ action: "stage", paths: ["b.ts", "c.ts"] }])
    assert.equal(getFilePreview("test")?.path, "a.ts")
    assert.equal(getFilePreview("test")?.scope, "unstaged")
    h.click("staged:b.ts", { ctrlKey: true })
    h.click("staged:c.ts", { ctrlKey: true })
    h.git.unstageGitFile(h.git.gitActionItems()[0])
    await until(() => h.git.gitBulkSelectedItemIds().size === 0)
    assert.deepEqual(fixture.requests[1], { action: "unstage", paths: ["b.ts", "c.ts"] })
    assert.deepEqual(h.git.gitActionItems().map(item => item.path), ["a.ts"])
  } finally { h.close() }
})

test("pending mutation cannot replace a newly opened reader even without a sidebar click", async () => {
  for (const destination of [{ kind: "workspace" as const }, { commit: "abcdef" }, { path: "b.ts" }, { sessionId: "another-session" }]) {
    const h = await setup()
    try {
      h.click("unstaged:a.ts")
      const gate = deferred()
      fixture.mutationGate = gate.promise
      h.git.stageGitFile(h.item("unstaged:a.ts"))
      const newer = { ...getFilePreview("test")!, ...destination }
      openFilePreview("test", newer)
      gate.resolve()
      await until(() => h.git.gitSelectedItemId() === "staged:a.ts")
      assert.equal(getFilePreview("test"), newer)
    } finally { h.close() }
  }
})
