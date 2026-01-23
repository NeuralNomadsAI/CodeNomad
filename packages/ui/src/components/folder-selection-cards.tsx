import { Component, createSignal, Show, For, onMount, onCleanup, createEffect } from "solid-js"
import { Folder, Clock, Trash2, FolderOpen, Github, Search, X } from "lucide-solid"
import { useConfig } from "../stores/preferences"
import AdvancedSettingsModal from "./advanced-settings-modal"
import DirectoryBrowserDialog from "./directory-browser-dialog"
import Kbd from "./kbd"
import { openNativeFolderDialog, supportsNativeDialogs } from "../lib/native/native-functions"
import eraCodeAnimated from "../images/era-code-animated.gif"
import EraUpgradeBanner from "./era-upgrade-banner"

interface FolderSelectionCardsProps {
  onSelectFolder: (folder: string, binaryPath?: string) => void
  isLoading?: boolean
  advancedSettingsOpen?: boolean
  onAdvancedSettingsOpen?: () => void
  onAdvancedSettingsClose?: () => void
}

const FolderSelectionCards: Component<FolderSelectionCardsProps> = (props) => {
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
      <div class="home-screen">
        {/* Hero section with logo and search */}
        <div class="home-hero">
          <img src={eraCodeAnimated} alt="Era Code" class="home-animated-logo" />
          <p class="home-subtitle">Your AI-powered coding workspace</p>

          {/* Era upgrade banner */}
          <EraUpgradeBanner class="mt-4" />

          {/* Unified search bar */}
          <div class="home-search-container">
            <div class="home-search">
              <Search class="home-search-icon" />
              <input
                class="home-search-input"
                value={manualPath()}
                onInput={(event) => {
                  setManualPath(event.currentTarget.value)
                  setManualPathError(null)
                }}
                placeholder="Search folders, GitHub repos, or paste a path..."
                disabled={isLoading()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && manualPath().trim()) {
                    handleFolderSelect(manualPath().trim())
                  }
                }}
              />
              <Show when={manualPath().length > 0}>
                <button
                  class="home-search-clear"
                  onClick={() => setManualPath("")}
                  aria-label="Clear search"
                >
                  <X class="w-4 h-4" />
                </button>
              </Show>
            </div>
            <Show when={manualPathError()}>
              <div class="home-search-error">{manualPathError()}</div>
            </Show>
          </div>
        </div>

        {/* Three cards grid */}
        <div class="home-cards">
          {/* Recent Folders Card */}
          <div class="home-card">
            <div class="home-card-header">
              <Clock class="home-card-icon" />
              <h2 class="home-card-title">Recent</h2>
            </div>
            <p class="home-card-description">Quick access to your last projects</p>

            <Show
              when={folders().length > 0}
              fallback={
                <div class="home-card-empty">
                  <p>No recent folders</p>
                  <p class="text-xs text-muted">Browse for a folder to get started</p>
                </div>
              }
            >
              <div class="home-recent-list" ref={(el) => (recentListRef = el)}>
                <For each={folders().slice(0, 5)}>
                  {(folder, index) => (
                    <div
                      data-folder-index={index()}
                      class="home-recent-item group"
                      classList={{
                        "home-recent-item-selected": focusMode() === "recent" && selectedIndex() === index(),
                        "home-recent-item-disabled": isLoading(),
                      }}
                      role="button"
                      tabIndex={isLoading() ? -1 : 0}
                      onClick={() => !isLoading() && handleFolderSelect(folder.path)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          if (!isLoading()) handleFolderSelect(folder.path)
                        }
                      }}
                      onMouseEnter={() => {
                        if (isLoading()) return
                        setFocusMode("recent")
                        setSelectedIndex(index())
                      }}
                    >
                      <div class="home-recent-item-content">
                        <Folder class="home-recent-item-icon" />
                        <div class="home-recent-item-info">
                          <span class="home-recent-item-name">{folder.path.split("/").pop()}</span>
                          <span class="home-recent-item-path">{getDisplayPath(folder.path)}</span>
                          <span class="home-recent-item-time">{formatRelativeTime(folder.lastAccessed)}</span>
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleRemove(folder.path, e)
                        }}
                        disabled={isLoading()}
                        class="home-recent-item-remove"
                        title="Remove from recent"
                      >
                        <Trash2 class="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>

          {/* Browse Card */}
          <div class="home-card home-card-action">
            <div class="home-card-header">
              <FolderOpen class="home-card-icon" />
              <h2 class="home-card-title">Browse</h2>
            </div>
            <p class="home-card-description">Open any folder on your computer</p>

            <div class="home-card-body">
              <button
                onClick={() => void handleBrowse()}
                disabled={props.isLoading}
                class="home-action-button"
              >
                <span>{props.isLoading ? "Opening..." : "Browse Folders..."}</span>
              </button>
            </div>
          </div>

          {/* GitHub Card */}
          <div class="home-card home-card-action">
            <div class="home-card-header">
              <Github class="home-card-icon" />
              <h2 class="home-card-title">GitHub</h2>
            </div>
            <p class="home-card-description">Clone or open repositories from GitHub</p>

            <div class="home-card-body">
              <div class="home-github-placeholder">
                <p>Connect your GitHub account to clone repos</p>
                <button class="home-action-button home-action-button-secondary" disabled>
                  Coming Soon
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Keyboard shortcuts footer */}
        <div class="home-shortcuts">
          <span><Kbd shortcut="cmd+n" /> Browse</span>
          <span class="home-shortcuts-divider">·</span>
          <span><Kbd shortcut="cmd+shift+g" /> GitHub</span>
          <span class="home-shortcuts-divider">·</span>
          <span><Kbd shortcut="cmd+1" /> - <Kbd shortcut="cmd+9" /> Recent</span>
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

export default FolderSelectionCards
