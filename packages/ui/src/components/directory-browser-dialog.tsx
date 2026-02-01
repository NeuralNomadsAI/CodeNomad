import { Component, Show, For, createSignal, createMemo, createEffect, onCleanup } from "solid-js"
import { ArrowUpLeft, Eye, EyeOff, Folder as FolderIcon, Loader2, X } from "lucide-solid"
import type { FileSystemEntry, FileSystemListingMetadata } from "../../../server/src/api-types"
import { WINDOWS_DRIVES_ROOT } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { cn } from "../lib/cn"
import { Button } from "./ui"
import { ScrollArea } from "./ui"

function normalizePathKey(input?: string | null) {
  if (!input || input === "." || input === "./") {
    return "."
  }
  if (input === WINDOWS_DRIVES_ROOT) {
    return WINDOWS_DRIVES_ROOT
  }
  let normalized = input.replace(/\\/g, "/")
  if (/^[a-zA-Z]:/.test(normalized)) {
    const [drive, rest = ""] = normalized.split(":")
    const suffix = rest.startsWith("/") ? rest : rest ? `/${rest}` : "/"
    return `${drive.toUpperCase()}:${suffix.replace(/\/+/g, "/")}`
  }
  if (normalized.startsWith("//")) {
    return `//${normalized.slice(2).replace(/\/+/g, "/")}`
  }
  if (normalized.startsWith("/")) {
    return `/${normalized.slice(1).replace(/\/+/g, "/")}`
  }
  normalized = normalized.replace(/^\.\/+/, "").replace(/\/+/g, "/")
  return normalized === "" ? "." : normalized
}


function isAbsolutePathLike(input: string) {
  return input.startsWith("/") || /^[a-zA-Z]:/.test(input) || input.startsWith("\\\\")
}

interface DirectoryBrowserDialogProps {
  open: boolean
  title: string
  description?: string
  onSelect: (absolutePath: string) => void
  onClose: () => void
}

function resolveAbsolutePath(root: string, relativePath: string) {
  if (!root) {
    return relativePath
  }
  if (!relativePath || relativePath === "." || relativePath === "./") {
    return root
  }
  if (isAbsolutePathLike(relativePath)) {
    return relativePath
  }
  const separator = root.includes("\\") ? "\\" : "/"
  const trimmedRoot = root.endsWith(separator) ? root : `${root}${separator}`
  const normalized = relativePath.replace(/[\\/]+/g, separator).replace(/^[\\/]+/, "")
  return `${trimmedRoot}${normalized}`
}

type FolderRow =
  | { type: "up"; path: string }
  | { type: "folder"; entry: FileSystemEntry }

const DirectoryBrowserDialog: Component<DirectoryBrowserDialogProps> = (props) => {
  const [rootPath, setRootPath] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [directoryChildren, setDirectoryChildren] = createSignal<Map<string, FileSystemEntry[]>>(new Map())
  const [loadingPaths, setLoadingPaths] = createSignal<Set<string>>(new Set())
  const [currentPathKey, setCurrentPathKey] = createSignal<string | null>(null)
  const [currentMetadata, setCurrentMetadata] = createSignal<FileSystemListingMetadata | null>(null)
  const [showHidden, setShowHidden] = createSignal(false)

  const metadataCache = new Map<string, FileSystemListingMetadata>()
  const inFlightRequests = new Map<string, Promise<FileSystemListingMetadata>>()

  function resetState() {
    setDirectoryChildren(new Map<string, FileSystemEntry[]>())
    setLoadingPaths(new Set<string>())
    setCurrentPathKey(null)
    setCurrentMetadata(null)
    metadataCache.clear()
    inFlightRequests.clear()
    setError(null)
  }

  createEffect(() => {
    if (!props.open) {
      return
    }
    resetState()
    void initialize()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        props.onClose()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown)
    })
  })

  async function initialize() {
    setLoading(true)
    try {
      const metadata = await loadDirectory()
      applyMetadata(metadata)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to load filesystem"
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  function applyMetadata(metadata: FileSystemListingMetadata) {
    const key = normalizePathKey(metadata.currentPath)
    setCurrentPathKey(key)
    setCurrentMetadata(metadata)
    setRootPath(metadata.rootPath)
  }

  async function loadDirectory(targetPath?: string): Promise<FileSystemListingMetadata> {
    const includeHidden = showHidden()
    const key = targetPath ? normalizePathKey(targetPath) : undefined

    const request = (async () => {
      if (key) {
        setLoadingPaths((prev) => {
          const next = new Set(prev)
          next.add(key)
          return next
        })
      }

      const response = await serverApi.listFileSystem(targetPath, {
        includeFiles: false,
        includeHidden,
        allowFullNavigation: true,
      })
      const canonicalKey = normalizePathKey(response.metadata.currentPath)
      const directories = response.entries
        .filter((entry) => entry.type === "directory")
        .sort((a, b) => a.name.localeCompare(b.name))

      setDirectoryChildren((prev) => {
        const next = new Map(prev)
        next.set(canonicalKey, directories)
        return next
      })

      metadataCache.set(canonicalKey, response.metadata)

      setLoadingPaths((prev) => {
        const next = new Set(prev)
        if (key) {
          next.delete(key)
        }
        next.delete(canonicalKey)
        return next
      })

      return response.metadata
    })()
      .catch((err) => {
        if (key) {
          setLoadingPaths((prev) => {
            const next = new Set(prev)
            next.delete(key)
            return next
          })
        }
        throw err
      })
      .finally(() => {
        if (key) {
          inFlightRequests.delete(key)
        }
      })

    if (key) {
      inFlightRequests.set(key, request)
    }

    return request
  }

  async function navigateTo(path?: string) {
    setError(null)
    try {
      const metadata = await loadDirectory(path)
      applyMetadata(metadata)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to load filesystem"
      setError(message)
    }
  }

  function handleToggleHidden() {
    setShowHidden((prev) => !prev)
    // Clear cache and reload current directory with new hidden setting
    metadataCache.clear()
    inFlightRequests.clear()
    setDirectoryChildren(new Map())
    const currentPath = currentMetadata()?.currentPath
    void navigateTo(currentPath)
  }

  const folderRows = createMemo<FolderRow[]>(() => {
    const rows: FolderRow[] = []
    const metadata = currentMetadata()
    if (metadata?.parentPath) {
      rows.push({ type: "up", path: metadata.parentPath })
    }
    const key = currentPathKey()
    if (!key) {
      return rows
    }
    const children = directoryChildren().get(key) ?? []
    for (const entry of children) {
      rows.push({ type: "folder", entry })
    }
    return rows
  })

  function handleNavigateTo(path: string) {
    void navigateTo(path)
  }

  function handleNavigateUp() {
    const parent = currentMetadata()?.parentPath
    if (parent) {
      void navigateTo(parent)
    }
  }

  const currentAbsolutePath = createMemo(() => {
    const metadata = currentMetadata()
    if (!metadata) {
      return ""
    }
    if (metadata.pathKind === "drives") {
      return ""
    }
    if (metadata.pathKind === "relative") {
      return resolveAbsolutePath(metadata.rootPath, metadata.currentPath)
    }
    return metadata.displayPath
  })

  const canSelectCurrent = createMemo(() => Boolean(currentAbsolutePath()))

  function handleEntrySelect(entry: FileSystemEntry) {
    const absolutePath = entry.absolutePath
      ? entry.absolutePath
      : isAbsolutePathLike(entry.path)
        ? entry.path
        : resolveAbsolutePath(rootPath(), entry.path)
    props.onSelect(absolutePath)
  }

  function isPathLoading(path: string) {
    return loadingPaths().has(normalizePathKey(path))
  }

  function handleOverlayClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      props.onClose()
    }
  }

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-6"
        onClick={handleOverlayClick}
      >
        <div
          class={cn(
            "w-[min(960px,90vw)] h-[min(85vh,900px)] max-h-[90vh]",
            "rounded-xl border bg-background shadow-2xl overflow-hidden"
          )}
          role="dialog"
          aria-modal="true"
        >
          <div class="flex flex-col h-full">
            {/* Header */}
            <div class={cn(
              "flex items-start justify-between gap-5 p-6",
              "border-b border-border bg-secondary"
            )}>
              <div class="flex flex-col gap-1.5">
                <h3 class="text-2xl leading-tight font-semibold text-foreground">
                  {props.title}
                </h3>
                <p class="text-lg leading-relaxed text-muted-foreground">
                  {props.description || "Browse folders under the configured workspace root."}
                </p>
              </div>
              <div class="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleToggleHidden}
                  title={showHidden() ? "Hide hidden folders" : "Show hidden folders"}
                  class="flex items-center gap-1.5 text-xs"
                >
                  <Show when={showHidden()} fallback={<Eye class="w-3.5 h-3.5" />}>
                    <EyeOff class="w-3.5 h-3.5" />
                  </Show>
                  <span>{showHidden() ? "Hide ." : "Show ."}</span>
                </Button>
                <button
                  type="button"
                  class={cn(
                    "inline-flex items-center justify-center w-10 h-10",
                    "rounded-full border border-border bg-background text-foreground",
                    "transition-colors hover:bg-accent"
                  )}
                  aria-label="Close"
                  onClick={props.onClose}
                >
                  <X class="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div class="flex-1 min-h-0 p-6 flex flex-col gap-4 bg-background">
              {/* Current path display */}
              <Show when={rootPath()}>
                <div class="flex items-center justify-between gap-4 w-full">
                  <div class="flex flex-col gap-0.5">
                    <span class="text-sm uppercase tracking-[0.04em] text-muted-foreground">
                      Current folder
                    </span>
                    <span class="font-mono text-base text-foreground">
                      {currentAbsolutePath()}
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canSelectCurrent()}
                    onClick={() => {
                      const absolute = currentAbsolutePath()
                      if (absolute) {
                        props.onSelect(absolute)
                      }
                    }}
                  >
                    Select Current
                  </Button>
                </div>
              </Show>

              {/* Directory listing */}
              <Show
                when={!loading() && !error()}
                fallback={
                  <div class="flex-1 flex items-center justify-center p-6 text-center">
                    <Show when={loading()} fallback={<span class="text-destructive">{error()}</span>}>
                      <div class="inline-flex items-center gap-2 text-muted-foreground">
                        <Loader2 class="w-5 h-5 animate-spin" />
                        <span>Loading folders...</span>
                      </div>
                    </Show>
                  </div>
                }
              >
                <Show
                  when={folderRows().length > 0}
                  fallback={
                    <div class="flex-1 flex items-center justify-center p-6 text-center text-muted-foreground">
                      No folders available.
                    </div>
                  }
                >
                  <ScrollArea class="flex-1 min-h-0" role="listbox">
                    <For each={folderRows()}>
                      {(item) => {
                        const isFolder = item.type === "folder"
                        const label = isFolder ? item.entry.name || item.entry.path : "Up one level"
                        const navigate = () => (isFolder ? handleNavigateTo(item.entry.path) : handleNavigateUp())
                        return (
                          <div class="border-b border-border last:border-b-0 transition-colors hover:bg-accent/50" role="option">
                            <div class="flex items-center gap-4 px-4 py-3">
                              <button
                                type="button"
                                class="flex flex-1 items-center gap-4 text-left bg-transparent border-none text-foreground p-0 cursor-pointer"
                                onClick={navigate}
                              >
                                <div class={cn(
                                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                                  "bg-secondary text-muted-foreground"
                                )}>
                                  <Show when={!isFolder} fallback={<FolderIcon class="w-4 h-4" />}>
                                    <ArrowUpLeft class="w-4 h-4" />
                                  </Show>
                                </div>
                                <span class="text-lg font-medium">{label}</span>
                                <Show when={isFolder && isPathLoading(item.entry.path)}>
                                  <Loader2 class="w-[18px] h-[18px] text-muted-foreground animate-spin" />
                                </Show>
                              </button>
                              {isFolder ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  class="min-w-[90px]"
                                  onClick={(event: MouseEvent) => {
                                    event.stopPropagation()
                                    handleEntrySelect(item.entry)
                                  }}
                                >
                                  Select
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        )
                      }}
                    </For>
                  </ScrollArea>
                </Show>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Show>
  )
}

export default DirectoryBrowserDialog
