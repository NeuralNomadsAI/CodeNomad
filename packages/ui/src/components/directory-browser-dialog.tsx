import { Component, Show, For, createSignal, createMemo, createEffect, onCleanup } from "solid-js"
import { ArrowUpLeft, Folder as FolderIcon, FolderPlus, Loader2, X } from "lucide-solid"
import type { FileSystemEntry, FileSystemListingMetadata } from "../../../server/src/api-types"
import { WINDOWS_DRIVES_ROOT } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { showAlertDialog, showPromptDialog } from "../stores/alerts"
import { useI18n } from "../lib/i18n"

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
  const { t } = useI18n()
  const [rootPath, setRootPath] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [creatingFolder, setCreatingFolder] = createSignal(false)
  const [directoryChildren, setDirectoryChildren] = createSignal<Map<string, FileSystemEntry[]>>(new Map())
  const [loadingPaths, setLoadingPaths] = createSignal<Set<string>>(new Set())
  const [currentPathKey, setCurrentPathKey] = createSignal<string | null>(null)
  const [currentMetadata, setCurrentMetadata] = createSignal<FileSystemListingMetadata | null>(null)

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
      const message = err instanceof Error ? err.message : t("directoryBrowser.load.errorFallback")
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
    const key = targetPath ? normalizePathKey(targetPath) : undefined
    if (key) {
      const cached = metadataCache.get(key)
      if (cached) {
        return cached
      }
      const pending = inFlightRequests.get(key)
      if (pending) {
        return pending
      }
    }

    const request = (async () => {
      if (key) {
        setLoadingPaths((prev) => {
          const next = new Set(prev)
          next.add(key)
          return next
        })
      }

      const response = await serverApi.listFileSystem(targetPath, { includeFiles: false })
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
      const message = err instanceof Error ? err.message : t("directoryBrowser.load.errorFallback")
      setError(message)
    }
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

  async function handleCreateFolder() {
    if (creatingFolder()) return
    const metadata = currentMetadata()
    if (!metadata || metadata.pathKind === "drives") {
      return
    }

    const name =
      (await showPromptDialog(t("directoryBrowser.createFolder.promptMessage"), {
        title: t("directoryBrowser.createFolder.title"),
        inputLabel: t("directoryBrowser.createFolder.inputLabel"),
        inputPlaceholder: t("directoryBrowser.createFolder.inputPlaceholder"),
        confirmLabel: t("directoryBrowser.createFolder.confirmLabel"),
        cancelLabel: t("directoryBrowser.createFolder.cancelLabel"),
      }))?.trim() ?? ""
    if (!name) return

    if (name === "." || name === ".." || name.startsWith("~") || name.includes("/") || name.includes("\\")) {
      showAlertDialog(t("directoryBrowser.createFolder.invalidNameMessage"), {
        variant: "warning",
        detail: t("directoryBrowser.createFolder.invalidNameDetail"),
      })
      return
    }

    setCreatingFolder(true)
    try {
      const parentKey = normalizePathKey(metadata.currentPath)
      metadataCache.delete(parentKey)
      inFlightRequests.delete(parentKey)
      setDirectoryChildren((prev) => {
        const next = new Map(prev)
        next.delete(parentKey)
        return next
      })

      const created = await serverApi.createFileSystemFolder(metadata.currentPath, name)
      await navigateTo(created.path)
    } catch (err) {
      const message = err instanceof Error ? err.message : t("directoryBrowser.createFolder.errorFallback")
      showAlertDialog(message, { variant: "error", title: t("directoryBrowser.createFolder.errorFallback") })
    } finally {
      setCreatingFolder(false)
    }
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
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={handleOverlayClick}>
        <div class="modal-surface directory-browser-modal" role="dialog" aria-modal="true">
          <div class="panel directory-browser-panel">
            <div class="directory-browser-header">
              <div class="directory-browser-heading">
                <h3 class="directory-browser-title">{props.title}</h3>
                <p class="directory-browser-description">
                  {props.description || t("directoryBrowser.defaultDescription")}
                </p>
              </div>
              <button type="button" class="directory-browser-close" aria-label={t("directoryBrowser.close")} onClick={props.onClose}>
                <X class="w-5 h-5" />
              </button>
            </div>

            <div class="panel-body directory-browser-body">
              <Show when={rootPath()}>
                <div class="directory-browser-current">
                  <div class="directory-browser-current-meta">
                    <span class="directory-browser-current-label">{t("directoryBrowser.currentFolder")}</span>
                    <span class="directory-browser-current-path">{currentAbsolutePath()}</span>
                  </div>
                  <div class="directory-browser-current-actions">
                    <button
                      type="button"
                      class="selector-button selector-button-secondary directory-browser-select directory-browser-current-select"
                      disabled={!canSelectCurrent() || creatingFolder()}
                      onClick={() => {
                        const absolute = currentAbsolutePath()
                        if (absolute) {
                          props.onSelect(absolute)
                        }
                      }}
                    >
                      {t("directoryBrowser.selectCurrent")}
                    </button>
                    <button
                      type="button"
                      class="selector-button selector-button-secondary directory-browser-select"
                      disabled={!canSelectCurrent() || creatingFolder()}
                      onClick={() => void handleCreateFolder()}
                    >
                      <span class="inline-flex items-center gap-2">
                        <FolderPlus class="w-4 h-4" />
                        {creatingFolder() ? t("directoryBrowser.creating") : t("directoryBrowser.newFolder")}
                      </span>
                    </button>
                  </div>
                </div>
              </Show>
              <Show
                when={!loading() && !error()}
                fallback={
                  <div class="panel-empty-state flex-1">
                    <Show when={loading()} fallback={<span class="text-red-500">{error()}</span>}>
                      <div class="directory-browser-loading">
                        <Loader2 class="w-5 h-5 animate-spin" />
                        <span>{t("directoryBrowser.loadingFolders")}</span>
                      </div>
                    </Show>
                  </div>
                }
              >
                <Show
                  when={folderRows().length > 0}
                  fallback={<div class="panel-empty-state flex-1">{t("directoryBrowser.noFolders")}</div>}
                >
                  <div class="panel-list panel-list--fill flex-1 min-h-0 overflow-auto directory-browser-list" role="listbox">
                    <For each={folderRows()}>
                      {(item) => {
                        const isFolder = item.type === "folder"
                        const label = isFolder ? item.entry.name || item.entry.path : t("directoryBrowser.upOneLevel")
                        const navigate = () => (isFolder ? handleNavigateTo(item.entry.path) : handleNavigateUp())
                        return (
                          <div class="panel-list-item" role="option">
                            <div class="panel-list-item-content directory-browser-row">
                              <button type="button" class="directory-browser-row-main" onClick={navigate}>
                                <div class="directory-browser-row-icon">
                                  <Show when={!isFolder} fallback={<FolderIcon class="w-4 h-4" />}>
                                    <ArrowUpLeft class="w-4 h-4" />
                                  </Show>
                                </div>
                                <div class="directory-browser-row-text">
                                  <span class="directory-browser-row-name">{label}</span>
                                </div>
                                <Show when={isFolder && isPathLoading(item.entry.path)}>
                                  <Loader2 class="directory-browser-row-spinner animate-spin" />
                                </Show>
                              </button>
                              {isFolder ? (
                                <button
                                  type="button"
                                  class="selector-button selector-button-secondary directory-browser-select"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    handleEntrySelect(item.entry)
                                  }}
                                >
                                  {t("directoryBrowser.select")}
                                </button>
                              ) : null}
                            </div>
                          </div>
                        )
                      }}
                    </For>
                  </div>
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
