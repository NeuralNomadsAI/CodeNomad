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
  const cache = new Map<string, TreeState>()
  const [state, setState] = createSignal<TreeState>(empty())
  const [errors, setErrors] = createSignal(new Map<string, string>())
  const [busy, setBusy] = createSignal(new Set<string>())
  const requests = new Map<string, AbortController>()
  let current = directory()
  let dirty = false

  async function load(path: string, force = false) {
    if (!active() || requests.has(path) || (!force && state().directories.has(path))) return
    const scope = directory(), controller = new AbortController()
    requests.set(path, controller)
    setBusy(new Set(requests.keys()))
    setErrors(previous => { const next = new Map(previous); next.delete(path); return next })
    try {
      const entries = await backgroundReads.run(controller.signal,
        () => serverApi.listWorkspaceFiles(instanceId, path, scope, controller.signal), "visible")
      if (controller.signal.aborted || directory() !== scope) return
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
    // Cached children display immediately; collapsed directories may have changed
    // while they were outside visible refresh demand.
    if (opening) void load(path, true)
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
    cache.set(current, state())
    if (cache.size > 8) cache.delete(cache.keys().next().value!)
    current = value
    setState(cache.get(value) ?? empty())
    setErrors(new Map())
    dirty = false
  }))
  createEffect(on(() => active() ? directory() : null, value => {
    if (value === null) { cancel(); return }
    refresh()
  }))
  createEffect(on(() => filesystemInvalidationVersion(instanceId), () => {
    dirty = true
    if (active()) debounced.trigger()
  }, { defer: true }))
  onCleanup(() => { cancel(); debounced.cancel() })
  return { rows, state, busy, errors, toggle, refresh, load,
    select: (path: string) => setState(previous => ({ ...previous, selected: path })) }
}
