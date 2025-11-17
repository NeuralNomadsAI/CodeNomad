import { Component, Show, For, createSignal, createMemo, createEffect, onCleanup, onMount } from "solid-js"
import { Folder as FolderIcon, File as FileIcon, Loader2, Search, X } from "lucide-solid"
import type { FileSystemEntry } from "../../../cli/src/api-types"
import { cliApi } from "../lib/api-client"
import { getServerMeta } from "../lib/server-meta"

const MAX_RESULTS = 200

type CacheListener = (entries: FileSystemEntry[]) => void

interface FileSystemCacheState {
  entriesMap: Map<string, FileSystemEntry>
  entriesList: FileSystemEntry[]
  loadedDirectories: Set<string>
  loadingPromises: Map<string, Promise<void>>
  pendingDirectories: string[]
  listeners: Set<CacheListener>
  queueActive: boolean
}

const fileSystemCache: FileSystemCacheState = {
  entriesMap: new Map(),
  entriesList: [],
  loadedDirectories: new Set(),
  loadingPromises: new Map(),
  pendingDirectories: [],
  listeners: new Set(),
  queueActive: false,
}

let cacheWorkspaceRoot: string | null = null

function normalizeEntryPath(path: string): string {
  if (!path || path === ".") {
    return "."
  }
  const cleaned = path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/")
  return cleaned || "."
}

function updateCache(entries: FileSystemEntry[]): boolean {
  let changed = false
  for (const entry of entries) {
    const normalizedPath = normalizeEntryPath(entry.path)
    const normalizedEntry = normalizedPath === entry.path ? entry : { ...entry, path: normalizedPath }
    const existing = fileSystemCache.entriesMap.get(normalizedPath)

    if (
      !existing ||
      existing.name !== normalizedEntry.name ||
      existing.type !== normalizedEntry.type ||
      existing.size !== normalizedEntry.size ||
      existing.modifiedAt !== normalizedEntry.modifiedAt
    ) {
      fileSystemCache.entriesMap.set(normalizedPath, normalizedEntry)
      changed = true
    }
  }

  if (changed) {
    fileSystemCache.entriesList = Array.from(fileSystemCache.entriesMap.values()).sort((a, b) =>
      a.path.localeCompare(b.path),
    )
  }

  return changed
}

function notifyCacheListeners() {
  for (const listener of fileSystemCache.listeners) {
    listener(fileSystemCache.entriesList)
  }
}

function subscribeToCache(listener: CacheListener) {
  fileSystemCache.listeners.add(listener)
  listener(fileSystemCache.entriesList)
  return () => fileSystemCache.listeners.delete(listener)
}

function resetFileSystemCache() {
  fileSystemCache.entriesMap.clear()
  fileSystemCache.entriesList = []
  fileSystemCache.loadedDirectories.clear()
  fileSystemCache.loadingPromises.clear()
  fileSystemCache.pendingDirectories = []
  fileSystemCache.queueActive = false
  notifyCacheListeners()
}

function enqueueDirectory(path: string, priority = false) {
  const normalized = normalizeEntryPath(path)
  if (normalized === "." || fileSystemCache.loadedDirectories.has(normalized) || fileSystemCache.loadingPromises.has(normalized)) {
    return
  }

  const existingIndex = fileSystemCache.pendingDirectories.indexOf(normalized)
  if (existingIndex !== -1) {
    if (priority) {
      fileSystemCache.pendingDirectories.splice(existingIndex, 1)
      fileSystemCache.pendingDirectories.unshift(normalized)
    }
    return
  }

  if (priority) {
    fileSystemCache.pendingDirectories.unshift(normalized)
  } else {
    fileSystemCache.pendingDirectories.push(normalized)
  }
}

async function loadDirectory(path: string): Promise<void> {
  const normalized = normalizeEntryPath(path)
  if (fileSystemCache.loadedDirectories.has(normalized)) {
    return
  }

  const existing = fileSystemCache.loadingPromises.get(normalized)
  if (existing) {
    await existing
    return
  }

  const promise = cliApi
    .listFileSystem(normalized === "." ? "." : normalized)
    .then(({ entries }) => {
      const changed = updateCache(entries)
      fileSystemCache.loadedDirectories.add(normalized)
      for (const entry of entries) {
        if (entry.type === "directory") {
          enqueueDirectory(entry.path)
        }
      }
      if (changed) {
        notifyCacheListeners()
      }
    })
    .finally(() => {
      fileSystemCache.loadingPromises.delete(normalized)
    })

  fileSystemCache.loadingPromises.set(normalized, promise)
  await promise
}

async function processDirectoryQueue() {
  if (fileSystemCache.queueActive) {
    return
  }
  fileSystemCache.queueActive = true
  try {
    while (fileSystemCache.pendingDirectories.length > 0) {
      const next = fileSystemCache.pendingDirectories.shift()
      if (!next) continue
      try {
        await loadDirectory(next)
      } catch (error) {
        console.warn("Failed to load directory", next, error)
      }
    }
  } finally {
    fileSystemCache.queueActive = false
  }
}

function startBackgroundLoading() {
  void processDirectoryQueue()
}

function prioritizeDirectoriesForQuery(query: string) {
  const normalized = query.replace(/\\/g, "/").trim()
  if (!normalized) {
    return
  }
  const segments = normalized.split("/").filter(Boolean)
  let prefix = ""
  for (const segment of segments) {
    prefix = prefix ? `${prefix}/${segment}` : segment
    enqueueDirectory(prefix, true)
  }
  startBackgroundLoading()
}

async function ensureWorkspaceFilesystemLoaded(workspaceRoot: string) {
  if (cacheWorkspaceRoot && cacheWorkspaceRoot !== workspaceRoot) {
    cacheWorkspaceRoot = workspaceRoot
    resetFileSystemCache()
  } else if (!cacheWorkspaceRoot) {
    cacheWorkspaceRoot = workspaceRoot
  }

  await loadDirectory(".")
  startBackgroundLoading()
}

function resolveAbsolutePath(root: string, relativePath: string): string {
  if (!root) {
    return relativePath
  }
  if (!relativePath || relativePath === "." || relativePath === "./") {
    return root
  }
  const separator = root.includes("\\") ? "\\" : "/"
  const trimmedRoot = root.endsWith(separator) ? root : `${root}${separator}`
  const normalized = relativePath.replace(/[\\/]+/g, separator).replace(/^[\\/]+/, "")
  return `${trimmedRoot}${normalized}`
}

function formatRootLabel(root: string): string {
  if (!root) return "Workspace Root"
  const parts = root.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || root || "Workspace Root"
}

interface FileSystemBrowserDialogProps {
  open: boolean
  mode: "directories" | "files"
  title: string
  description?: string
  onSelect: (absolutePath: string) => void
  onClose: () => void
}

const FileSystemBrowserDialog: Component<FileSystemBrowserDialogProps> = (props) => {
  const [entries, setEntries] = createSignal<FileSystemEntry[]>([])
  const [rootPath, setRootPath] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [searchQuery, setSearchQuery] = createSignal("")
  const [selectedIndex, setSelectedIndex] = createSignal(0)

  let searchInputRef: HTMLInputElement | undefined

  onMount(() => {
    const unsubscribe = subscribeToCache((items) => setEntries(items))
    onCleanup(unsubscribe)
  })

  createEffect(() => {
    const query = searchQuery().trim()
    if (!query) {
      return
    }
    prioritizeDirectoriesForQuery(query)
  })

  async function refreshEntries() {
    setLoading(true)
    setError(null)
    try {
      const meta = await getServerMeta()
      setRootPath(meta.workspaceRoot)
      await ensureWorkspaceFilesystemLoaded(meta.workspaceRoot)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to load filesystem"
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  const filteredEntries = createMemo(() => {
    const query = searchQuery().trim().toLowerCase()
    const mode = props.mode
    const root = rootPath()
    const matchesType = entries().filter((entry) => (mode === "directories" ? entry.type === "directory" : entry.type === "file"))

    const baseEntries = mode === "directories" && root
      ? [
          {
            name: formatRootLabel(root),
            path: ".",
            type: "directory" as const,
          },
          ...matchesType,
        ]
      : matchesType

    if (!query) {
      return baseEntries
    }

    return baseEntries.filter((entry) => {
      const absolute = resolveAbsolutePath(root, entry.path)
      return absolute.toLowerCase().includes(query) || entry.name.toLowerCase().includes(query)
    })
  })

  const visibleEntries = createMemo(() => filteredEntries().slice(0, MAX_RESULTS))

  createEffect(() => {
    const list = visibleEntries()
    if (list.length === 0) {
      setSelectedIndex(0)
      return
    }
    if (selectedIndex() >= list.length) {
      setSelectedIndex(list.length - 1)
    }
  })

  createEffect(() => {
    if (!props.open) {
      return
    }
    setSearchQuery("")
    setSelectedIndex(0)
    void refreshEntries()
    setTimeout(() => searchInputRef?.focus(), 50)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!props.open) return
      const results = visibleEntries()
      if (event.key === "Escape") {
        event.preventDefault()
        props.onClose()
        return
      }
      if (results.length === 0) {
        return
      }
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1))
      } else if (event.key === "ArrowUp") {
        event.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      } else if (event.key === "Enter") {
        event.preventDefault()
        const entry = results[selectedIndex()]
        if (entry) {
          handleEntrySelect(entry)
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown)
    })
  })

  function handleEntrySelect(entry: FileSystemEntry) {
    const absolute = resolveAbsolutePath(rootPath(), entry.path)
    props.onSelect(absolute)
  }

  function handleOverlayClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      props.onClose()
    }
  }

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={handleOverlayClick}>
        <div class="modal-surface max-h-full w-full max-w-3xl overflow-hidden rounded-xl bg-surface p-0" role="dialog" aria-modal="true">
          <div class="panel flex flex-col">
            <div class="panel-header flex items-start justify-between gap-4">
              <div>
                <h3 class="panel-title">{props.title}</h3>
                <p class="panel-subtitle">
                  {props.description || "Search for a path under the configured workspace root."}
                </p>
                <Show when={rootPath()}>
                  <p class="text-xs text-muted mt-1 font-mono break-all">Root: {rootPath()}</p>
                </Show>
              </div>
              <button type="button" class="selector-button selector-button-secondary" onClick={props.onClose}>
                <X class="w-4 h-4" />
                Close
              </button>
            </div>

            <div class="panel-body">
              <label class="w-full text-sm text-secondary mb-2 block">Filter</label>
              <div class="selector-input-group">
                <div class="flex items-center gap-2 px-3 text-muted">
                  <Search class="w-4 h-4" />
                </div>
                <input
                  ref={(el) => {
                    searchInputRef = el
                  }}
                  type="text"
                  value={searchQuery()}
                  onInput={(event) => setSearchQuery(event.currentTarget.value)}
                  placeholder={props.mode === "directories" ? "Search for folders" : "Search for files"}
                  class="selector-input"
                />
              </div>
            </div>

            <div class="panel-list panel-list--fill max-h-96 overflow-auto">
              <Show
                when={!loading() && !error()}
                fallback={
                  <div class="flex items-center justify-center py-6 text-sm text-secondary">
                    <Show
                      when={loading()}
                      fallback={<span class="text-red-500">{error()}</span>}
                    >
                      <div class="flex items-center gap-2">
                        <Loader2 class="w-4 h-4 animate-spin" />
                        <span>Loading filesystem…</span>
                      </div>
                    </Show>
                  </div>
                }
              >
                <Show
                  when={visibleEntries().length > 0}
                  fallback={
                    <div class="flex flex-col items-center justify-center gap-2 py-10 text-sm text-secondary">
                      <p>No matches.</p>
                      <Show when={searchQuery().trim().length === 0}>
                        <button type="button" class="selector-button selector-button-secondary" onClick={refreshEntries}>
                          Retry
                        </button>
                      </Show>
                    </div>
                  }
                >
                  <For each={visibleEntries()}>
                    {(entry, index) => (
                      <button
                        type="button"
                        class="panel-list-item flex items-center gap-3 text-left"
                        classList={{ "panel-list-item-highlight": selectedIndex() === index() }}
                        onMouseEnter={() => setSelectedIndex(index())}
                        onClick={() => handleEntrySelect(entry)}
                      >
                        <div class="flex h-8 w-8 items-center justify-center rounded-md bg-surface-secondary text-muted">
                          <Show when={entry.type === "directory"} fallback={<FileIcon class="w-4 h-4" />}>
                            <FolderIcon class="w-4 h-4" />
                          </Show>
                        </div>
                        <div class="flex flex-col">
                          <span class="text-sm font-medium text-primary">{entry.name || entry.path}</span>
                          <span class="text-xs font-mono text-muted">{resolveAbsolutePath(rootPath(), entry.path)}</span>
                        </div>
                      </button>
                    )}
                  </For>
                </Show>
              </Show>
            </div>

            <div class="panel-footer">
              <div class="panel-footer-hints">
                <div class="flex items-center gap-1.5">
                  <kbd class="kbd">↑</kbd>
                  <kbd class="kbd">↓</kbd>
                  <span>Navigate</span>
                </div>
                <div class="flex items-center gap-1.5">
                  <kbd class="kbd">Enter</kbd>
                  <span>Select</span>
                </div>
                <div class="flex items-center gap-1.5">
                  <kbd class="kbd">Esc</kbd>
                  <span>Close</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Show>
  )
}

export default FileSystemBrowserDialog
