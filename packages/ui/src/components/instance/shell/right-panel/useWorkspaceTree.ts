import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import type { FileSystemEntry } from "../../../../../../server/src/api-types"
import { serverApi } from "../../../../lib/api-client"
import { backgroundReads } from "../../../../lib/background-read-queue"
import { createDebouncedRefresh, filesystemInvalidationVersion } from "../../../../lib/filesystem-events"

interface TreeState {
  directories: Map<string, FileSystemEntry[]>
  expanded: Set<string>
  selected: string | null
}
type TreeRow = FileSystemEntry & { depth: number; parent: string }
export function useWorkspaceTree(instanceId: string, directory: Accessor<string>, active: Accessor<boolean>) {
  const empty = (): TreeState => ({ directories: new Map(), expanded: new Set(["."]), selected: null })
  const cache = new Map<string, { state: TreeState; versions: Map<string, number> }>()
  const [state, setState] = createSignal<TreeState>(empty())
  const [errors, setErrors] = createSignal(new Map<string, string>())
  const [busy, setBusy] = createSignal(new Set<string>())
  const requests = new Map<string, AbortController>()
  let current = directory()
  let dirty = false
  // Filesystem-invalidation version seen by each loaded directory. Reopening a
  // directory serves its cached children unless the filesystem changed since
  // they were read; collapsed subtrees are never re-read on expand.
  let loadedVersions = new Map<string, number>()

  async function load(path: string, force = false) {
    if (!active() || requests.has(path) || (!force && state().directories.has(path))) return
    const scope = directory(), controller = new AbortController()
    const version = filesystemInvalidationVersion(instanceId)
    requests.set(path, controller)
    setBusy(new Set(requests.keys()))
    setErrors(previous => { const next = new Map(previous); next.delete(path); return next })
    try {
      const entries = await backgroundReads.run(controller.signal,
        () => serverApi.listWorkspaceFiles(instanceId, path, scope, controller.signal), "visible")
      if (controller.signal.aborted || directory() !== scope) return
      loadedVersions.set(path, version)
      setState(previous => ({ ...previous, directories: new Map(previous.directories).set(path, entries
        .slice().sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name))) }))
    } catch (error) {
      if (!controller.signal.aborted) setErrors(previous => new Map(previous).set(path, error instanceof Error ? error.message : String(error)))
    } finally {
      if (requests.get(path) === controller) { requests.delete(path); setBusy(new Set(requests.keys())) }
    }
  }
  function cancel() {
    requests.forEach(controller => controller.abort())
    requests.clear()
    setBusy(new Set<string>())
  }
  const directories = createMemo(() => state().directories)
  const expanded = createMemo(() => state().expanded)
  const rows = createMemo<TreeRow[]>((previous = []) => {
    const existing = new Map(previous.map(row => [row.path, row]))
    const result: TreeRow[] = []
    const visit = (path: string, depth: number) => {
      for (const entry of directories().get(path) ?? []) {
        const row = existing.get(entry.path)
        result.push(row && row.name === entry.name && row.type === entry.type && row.depth === depth && row.parent === path
          ? row : { ...entry, depth, parent: path })
        if (entry.type === "directory" && expanded().has(entry.path)) visit(entry.path, depth + 1)
      }
    }
    visit(".", 1)
    return result
  })
  function toggle(path: string) {
    const opening = !state().expanded.has(path)
    setState(previous => {
      const expanded = new Set(previous.expanded)
      if (opening) expanded.add(path); else expanded.delete(path)
      return { ...previous, expanded }
    })
    if (!opening) return
    // Cache-first expand: reuse loaded children unless the filesystem changed
    // since they were read. Only the reopened visible subtree revalidates.
    if (loadedVersions.get(path) !== filesystemInvalidationVersion(instanceId)) {
      void load(path, true)
      for (const row of rows()) {
        if (row.type === "directory" && row.path.startsWith(`${path}/`) && state().expanded.has(row.path)) {
          void load(row.path, true)
        }
      }
    } else void load(path)
  }
  function refresh() {
    if (!active()) { dirty = true; return }
    if (requests.size) { dirty = true; return }
    dirty = false
    void load(".", true)
    for (const row of rows()) if (row.type === "directory" && state().expanded.has(row.path)) void load(row.path, true)
  }
  const debounced = createDebouncedRefresh(refresh)
  createEffect(on(busy, value => { if (!value.size && dirty && active()) debounced.trigger() }))
  createEffect(on(directory, value => {
    cancel()
    debounced.cancel()
    cache.set(current, { state: state(), versions: loadedVersions })
    if (cache.size > 8) cache.delete(cache.keys().next().value!)
    current = value
    const cached = cache.get(value)
    loadedVersions = cached?.versions ?? new Map()
    setState(cached?.state ?? empty())
    setErrors(new Map())
    dirty = loadedVersions.get(".") !== filesystemInvalidationVersion(instanceId)
  }))
  createEffect(on(() => active() ? directory() : null, value => {
    if (value === null) { cancel(); return }
    // Cache-first: a visited directory keeps its rows. Pending invalidations
    // revalidate through the debounced refresh below.
    if (!state().directories.has(".")) void load(".", true)
    else if (dirty) refresh()
  }))
  createEffect(on(() => filesystemInvalidationVersion(instanceId), () => {
    dirty = true
    if (active()) debounced.trigger()
  }, { defer: true }))
  onCleanup(() => { cancel(); debounced.cancel() })
  return { rows, state, busy, errors, toggle, refresh, load,
    select: (path: string) => setState(previous => ({ ...previous, selected: path })) }
}
