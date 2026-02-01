import { Component, Show, For, createSignal, createMemo, createEffect, onCleanup } from "solid-js"
import { Folder as FolderIcon, File as FileIcon, Loader2, Search, X, ArrowUpLeft } from "lucide-solid"
import type { FileSystemEntry, FileSystemListingMetadata } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { getLogger } from "../lib/logger"
import { cn } from "../lib/cn"
import { Button } from "./ui"
import { Label } from "./ui"
import { ScrollArea } from "./ui"

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
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-6"
        onClick={handleOverlayClick}
      >
        <div
          class={cn(
            "w-full max-w-3xl max-h-full overflow-hidden rounded-xl border bg-background shadow-2xl",
            "flex flex-col"
          )}
          role="dialog"
          aria-modal="true"
        >
          {/* Header */}
          <div class="flex items-start justify-between gap-4 border-b border-border bg-secondary px-6 py-4">
            <div class="flex flex-col gap-1">
              <h3 class="text-base font-semibold text-foreground">{props.title}</h3>
              <p class="text-xs text-muted-foreground">
                {props.description || "Search for a path under the configured workspace root."}
              </p>
              <Show when={rootPath()}>
                <p class="text-xs text-muted-foreground mt-1 font-mono break-all">Root: {rootPath()}</p>
              </Show>
            </div>
            <Button variant="outline" size="sm" onClick={props.onClose}>
              <X class="w-4 h-4 mr-1" />
              Close
            </Button>
          </div>

          {/* Search */}
          <div class="px-6 py-3 border-b border-border">
            <Label class="block text-sm text-muted-foreground mb-2">Filter</Label>
            <div class="flex items-center gap-2 rounded-md border border-input bg-transparent px-3">
              <Search class="w-4 h-4 text-muted-foreground shrink-0" />
              <input
                ref={(el) => {
                  searchInputRef = el
                }}
                type="text"
                value={searchQuery()}
                onInput={(event) => setSearchQuery(event.currentTarget.value)}
                placeholder={props.mode === "directories" ? "Search for folders" : "Search for files"}
                class="flex-1 bg-transparent py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>

          {/* Current folder banner */}
          <Show when={props.mode === "directories"}>
            <div class="px-6 py-3 border-b border-border">
              <div class="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3 bg-secondary/50">
                <div>
                  <p class="text-xs text-muted-foreground uppercase tracking-wide">Current folder</p>
                  <p class="text-sm font-mono text-foreground break-all">{currentAbsolutePath()}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => props.onSelect(currentAbsolutePath())}
                >
                  Select Current
                </Button>
              </div>
            </div>
          </Show>

          {/* File list */}
          <ScrollArea class="flex-1 max-h-96">
            <Show
              when={entries().length > 0}
              fallback={
                <div class="flex items-center justify-center py-6 text-sm text-muted-foreground">
                  <Show
                    when={loadingPath() !== null}
                    fallback={<span class="text-destructive">{error()}</span>}
                  >
                    <div class="flex items-center gap-2">
                      <Loader2 class="w-4 h-4 animate-spin" />
                      <span>Loading {describeLoadingPath()}...</span>
                    </div>
                  </Show>
                </div>
              }
            >
              <Show when={loadingPath()}>
                <div class="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
                  <Loader2 class="w-3.5 h-3.5 animate-spin" />
                  <span>Loading {describeLoadingPath()}...</span>
                </div>
              </Show>
              <Show
                when={folderRows().length > 0}
                fallback={
                  <div class="flex flex-col items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                    <p>No entries found.</p>
                    <Button variant="outline" size="sm" onClick={refreshEntries}>
                      Retry
                    </Button>
                  </div>
                }
              >
                <For each={folderRows()}>
                  {(row) => {
                    if (row.type === "up") {
                      return (
                        <div class="border-b border-border last:border-b-0 transition-colors hover:bg-accent/50">
                          <div class="flex items-center gap-3 px-4 py-3">
                            <button
                              type="button"
                              class="flex flex-1 items-center gap-3 bg-transparent border-none text-left text-foreground cursor-pointer p-0"
                              onClick={handleNavigateUp}
                            >
                              <div class={cn(
                                "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                                "bg-secondary text-muted-foreground"
                              )}>
                                <ArrowUpLeft class="w-4 h-4" />
                              </div>
                              <span class="text-base font-medium">Up one level</span>
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
                      <div class="border-b border-border last:border-b-0 transition-colors hover:bg-accent/50">
                        <div class="flex items-center gap-3 px-4 py-3">
                          <button
                            type="button"
                            class="flex flex-1 items-center gap-3 bg-transparent border-none text-left text-foreground cursor-pointer p-0"
                            onClick={activateEntry}
                          >
                            <div class={cn(
                              "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                              "bg-secondary text-muted-foreground"
                            )}>
                              <Show when={entry.type === "directory"} fallback={<FileIcon class="w-4 h-4" />}>
                                <FolderIcon class="w-4 h-4" />
                              </Show>
                            </div>
                            <div class="flex flex-col">
                              <span class="text-base font-medium">{entry.name || entry.path}</span>
                              <span class="text-xs text-muted-foreground">
                                {resolveAbsolutePath(rootPath(), entry.path)}
                              </span>
                            </div>
                          </button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={(event: MouseEvent) => {
                              event.stopPropagation()
                              selectEntry()
                            }}
                          >
                            Select
                          </Button>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </Show>
            </Show>
          </ScrollArea>

          {/* Footer hints */}
          <div class="flex items-center justify-center flex-wrap gap-3 border-t border-border bg-secondary px-4 py-3 text-xs text-muted-foreground">
            <div class="flex items-center gap-1.5">
              <kbd class="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-background px-1 text-[10px] font-medium">
                ↑
              </kbd>
              <kbd class="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-background px-1 text-[10px] font-medium">
                ↓
              </kbd>
              <span>Navigate</span>
            </div>
            <div class="flex items-center gap-1.5">
              <kbd class="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-background px-1 text-[10px] font-medium">
                Enter
              </kbd>
              <span>Select</span>
            </div>
            <div class="flex items-center gap-1.5">
              <kbd class="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-background px-1 text-[10px] font-medium">
                Esc
              </kbd>
              <span>Close</span>
            </div>
          </div>
        </div>
      </div>
    </Show>
  )
}

export default FileSystemBrowserDialog
