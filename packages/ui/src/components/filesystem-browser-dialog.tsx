import { Component, Show, For, createSignal, createMemo, createEffect, onCleanup } from "solid-js"
import { Folder as FolderIcon, File as FileIcon, Loader2, Search, X, ArrowUpLeft } from "lucide-solid"
import type { FileSystemEntry, FileSystemListingMetadata } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { getLogger } from "../lib/logger"
const log = getLogger("actions")


const MAX_RESULTS = 200

function normalizeEntryPath(path: string | undefined): string {
  if (!path || path === "." || path === "./") {
    return "."
  }
  let cleaned = path.replace(/\\/g, "/")
  if (cleaned.startsWith("./")) {
    cleaned = cleaned.replace(/^\.\/+/, "")
  }
  if (cleaned.startsWith("/")) {
    cleaned = cleaned.replace(/^\/+/, "")
  }
  cleaned = cleaned.replace(/\/+/g, "/")
  return cleaned === "" ? "." : cleaned
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


interface FileSystemBrowserDialogProps {
  open: boolean
  mode: "directories" | "files"
  title: string
  description?: string
  onSelect: (absolutePath: string) => void
  onClose: () => void
}

type FolderRow = { type: "up"; path: string } | { type: "entry"; entry: FileSystemEntry }

const FileSystemBrowserDialog: Component<FileSystemBrowserDialogProps> = (props) => {
  const [rootPath, setRootPath] = createSignal("")
  const [entries, setEntries] = createSignal<FileSystemEntry[]>([])
  const [currentMetadata, setCurrentMetadata] = createSignal<FileSystemListingMetadata | null>(null)
  const [loadingPath, setLoadingPath] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [searchQuery, setSearchQuery] = createSignal("")
  const [selectedIndex, setSelectedIndex] = createSignal(0)

  let searchInputRef: HTMLInputElement | undefined

  const directoryCache = new Map<string, FileSystemEntry[]>()
  const metadataCache = new Map<string, FileSystemListingMetadata>()
  const inFlightLoads = new Map<string, Promise<FileSystemListingMetadata>>()

  function resetDialogState() {
    directoryCache.clear()
    metadataCache.clear()
    inFlightLoads.clear()
    setEntries([])
    setCurrentMetadata(null)
    setLoadingPath(null)
  }

  async function fetchDirectory(path: string, makeCurrent = false): Promise<FileSystemListingMetadata> {
    const normalized = normalizeEntryPath(path)

    if (directoryCache.has(normalized) && metadataCache.has(normalized)) {
      if (makeCurrent) {
        setCurrentMetadata(metadataCache.get(normalized) ?? null)
        setEntries(directoryCache.get(normalized) ?? [])
      }
      return metadataCache.get(normalized) as FileSystemListingMetadata
    }

    if (inFlightLoads.has(normalized)) {
      const metadata = await inFlightLoads.get(normalized)!
      if (makeCurrent) {
        setCurrentMetadata(metadata)
        setEntries(directoryCache.get(normalized) ?? [])
      }
      return metadata
    }

    const loadPromise = (async () => {
      setLoadingPath(normalized)
      const response = await serverApi.listFileSystem(normalized === "." ? "." : normalized, {
        includeFiles: props.mode === "files",
      })
      directoryCache.set(normalized, response.entries)
      metadataCache.set(normalized, response.metadata)
      if (!rootPath()) {
        setRootPath(response.metadata.rootPath)
      }
      if (loadingPath() === normalized) {
        setLoadingPath(null)
      }
      return response.metadata
    })().catch((err) => {
      if (loadingPath() === normalized) {
        setLoadingPath(null)
      }
      throw err
    })

    inFlightLoads.set(normalized, loadPromise)
    try {
      const metadata = await loadPromise
      if (makeCurrent) {
        const key = normalizeEntryPath(metadata.currentPath)
        setCurrentMetadata(metadata)
        setEntries(directoryCache.get(key) ?? directoryCache.get(normalized) ?? [])
      }
      return metadata
    } finally {
      inFlightLoads.delete(normalized)
    }
  }

  async function refreshEntries() {
    setError(null)
    resetDialogState()
    try {
      const metadata = await fetchDirectory(".", true)
      setRootPath(metadata.rootPath)
      setEntries(directoryCache.get(normalizeEntryPath(metadata.currentPath)) ?? [])
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to load filesystem"
      setError(message)
    }
  }

  function describeLoadingPath() {
    const path = loadingPath()
    if (!path) {
      return "filesystem"
    }
    if (path === ".") {
      return rootPath() || "workspace root"
    }
    return resolveAbsolutePath(rootPath(), path)
  }

  function currentAbsolutePath(): string {
    const metadata = currentMetadata()
    if (!metadata) {
      return rootPath()
    }
    if (metadata.pathKind === "relative") {
      return resolveAbsolutePath(rootPath(), metadata.currentPath)
    }
    return metadata.displayPath
  }

  function handleOverlayClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      props.onClose()
    }
  }

  function handleEntrySelect(entry: FileSystemEntry) {
    const absolute = resolveAbsolutePath(rootPath(), entry.path)
    props.onSelect(absolute)
  }

  function handleNavigateTo(path: string) {
    void fetchDirectory(path, true).catch((err) => {
      log.error("Failed to open directory", err)
      setError(err instanceof Error ? err.message : "Unable to open directory")
    })
  }

  function handleNavigateUp() {
    const parent = currentMetadata()?.parentPath
    if (!parent) {
      return
    }
    handleNavigateTo(parent)
  }

  const filteredEntries = createMemo(() => {
    const query = searchQuery().trim().toLowerCase()
    const subset = entries().filter((entry) => (props.mode === "directories" ? entry.type === "directory" : true))
    if (!query) {
      return subset
    }
    return subset.filter((entry) => {
      const absolute = resolveAbsolutePath(rootPath(), entry.path)
      return absolute.toLowerCase().includes(query) || entry.name.toLowerCase().includes(query)
    })
  })

  const visibleEntries = createMemo(() => filteredEntries().slice(0, MAX_RESULTS))

  const folderRows = createMemo<FolderRow[]>(() => {
    const rows: FolderRow[] = []
    const metadata = currentMetadata()
    if (metadata?.parentPath) {
      rows.push({ type: "up", path: metadata.parentPath })
    }
    for (const entry of visibleEntries()) {
      rows.push({ type: "entry", entry })
    }
    return rows
  })

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
      resetDialogState()
      setRootPath("")
      setError(null)
    })
  })

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={handleOverlayClick}>
        <div class="modal-surface max-h-full w-full max-w-3xl overflow-hidden rounded-xl bg-surface p-0" role="dialog" aria-modal="true">
          <div class="panel flex flex-col">
            <div class="panel-header flex items-start justify-between gap-4">
              <div>
                <h3 class="panel-title">{props.title}</h3>
                <p class="panel-subtitle">{props.description || "Search for a path under the configured workspace root."}</p>
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

            <Show when={props.mode === "directories"}>
              <div class="px-4 pb-2">
                <div class="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-4 py-3">
                  <div>
                    <p class="text-xs text-secondary uppercase tracking-wide">Current folder</p>
                    <p class="text-sm font-mono text-primary break-all">{currentAbsolutePath()}</p>
                  </div>
                  <button
                    type="button"
                    class="selector-button selector-button-secondary whitespace-nowrap"
                    onClick={() => props.onSelect(currentAbsolutePath())}
                  >
                    Select Current
                  </button>
                </div>
              </div>
            </Show>

            <div class="panel-list panel-list--fill max-h-96 overflow-auto">
              <Show
                when={entries().length > 0}
                fallback={
                  <div class="flex items-center justify-center py-6 text-sm text-secondary">
                    <Show
                      when={loadingPath() !== null}
                      fallback={<span class="text-red-500">{error()}</span>}
                    >
                      <div class="flex items-center gap-2">
                        <Loader2 class="w-4 h-4 animate-spin" />
                        <span>Loading {describeLoadingPath()}…</span>
                      </div>
                    </Show>
                  </div>
                }
              >
                <Show when={loadingPath()}>
                  <div class="flex items-center gap-2 px-4 py-2 text-xs text-secondary">
                    <Loader2 class="w-3.5 h-3.5 animate-spin" />
                    <span>Loading {describeLoadingPath()}…</span>
                  </div>
                </Show>
                <Show
                  when={folderRows().length > 0}
                  fallback={
                    <div class="flex flex-col items-center justify-center gap-2 py-10 text-sm text-secondary">
                      <p>No entries found.</p>
                      <button type="button" class="selector-button selector-button-secondary" onClick={refreshEntries}>
                        Retry
                      </button>
                    </div>
                  }
                >
                  <For each={folderRows()}>
                    {(row) => {
                      if (row.type === "up") {
                        return (
                          <div class="panel-list-item" role="button">
                            <div class="panel-list-item-content directory-browser-row">
                              <button type="button" class="directory-browser-row-main" onClick={handleNavigateUp}>
                                <div class="directory-browser-row-icon">
                                  <ArrowUpLeft class="w-4 h-4" />
                                </div>
                                <div class="directory-browser-row-text">
                                  <span class="directory-browser-row-name">Up one level</span>
                                </div>
                              </button>
                            </div>
                          </div>
                        )
                      }

                      const entry = row.entry
                      const selectEntry = () => handleEntrySelect(entry)
                      const activateEntry = () => {
                        if (entry.type === "directory") {
                          handleNavigateTo(entry.path)
                        } else {
                          selectEntry()
                        }
                      }

                      return (
                        <div class="panel-list-item" role="listitem">
                          <div class="panel-list-item-content directory-browser-row">
                            <button type="button" class="directory-browser-row-main" onClick={activateEntry}>
                              <div class="directory-browser-row-icon">
                                <Show when={entry.type === "directory"} fallback={<FileIcon class="w-4 h-4" />}>
                                  <FolderIcon class="w-4 h-4" />
                                </Show>
                              </div>
                              <div class="directory-browser-row-text">
                                <span class="directory-browser-row-name">{entry.name || entry.path}</span>
                                <span class="directory-browser-row-sub">
                                  {resolveAbsolutePath(rootPath(), entry.path)}
                                </span>
                              </div>
                            </button>
                            <button
                              type="button"
                              class="selector-button selector-button-secondary directory-browser-select"
                              onClick={(event) => {
                                event.stopPropagation()
                                selectEntry()
                              }}
                            >
                              Select
                            </button>
                          </div>
                        </div>
                      )
                    }}
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

