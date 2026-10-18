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
  statusOptions: [] as Array<{ hideWhitespace?: boolean } | undefined>,
  preferences: () => ({}) as { hideDiffWhitespaceChanges?: boolean },
}
;(globalThis as any).__filesGitFixture = fixture
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "solid-js") return nextResolve("solid-js/dist/solid.js", context)
    const sources: Record<string, string> = {
      "../../../../stores/opencode-client": "export const getRootClient = () => ({ vcs: { status: async () => ({ data: [] }) } })",
      "../../../../stores/instances": "export const instances = () => new Map()",
      "../../../../stores/worktrees": "export const getWorktrees = () => [{ slug: 'root', directory: '/repo' }, { slug: 'other', directory: '/other' }]",
      "../../../../lib/notifications": "export const showToastNotification = () => {}",
      "../../../../stores/preferences": "export const preferences = () => globalThis.__filesGitFixture.preferences()",
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
          async fetchWorktreeGitStatus(_id, _slug, _signal, options) {
            f.statusOptions.push(options);
            await f.statusGate;
            // Like the server, only requested reads carry whitespace flags.
            return options?.hideWhitespace ? f.entries : f.entries.map(({ unstagedWhitespaceOnly, ...entry }) => entry);
          },
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
const { createRoot, createEffect, createSignal } = await import("solid-js")
const [hideWhitespace, setHideWhitespace] = createSignal<boolean | undefined>(undefined)
fixture.preferences = () => ({ hideDiffWhitespaceChanges: hideWhitespace() })
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
async function setup(entries = [entry("a.ts"), entry("b.ts"), entry("c.ts")], worktreeSlug = () => "root") {
  fixture.entries = entries
  fixture.requests = []
  fixture.mutationGate = null
  fixture.statusGate = null
  fixture.statusOptions = []
  let dispose!: () => void
  const git = createRoot(cleanup => {
    dispose = cleanup
    return useGitChanges({
      instanceId: "test", isActive: () => true, t: key => key, rightPanelTab: () => "git-changes",
      worktreeSlug, isPhoneLayout: () => false, promptInputApi: () => null,
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
  const select = (id: string) => git.handleGitRowClick(item(id), { preventDefault() {} } as MouseEvent)
  const eye = (id: string) => {
    const preview = item(id)
    openFilePreview("test", { sessionId: "session", slug: "root", directory: "/repo",
      path: preview.path, scope: preview.section, originalPath: preview.originalPath })
  }
  return { git, item, click, select, eye, close() { dispose(); closeFilePreview("test") } }
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
    { kind: "workspace" }, { commit: "abcdef" }, { slug: "other" }, { directory: "/other" },
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

test("an eye-opened diff reconciles independently of the selected row, including later selection clicks", async () => {
  const h = await setup()
  try {
    h.select("unstaged:a.ts")
    h.eye("unstaged:b.ts")
    assert.equal(h.git.gitSelectedItemId(), "unstaged:a.ts")
    const gate = deferred()
    fixture.mutationGate = gate.promise
    h.git.stageGitFile(h.item("unstaged:b.ts"))
    h.select("unstaged:c.ts")
    gate.resolve()
    await until(() => getFilePreview("test")?.scope === "staged")
    assert.equal(h.git.gitSelectedItemId(), "unstaged:c.ts")
    assert.equal(getFilePreview("test")?.path, "b.ts")
    fixture.mutationGate = null
    h.git.unstageGitFile(h.item("staged:b.ts"))
    await until(() => getFilePreview("test")?.scope === "unstaged")
    assert.deepEqual(fixture.requests.map(request => request.paths), [["b.ts"], ["b.ts"]])
    fixture.entries = [entry("a.ts"), entry("c.ts")]
    await h.git.refreshGitStatus()
    assert.equal(getFilePreview("test"), null)
    assert.equal(h.git.gitSelectedItemId(), "unstaged:c.ts")
  } finally { h.close() }
})

test("whitespace-only worktree changes stay out of the list, counts and bulk staging until the option is off", async () => {
  const whitespace = (path: string, staged = false): WorktreeGitStatusEntry => ({
    ...entry(path), stagedStatus: staged ? "modified" : null, unstagedWhitespaceOnly: true,
  })
  setHideWhitespace(undefined)
  // b.ts sorts between the two real changes, so a range selection spans it.
  const h = await setup([entry("a.ts"), whitespace("b.ts"), entry("c.ts"), whitespace("s.ts", true)])
  try {
    const ids = () => buildGitChangeListItems(h.git.gitStatusEntries()).map(item => item.id)
    assert.deepEqual(fixture.statusOptions, [{ hideWhitespace: true }], "the option defaults on and is part of the read")
    assert.deepEqual(ids(), ["staged:s.ts", "unstaged:a.ts", "unstaged:c.ts"],
      "staged rows are never filtered out")
    assert.equal(h.git.gitStatusEntries()?.length, 3, "the file count excludes hidden files")
    h.click("unstaged:a.ts")
    h.click("unstaged:c.ts", { shiftKey: true })
    h.git.stageGitFile(h.item("unstaged:c.ts"))
    await until(() => fixture.requests.length === 1)
    assert.deepEqual(fixture.requests[0].paths, ["a.ts", "c.ts"], "a range selection never stages hidden files")

    setHideWhitespace(false)
    await until(() => fixture.statusOptions.length === 3)
    assert.deepEqual(fixture.statusOptions.at(-1), { hideWhitespace: false })
    await until(() => ids().includes("unstaged:b.ts") && ids().includes("unstaged:s.ts"))
    setHideWhitespace(true)
    await until(() => !ids().includes("unstaged:b.ts"))
    assert.deepEqual(fixture.statusOptions.at(-1), { hideWhitespace: true })
  } finally { h.close(); setHideWhitespace(undefined) }
})

test("a status read made under the other whitespace option never replaces the list", async () => {
  setHideWhitespace(true)
  const h = await setup([entry("a.ts"), { ...entry("b.ts"), unstagedWhitespaceOnly: true }])
  try {
    const gate = deferred()
    fixture.statusGate = gate.promise
    const pending = h.git.refreshGitStatus()
    setHideWhitespace(false)
    gate.resolve()
    await pending
    fixture.statusGate = null
    await until(() => !h.git.gitStatusLoading() && h.git.gitStatusEntries()?.length === 2)
    assert.deepEqual(fixture.statusOptions.at(-1), { hideWhitespace: false })
  } finally { h.close(); setHideWhitespace(undefined) }
})

test("an identical refresh publishes nothing; a change keeps every unchanged row object", async () => {
  const h = await setup()
  let stop!: () => void
  try {
    let runs = 0
    createRoot(dispose => {
      stop = dispose
      createEffect(() => { h.git.gitStatusEntries(); h.git.gitListItems(); h.git.gitChangeWindow("unstaged"); runs++ })
    })
    const entries = h.git.gitStatusEntries(), items = h.git.gitListItems()
    await h.git.refreshGitStatus()
    const reads = fixture.statusOptions.length
    invalidateFilesystemCaches("test")
    await until(() => fixture.statusOptions.length > reads && !h.git.gitStatusLoading())
    assert.equal(runs, 1, "neither explicit nor passive identical refreshes recompute the list")
    assert.equal(h.git.gitStatusEntries(), entries)
    assert.equal(h.git.gitListItems(), items)
    fixture.entries = [entry("a.ts"), { ...entry("b.ts"), unstagedAdditions: 5 }, entry("c.ts")]
    await h.git.refreshGitStatus()
    const next = h.git.gitListItems()
    assert.deepEqual(next.map(item => items.includes(item)), [true, false, true])
    assert.equal(next[1].additions, 5)
  } finally { stop?.(); h.close() }
})

test("sections render a bounded window that keeps previewed rows, survives refreshes and resets with the worktree", async () => {
  const [slug, setSlug] = createSignal("root")
  const path = (index: number) => `f${String(index).padStart(3, "0")}.ts`
  const h = await setup(Array.from({ length: 450 }, (_, index) => entry(path(index))), slug)
  const unstaged = () => h.git.gitChangeWindow("unstaged")
  try {
    assert.equal(unstaged().total, 450)
    assert.equal(unstaged().rows.length, 200)
    assert.equal(h.git.gitSelectedItemId(), "unstaged:f000.ts", "the auto-selected row lies inside the window")
    h.eye("unstaged:f300.ts")
    assert.deepEqual(unstaged().rows.slice(200).map(item => item.path), [path(300)], "a preview beyond the bound still renders")
    // The reveal adds 200 rows besides the already rendered previewed one.
    h.git.revealGitChanges("unstaged")
    assert.equal(unstaged().rows.length, 401)
    assert.deepEqual(unstaged().rows.slice(299, 302).map(item => item.path), [path(299), path(300), path(301)])
    await h.git.refreshGitStatus()
    assert.equal(unstaged().rows.length, 401, "reveals survive refreshes")

    setSlug("other")
    await until(() => !h.git.gitStatusLoading() && h.git.gitStatusEntries() !== null)
    setSlug("root")
    await until(() => !h.git.gitStatusLoading() && h.git.gitSelectedItemId() === "unstaged:f000.ts")
    assert.deepEqual(unstaged().rows.slice(199).map(item => item.path), [path(199), path(300)], "a worktree change resets the reveal")

    // Ranges follow the rendered rows: f150…f199 and the previewed f300, never f200…f299.
    h.select(`unstaged:${path(150)}`)
    h.git.handleGitRowClick(h.item(`unstaged:${path(300)}`), { preventDefault() {}, shiftKey: true } as MouseEvent)
    assert.equal(h.git.gitBulkSelectedItemIds().size, 51)
    h.git.stageGitFile(h.item(`unstaged:${path(300)}`))
    await until(() => fixture.requests.length === 1)
    assert.deepEqual(fixture.requests[0].paths, [...Array.from({ length: 50 }, (_, index) => path(150 + index)), path(300)])
  } finally { h.close() }
})

test("staged rows are never filtered out: beyond the bound they stay counted, revealable and held while focused", async () => {
  setHideWhitespace(true)
  const path = (index: number) => `s${String(index).padStart(3, "0")}.ts`
  // Staged files whose worktree side is whitespace-only: the option hides only that side.
  const h = await setup(Array.from({ length: 250 }, (_, index) => ({ ...entry(path(index), true), unstagedStatus: "modified", unstagedWhitespaceOnly: true })))
  const staged = () => h.git.gitChangeWindow("staged")
  try {
    assert.equal(h.git.gitChangeWindow("unstaged").total, 0)
    assert.deepEqual([staged().total, staged().rows.length, staged().hidden], [250, 200, 50], "counted beyond the bound")
    h.git.holdGitItemFocus(`staged:${path(240)}`, true)
    assert.equal(staged().rows.at(-1)?.path, path(240), "a focused row beyond the bound stays rendered")
    h.git.holdGitItemFocus(`staged:${path(10)}`, false)
    assert.equal(staged().rows.length, 201, "releasing another row keeps the hold")
    h.git.holdGitItemFocus(`staged:${path(240)}`, false)
    assert.equal(staged().rows.length, 200)
    h.git.revealGitChanges("staged")
    assert.deepEqual([staged().rows.length, staged().hidden], [250, 0], "and revealable")
  } finally { h.close(); setHideWhitespace(undefined) }
})

test("passive refresh and commits reconcile an eye-opened file without selecting it", async () => {
  const h = await setup()
  try {
    h.select("unstaged:a.ts")
    h.eye("unstaged:b.ts")
    fixture.entries = [entry("a.ts"), entry("b.ts", true)]
    invalidateFilesystemCaches("test")
    await until(() => getFilePreview("test")?.scope === "staged")
    assert.equal(h.git.gitSelectedItemId(), "unstaged:a.ts")
    h.git.setGitCommitMessage("Commit B")
    await h.git.submitGitCommit()
    assert.equal(getFilePreview("test"), null)
    assert.equal(h.git.gitSelectedItemId(), "unstaged:a.ts")
  } finally { h.close() }
})
