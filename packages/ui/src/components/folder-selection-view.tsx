import { Component, createSignal, Show, For, onMount, onCleanup, createEffect } from "solid-js"
import { Folder, Clock, Trash2, FolderPlus, Settings, ChevronRight, MonitorUp } from "lucide-solid"
import { useConfig } from "../stores/preferences"
import AdvancedSettingsModal from "./advanced-settings-modal"
import DirectoryBrowserDialog from "./directory-browser-dialog"
import Kbd from "./kbd"
import { openNativeFolderDialog, supportsNativeDialogs } from "../lib/native/native-functions"
import EraUpgradeBanner from "./era-upgrade-banner"

const codeNomadLogo = new URL("../images/EraCode-Icon.png", import.meta.url).href


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
        class="flex h-screen w-full items-center justify-center overflow-auto py-6 px-4 sm:px-6 relative"
        style="background-color: var(--surface-secondary)"
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

        <div
          class="w-full max-w-6xl px-4 sm:px-8"
          aria-busy={isLoading() ? "true" : "false"}
        >
          {/* Three-column grid on wide screens, stacked on narrow */}
          <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 items-center">
            {/* Left column: Recent Folders */}
            <div class="order-2 lg:order-1">
              <Show
                when={folders().length > 0}
                fallback={
                  <div class="panel panel-empty-state py-8">
                    <div class="panel-empty-state-icon">
                      <Clock class="w-10 h-10 mx-auto" />
                    </div>
                    <p class="panel-empty-state-title">No Recent Folders</p>
                    <p class="panel-empty-state-description">Browse for a folder to get started</p>
                  </div>
                }
              >
                <div class="panel flex flex-col min-h-0 max-h-80">
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
            </div>

            {/* Center column: Logo and tagline */}
            <div class="order-1 lg:order-2 text-center py-4">
              <div class="mb-2 flex justify-center">
                <img src={codeNomadLogo} alt="Era Code logo" class="h-28 w-auto sm:h-40" loading="lazy" />
              </div>
              <p class="text-base text-secondary">Select a folder to get started</p>
              
              {/* Era upgrade banner */}
              <div class="mt-4 flex justify-center">
                <EraUpgradeBanner />
              </div>
            </div>

            {/* Right column: Open Folder options */}
            <div class="order-3 flex flex-col gap-4">
              {/* Browse Folders card */}
              <div class="panel">
                <div class="panel-header">
                  <h2 class="panel-title">Open Folder</h2>
                  <p class="panel-subtitle">Select any folder on your computer</p>
                </div>
                <div class="panel-body">
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
                </div>
              </div>

              {/* Open by path card */}
              <div class="panel">
                <div class="panel-header">
                  <h2 class="panel-title">Open by Path</h2>
                  <p class="panel-subtitle">Enter an absolute path to a folder</p>
                </div>
                <div class="panel-body">
                  <div class="flex flex-col gap-2">
                    <input
                      class="selector-search-input"
                      value={manualPath()}
                      onInput={(event) => {
                        setManualPath(event.currentTarget.value)
                        setManualPathError(null)
                      }}
                      placeholder="/Users/you/projects/my-repo"
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

              {/* Advanced settings */}
              <div class="panel">
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

        {/* Keyboard shortcuts footer */}
        <div class="home-shortcuts-footer">
          <div class="home-shortcuts-list">
            <button
              type="button"
              class="home-shortcut-item"
              onClick={() => void handleBrowse()}
              disabled={isLoading()}
            >
              <Kbd shortcut="cmd+n" />
              <span>New Project</span>
            </button>
            <button
              type="button"
              class="home-shortcut-item"
              onClick={() => props.onAdvancedSettingsOpen?.()}
              disabled={isLoading()}
            >
              <Kbd shortcut="cmd+," />
              <span>Settings</span>
            </button>
          </div>
        </div>
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
