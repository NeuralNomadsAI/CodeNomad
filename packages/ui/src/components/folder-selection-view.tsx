import { Component, createSignal, Show, For, onMount, onCleanup, createEffect } from "solid-js"
import { Folder, Clock, Trash2, FolderPlus, Settings, ChevronRight, MonitorUp } from "lucide-solid"
import { useConfig } from "../stores/preferences"
import AdvancedSettingsModal from "./advanced-settings-modal"
import DirectoryBrowserDialog from "./directory-browser-dialog"
import Kbd from "./kbd"
import { openNativeFolderDialog, supportsNativeDialogs } from "../lib/native/native-functions"
import { getServerMeta } from "../lib/server-meta"

const codeNomadLogo = new URL("../images/CodeNomad-Icon.png", import.meta.url).href


interface FolderSelectionViewProps {
  onSelectFolder: (folder: string, binaryPath?: string) => void
  isLoading?: boolean
  advancedSettingsOpen?: boolean
  onAdvancedSettingsOpen?: () => void
  onAdvancedSettingsClose?: () => void
  onOpenRemoteAccess?: () => void
}

const FolderSelectionView: Component<FolderSelectionViewProps> = (props) => {
  const { recentFolders, removeRecentFolder, preferences } = useConfig()
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [focusMode, setFocusMode] = createSignal<"recent" | "new" | null>("recent")
  const [selectedBinary, setSelectedBinary] = createSignal(preferences().lastUsedBinary || "opencode")
  const [isFolderBrowserOpen, setIsFolderBrowserOpen] = createSignal(false)
  const [manualPath, setManualPath] = createSignal("")
  const [manualPathError, setManualPathError] = createSignal<string | null>(null)
  const [workspaceRoot, setWorkspaceRoot] = createSignal<string | null>(null)
  const [unrestrictedRoot, setUnrestrictedRoot] = createSignal<boolean>(false)

  const nativeDialogsAvailable = supportsNativeDialogs()
  let recentListRef: HTMLDivElement | undefined
 
  const folders = () => recentFolders()
  const isLoading = () => Boolean(props.isLoading)

  // Update selected binary when preferences change
  createEffect(() => {
    const lastUsed = preferences().lastUsedBinary
    if (!lastUsed) return
    setSelectedBinary((current) => (current === lastUsed ? current : lastUsed))
  })


  function scrollToIndex(index: number) {
    const container = recentListRef
    if (!container) return
    const element = container.querySelector(`[data-folder-index="${index}"]`) as HTMLElement | null
    if (!element) return

    const containerRect = container.getBoundingClientRect()
    const elementRect = element.getBoundingClientRect()

    if (elementRect.top < containerRect.top) {
      container.scrollTop -= containerRect.top - elementRect.top
    } else if (elementRect.bottom > containerRect.bottom) {
      container.scrollTop += elementRect.bottom - containerRect.bottom
    }
  }


  function handleKeyDown(e: KeyboardEvent) {
    const normalizedKey = e.key.toLowerCase()
    const isBrowseShortcut = (e.metaKey || e.ctrlKey) && !e.shiftKey && normalizedKey === "n"
    const blockedKeys = [
      "ArrowDown",
      "ArrowUp",
      "PageDown",
      "PageUp",
      "Home",
      "End",
      "Enter",
      "Backspace",
      "Delete",
    ]

    if (isLoading()) {
      if (isBrowseShortcut || blockedKeys.includes(e.key)) {
        e.preventDefault()
      }
      return
    }

    const folderList = folders()

    if (isBrowseShortcut) {
      e.preventDefault()
      void handleBrowse()
      return
    }

    if (folderList.length === 0) return

    if (e.key === "ArrowDown") {
      e.preventDefault()
      const newIndex = Math.min(selectedIndex() + 1, folderList.length - 1)
      setSelectedIndex(newIndex)
      setFocusMode("recent")
      scrollToIndex(newIndex)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      const newIndex = Math.max(selectedIndex() - 1, 0)
      setSelectedIndex(newIndex)
      setFocusMode("recent")
      scrollToIndex(newIndex)
    } else if (e.key === "PageDown") {
      e.preventDefault()
      const pageSize = 5
      const newIndex = Math.min(selectedIndex() + pageSize, folderList.length - 1)
      setSelectedIndex(newIndex)
      setFocusMode("recent")
      scrollToIndex(newIndex)
    } else if (e.key === "PageUp") {
      e.preventDefault()
      const pageSize = 5
      const newIndex = Math.max(selectedIndex() - pageSize, 0)
      setSelectedIndex(newIndex)
      setFocusMode("recent")
      scrollToIndex(newIndex)
    } else if (e.key === "Home") {
      e.preventDefault()
      setSelectedIndex(0)
      setFocusMode("recent")
      scrollToIndex(0)
    } else if (e.key === "End") {
      e.preventDefault()
      const newIndex = folderList.length - 1
      setSelectedIndex(newIndex)
      setFocusMode("recent")
      scrollToIndex(newIndex)
    } else if (e.key === "Enter") {
      e.preventDefault()
      handleEnterKey()
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault()
      if (folderList.length > 0 && focusMode() === "recent") {
        const folder = folderList[selectedIndex()]
        if (folder) {
          handleRemove(folder.path)
        }
      }
    }
  }


  function handleEnterKey() {
    if (isLoading()) return
    const folderList = folders()
    const index = selectedIndex()

    const folder = folderList[index]
    if (folder) {
      handleFolderSelect(folder.path)
    }
  }


  onMount(() => {
    window.addEventListener("keydown", handleKeyDown)
    void getServerMeta()
      .then((meta) => {
        setWorkspaceRoot(meta.workspaceRoot)
        setUnrestrictedRoot(Boolean((meta as { unrestrictedRoot?: boolean }).unrestrictedRoot))
      })
      .catch(() => {
        // ignore
      })

    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown)
    })
  })

  function formatRelativeTime(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) return `${days}d ago`
    if (hours > 0) return `${hours}h ago`
    if (minutes > 0) return `${minutes}m ago`
    return "just now"
  }

  function handleFolderSelect(path: string) {
    if (isLoading()) return
    props.onSelectFolder(path, selectedBinary())
  }
 
  async function handleBrowse() {
    if (isLoading()) return
    setFocusMode("new")
    if (nativeDialogsAvailable) {
      const fallbackPath = folders()[0]?.path
      const selected = await openNativeFolderDialog({
        title: "Select Workspace",
        defaultPath: fallbackPath,
      })
      if (selected) {
        handleFolderSelect(selected)
      }
      return
    }
    setIsFolderBrowserOpen(true)
  }
 
  function handleBrowserSelect(path: string) {
    setIsFolderBrowserOpen(false)
    handleFolderSelect(path)
  }
 
  function handleBinaryChange(binary: string) {

    setSelectedBinary(binary)
  }

  function handleRemove(path: string, e?: Event) {
    if (isLoading()) return
    e?.stopPropagation()
    removeRecentFolder(path)

    const folderList = folders()
    if (selectedIndex() >= folderList.length && folderList.length > 0) {
      setSelectedIndex(folderList.length - 1)
    }
  }


  function getDisplayPath(path: string): string {
    if (path.startsWith("/Users/")) {
      return path.replace(/^\/Users\/[^/]+/, "~")
    }
    return path
  }

  return (
    <>
      <div
        class="flex h-screen w-full items-start justify-center overflow-hidden py-6 px-4 sm:px-6 relative"
        style="background-color: var(--surface-secondary)"
      >
        <div
          class="w-full max-w-3xl h-full px-4 sm:px-8 pb-2 flex flex-col overflow-hidden"
          aria-busy={isLoading() ? "true" : "false"}
        >
          <Show when={props.onOpenRemoteAccess}>
            <div class="absolute top-4 right-6">
              <button
                type="button"
                class="selector-button selector-button-secondary inline-flex items-center justify-center"
                onClick={() => props.onOpenRemoteAccess?.()}
                title="Remote access"
              >
                <MonitorUp class="w-4 h-4" />
              </button>
            </div>
          </Show>
        <div class="mb-6 text-center shrink-0">
          <div class="mb-3 flex justify-center">
            <img src={codeNomadLogo} alt="CodeNomad logo" class="h-32 w-auto sm:h-48" loading="lazy" />
          </div>
          <h1 class="mb-2 text-3xl font-semibold text-primary">CodeNomad</h1>
          <p class="text-base text-secondary">Select a folder to start coding with AI</p>
        </div>

 
          <div class="space-y-4 flex-1 min-h-0 overflow-auto flex flex-col isolate">

            <Show


              when={folders().length > 0}
              fallback={
                <div class="panel panel-empty-state flex-1">
                  <div class="panel-empty-state-icon">
                    <Clock class="w-12 h-12 mx-auto" />
                  </div>
                  <p class="panel-empty-state-title">No Recent Folders</p>
                  <p class="panel-empty-state-description">Browse for a folder to get started</p>
                </div>
              }
            >
              <div class="panel flex flex-col flex-1 min-h-0">
                <div class="panel-header">
                  <h2 class="panel-title">Recent Folders</h2>
                  <p class="panel-subtitle">
                    {folders().length} {folders().length === 1 ? "folder" : "folders"} available
                  </p>
                </div>
                <div class="panel-list panel-list--fill flex-1 min-h-0 overflow-auto" ref={(el) => (recentListRef = el)}>
                  <For each={folders()}>
                    {(folder, index) => (
                      <div
                        class="panel-list-item"
                        classList={{
                          "panel-list-item-highlight": focusMode() === "recent" && selectedIndex() === index(),
                          "panel-list-item-disabled": isLoading(),
                        }}
                      >
                        <div class="flex items-center gap-2 w-full px-1">
                          <button
                            data-folder-index={index()}
                            class="panel-list-item-content flex-1"
                            disabled={isLoading()}
                            onClick={() => handleFolderSelect(folder.path)}
                            onMouseEnter={() => {
                              if (isLoading()) return
                              setFocusMode("recent")
                              setSelectedIndex(index())
                            }}
                          >
                            <div class="flex items-center justify-between gap-3 w-full">
                              <div class="flex-1 min-w-0">
                                <div class="flex items-center gap-2 mb-1">
                                  <Folder class="w-4 h-4 flex-shrink-0 icon-muted" />
                                  <span class="text-sm font-medium truncate text-primary">
                                    {folder.path.split("/").pop()}
                                  </span>
                                </div>
                                <div class="text-xs font-mono truncate pl-6 text-muted">
                                  {getDisplayPath(folder.path)}
                                </div>
                                <div class="text-xs mt-1 pl-6 text-muted">
                                  {formatRelativeTime(folder.lastAccessed)}
                                </div>
                              </div>
                              <Show when={focusMode() === "recent" && selectedIndex() === index()}>
                                <kbd class="kbd">↵</kbd>
                              </Show>
                            </div>
                          </button>
                          <button
                            onClick={(e) => handleRemove(folder.path, e)}
                            disabled={isLoading()}
                            class="p-2 transition-all hover:bg-red-100 dark:hover:bg-red-900/30 opacity-70 hover:opacity-100 rounded"
                            title="Remove from recent"
                          >
                            <Trash2 class="w-3.5 h-3.5 transition-colors icon-muted hover:text-red-600 dark:hover:text-red-400" />
                          </button>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            <div class="panel shrink-0">
               <div class="panel-header hidden sm:block">
                 <h2 class="panel-title">Browse for Folder</h2>
                 <p class="panel-subtitle">Select any folder on your computer</p>
               </div>

               <div class="panel-body space-y-4">
                 <button
                   onClick={() => void handleBrowse()}
                   disabled={props.isLoading}
                   class="button-primary w-full flex items-center justify-center text-sm disabled:cursor-not-allowed"
                   onMouseEnter={() => setFocusMode("new")}
                 >
                   <div class="flex items-center gap-2">
                     <FolderPlus class="w-4 h-4" />
                     <span>{props.isLoading ? "Opening..." : "Browse Folders"}</span>
                   </div>
                   <Kbd shortcut="cmd+n" class="ml-2" />
                 </button>

                 <div class="rounded-lg border border-base bg-surface-secondary p-3 space-y-2">
                   <div class="text-xs text-secondary">
                     <Show when={workspaceRoot()} fallback={<span>Workspace root: unknown</span>}>
                       {(root) => (
                         <span>
                           Workspace root: <span class="font-mono text-muted">{root()}</span>
                           <Show when={unrestrictedRoot()}>
                             <span class="ml-2 neutral-badge">full filesystem</span>
                           </Show>
                         </span>
                       )}
                     </Show>
                     <Show when={!unrestrictedRoot()}>
                       <div class="text-[11px] text-muted mt-1">
                         Tip: paste an absolute path below to open any folder, or start the server with <span class="font-mono">--unrestricted-root</span> to browse the full filesystem.
                       </div>
                     </Show>
                   </div>

                   <div class="flex flex-col gap-2">
                     <input
                       class="selector-search-input"
                       value={manualPath()}
                       onInput={(event) => {
                         setManualPath(event.currentTarget.value)
                         setManualPathError(null)
                       }}
                       placeholder="Open by path…  /Users/you/projects/my-repo"
                       disabled={isLoading()}
                     />
                     <button
                       type="button"
                       class="selector-button selector-button-primary"
                       disabled={isLoading() || manualPath().trim().length === 0}
                       onClick={() => {
                         const value = manualPath().trim()
                         if (!value) {
                           setManualPathError("Enter a folder path")
                           return
                         }
                         handleFolderSelect(value)
                       }}
                     >
                       Open Folder
                     </button>
                     <Show when={manualPathError()}>
                       {(message) => <div class="text-[11px]" style={{ color: "var(--status-error)" }}>{message()}</div>}
                     </Show>
                   </div>
                 </div>
               </div>

              {/* Advanced settings section */}
              <div class="panel-section w-full">
                <button
                  onClick={() => props.onAdvancedSettingsOpen?.()}
                  class="panel-section-header w-full justify-between"
                >
                  <div class="flex items-center gap-2">
                    <Settings class="w-4 h-4 icon-muted" />
                    <span class="text-sm font-medium text-secondary">Advanced Settings</span>
                  </div>
                  <ChevronRight class="w-4 h-4 icon-muted" />
                </button>
              </div>
            </div>
          </div>

          <div class="mt-1 panel panel-footer shrink-0 hidden sm:block">
            <div class="panel-footer-hints">
              <Show when={folders().length > 0}>
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
                  <kbd class="kbd">Del</kbd>
                  <span>Remove</span>
                </div>
              </Show>
              <div class="flex items-center gap-1.5">
                <Kbd shortcut="cmd+n" />
                <span>Browse</span>
              </div>
            </div>
          </div>
        </div>
        <Show when={isLoading()}>
          <div class="folder-loading-overlay">
            <div class="folder-loading-indicator">
              <div class="spinner" />
              <p class="folder-loading-text">Starting instance…</p>
              <p class="folder-loading-subtext">Hang tight while we prepare your workspace.</p>
            </div>
          </div>
        </Show>
      </div>

      <AdvancedSettingsModal
        open={Boolean(props.advancedSettingsOpen)}
        onClose={() => props.onAdvancedSettingsClose?.()}
        selectedBinary={selectedBinary()}
        onBinaryChange={handleBinaryChange}
        isLoading={props.isLoading}
      />

      <DirectoryBrowserDialog
        open={isFolderBrowserOpen()}
        title="Select Workspace"
        description="Select workspace to start coding."
        onClose={() => setIsFolderBrowserOpen(false)}
        onSelect={handleBrowserSelect}
      />
    </>
  )
}

export default FolderSelectionView
