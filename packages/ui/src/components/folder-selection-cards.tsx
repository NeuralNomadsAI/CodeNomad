import { Component, createSignal, Show, For, onMount, onCleanup, createEffect } from "solid-js"
import { Folder, Clock, Trash2, FolderOpen, Github, Search, X, Settings, Lock, Loader2 } from "lucide-solid"
import { useConfig } from "../stores/preferences"
import AdvancedSettingsModal from "./advanced-settings-modal"
import DirectoryBrowserDialog from "./directory-browser-dialog"
import Kbd from "./kbd"
import { openNativeFolderDialog, supportsNativeDialogsAsync } from "../lib/native/native-functions"
import eraCodeAnimated from "../images/era-code-animated.gif"
import EraUpgradeBanner from "./era-upgrade-banner"
import { cn } from "../lib/cn"
import {
  isGhCliInstalled,
  isGhCliChecked,
  isGitHubAuthenticated,
  isGitHubLoading,
  githubUsername,
  checkGhCliInstalled as checkGhCli,
  initiateGitHubLogin,
  installGhCli,
} from "../stores/github-auth"
import {
  githubRepos,
  githubOrgs,
  selectedOrg,
  setSelectedOrg,
  fetchRepos,
  fetchOrgs,
  isReposLoading,
  cloneRepo,
  isCloning,
} from "../stores/github-repos"

interface FolderSelectionCardsProps {
  onSelectFolder: (folder: string, binaryPath?: string) => void
  isLoading?: boolean
  advancedSettingsOpen?: boolean
  onAdvancedSettingsOpen?: () => void
  onAdvancedSettingsClose?: () => void
  onOpenFullSettings?: () => void
}

const FolderSelectionCards: Component<FolderSelectionCardsProps> = (props) => {
  const { recentFolders, removeRecentFolder, preferences } = useConfig()
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [focusMode, setFocusMode] = createSignal<"recent" | "new" | null>("recent")
  const [selectedBinary, setSelectedBinary] = createSignal(preferences().lastUsedBinary || "opencode")
  const [isFolderBrowserOpen, setIsFolderBrowserOpen] = createSignal(false)
  const [manualPath, setManualPath] = createSignal("")
  const [manualPathError, setManualPathError] = createSignal<string | null>(null)

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

    // Cmd+, opens full settings
    if ((e.metaKey || e.ctrlKey) && normalizedKey === ",") {
      e.preventDefault()
      props.onOpenFullSettings?.()
      return
    }

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

    // Check GitHub CLI status on mount
    void checkGhCli()

    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown)
    })
  })

  // Load repos and orgs once authenticated
  createEffect(() => {
    if (isGitHubAuthenticated()) {
      void fetchOrgs()
      void fetchRepos()
    }
  })

  // Refetch repos when selected org changes
  createEffect(() => {
    const org = selectedOrg()
    if (isGitHubAuthenticated()) {
      void fetchRepos(org ?? undefined)
    }
  })

  function formatGitHubTime(dateStr: string): string {
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) return `${days}d ago`
    if (hours > 0) return `${hours}h ago`
    if (minutes > 0) return `${minutes}m ago`
    return "just now"
  }

  async function handleCloneRepo(repo: { name: string; cloneUrl?: string; sshUrl?: string; url: string; owner?: { login: string } }) {
    const cloneUrl = repo.sshUrl || repo.cloneUrl || repo.url
    const defaultPath = preferences().defaultClonePath || "~/Projects"
    const expandedPath = defaultPath.replace(/^~/, `/Users/${githubUsername() || "user"}`)
    const targetDir = `${expandedPath}/${repo.name}`

    try {
      const result = await cloneRepo(cloneUrl, targetDir)
      if (result.success && result.path) {
        props.onSelectFolder(result.path)
      }
    } catch {
      // Error is handled by the store
    }
  }

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
    const fallbackPath = folders()[0]?.path
    // Check if native OS dialog is available (Electron, Tauri, or web+localhost)
    const hasNative = await supportsNativeDialogsAsync()
    if (hasNative) {
      const selected = await openNativeFolderDialog({
        title: "Select Workspace",
        defaultPath: fallbackPath,
      })
      if (selected) {
        handleFolderSelect(selected)
      }
      // If user cancelled native dialog, do nothing (don't fall back to custom browser)
      return
    }
    // Only use custom browser when no native dialog is available (e.g., remote web)
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
      <div class="flex flex-col items-center gap-8 py-8 px-4 max-w-[900px] mx-auto w-full">
        {/* Hero section with logo and search */}
        <div class="flex flex-col items-center gap-4 text-center">
          <img src={eraCodeAnimated} alt="Era Code" class="w-[200px] h-auto object-contain" />
          <p class="text-base text-muted-foreground">Your AI-powered coding workspace</p>

          {/* Era upgrade banner */}
          <EraUpgradeBanner class="mt-4" />

          {/* Unified search bar */}
          <div class="w-full max-w-lg mt-4">
            <div class="relative flex items-center">
              <Search class="absolute left-3 w-5 h-5 text-muted-foreground" />
              <input
                class="w-full pl-10 pr-10 py-3 text-base rounded-lg border bg-background border-border text-foreground outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground focus:border-primary focus:ring-[3px] focus:ring-primary/15"
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
                  class="absolute right-3 p-1 rounded text-muted-foreground transition-colors hover:text-foreground hover:bg-accent"
                  onClick={() => setManualPath("")}
                  aria-label="Clear search"
                >
                  <X class="w-4 h-4" />
                </button>
              </Show>
            </div>
            <Show when={manualPathError()}>
              <div class="mt-2 text-sm text-center text-destructive">{manualPathError()}</div>
            </Show>
          </div>
        </div>

        {/* Three cards grid */}
        <div class="grid gap-4 w-full" style={{ "grid-template-columns": "repeat(auto-fit, minmax(260px, 1fr))" }}>
          {/* Recent Folders Card */}
          <div class="flex flex-col rounded-lg border p-4 bg-card border-border min-h-[200px]">
            <div class="flex items-center gap-2 mb-2">
              <Clock class="w-5 h-5 text-primary" />
              <h2 class="text-base font-semibold text-foreground">Recent</h2>
            </div>
            <p class="text-sm mb-4 text-muted-foreground">Quick access to your last projects</p>

            <Show
              when={folders().length > 0}
              fallback={
                <div class="flex-1 flex flex-col items-center justify-center text-center py-4 text-muted-foreground">
                  <p>No recent folders</p>
                  <p class="text-xs text-muted-foreground">Browse for a folder to get started</p>
                </div>
              }
            >
              <div class="flex flex-col gap-1 -mx-2 max-h-[200px] overflow-y-auto" ref={(el) => (recentListRef = el)}>
                <For each={folders().slice(0, 5)}>
                  {(folder, index) => (
                    <div
                      data-folder-index={index()}
                      class={cn(
                        "flex items-center justify-between px-2 py-2 rounded transition-colors text-left w-full cursor-pointer group hover:bg-accent/50",
                        focusMode() === "recent" && selectedIndex() === index() && "bg-accent",
                        isLoading() && "opacity-50 cursor-not-allowed",
                      )}
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
                      <div class="flex items-start gap-2 min-w-0 flex-1">
                        <Folder class="w-4 h-4 flex-shrink-0 mt-0.5 text-muted-foreground" />
                        <div class="flex flex-col min-w-0">
                          <span class="text-sm font-medium truncate text-foreground">{folder.path.split("/").pop()}</span>
                          <span class="text-xs font-mono truncate text-muted-foreground">{getDisplayPath(folder.path)}</span>
                          <span class="text-xs text-muted-foreground">{formatRelativeTime(folder.lastAccessed)}</span>
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleRemove(folder.path, e)
                        }}
                        disabled={isLoading()}
                        class="opacity-0 group-hover:opacity-100 p-1 rounded transition-all text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
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
          <div class="flex flex-col rounded-lg border p-4 bg-card border-border min-h-[200px]">
            <div class="flex items-center gap-2 mb-2">
              <FolderOpen class="w-5 h-5 text-primary" />
              <h2 class="text-base font-semibold text-foreground">Browse</h2>
            </div>
            <p class="text-sm mb-4 text-muted-foreground">Open any folder on your computer</p>

            <div class="flex-1 flex flex-col justify-center">
              <button
                onClick={() => void handleBrowse()}
                disabled={props.isLoading}
                class="w-full py-2.5 px-4 rounded-md text-sm font-medium text-center transition-colors border border-border bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span>{props.isLoading ? "Opening..." : "Browse Folders..."}</span>
              </button>
            </div>
          </div>

          {/* GitHub Card */}
          <div class="flex flex-col rounded-lg border p-4 bg-card border-border min-h-[200px]">
            <div class="flex items-center gap-2 mb-2">
              <Github class="w-5 h-5 text-primary" />
              <h2 class="text-base font-semibold text-foreground">GitHub</h2>
              <Show when={isGitHubAuthenticated() && githubUsername()}>
                <span class="text-xs ml-auto text-muted-foreground">@{githubUsername()}</span>
              </Show>
            </div>
            <p class="text-sm mb-4 text-muted-foreground">Clone or open repositories from GitHub</p>

            <div class="flex-1 flex flex-col justify-center">
              <Show when={isGhCliChecked()} fallback={
                <div class="flex flex-col items-center justify-center gap-3 text-center py-4 text-muted-foreground">
                  <Loader2 class="w-5 h-5 animate-spin" />
                  <p class="text-sm">Checking GitHub CLI...</p>
                </div>
              }>
                <Show when={isGhCliInstalled()} fallback={
                  <div class="flex flex-col items-center justify-center gap-3 text-center py-4 text-muted-foreground">
                    <p class="text-sm">GitHub CLI (gh) is required</p>
                    <button
                      class="w-full py-2.5 px-4 rounded-md text-sm font-medium text-center transition-colors bg-accent text-muted-foreground hover:brightness-110"
                      onClick={() => void installGhCli()}
                    >
                      Install GitHub CLI
                    </button>
                  </div>
                }>
                  <Show when={isGitHubAuthenticated()} fallback={
                    <div class="flex flex-col items-center justify-center gap-3 text-center py-4 text-muted-foreground">
                      <p class="text-sm">Sign in to browse your repositories</p>
                      <button
                        class="w-full py-2.5 px-4 rounded-md text-sm font-medium text-center transition-colors bg-primary text-primary-foreground hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
                        onClick={() => void initiateGitHubLogin()}
                        disabled={isGitHubLoading()}
                      >
                        {isGitHubLoading() ? "Signing in..." : "Sign in with GitHub"}
                      </button>
                    </div>
                  }>
                    {/* Tabbed repo list */}
                    <div class="flex gap-1 mb-2 overflow-x-auto [scrollbar-width:none] [-webkit-scrollbar:none]">
                      <button
                        class={cn(
                          "px-2.5 py-1 text-xs rounded-md whitespace-nowrap transition-colors border cursor-pointer",
                          selectedOrg() === null
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-transparent text-muted-foreground border-border hover:bg-accent",
                        )}
                        onClick={() => setSelectedOrg(null)}
                      >
                        All
                      </button>
                      <For each={githubOrgs()}>
                        {(org) => (
                          <button
                            class={cn(
                              "px-2.5 py-1 text-xs rounded-md whitespace-nowrap transition-colors border cursor-pointer",
                              selectedOrg() === org
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-transparent text-muted-foreground border-border hover:bg-accent",
                            )}
                            onClick={() => setSelectedOrg(org)}
                          >
                            {org}
                          </button>
                        )}
                      </For>
                    </div>
                    <div class="flex flex-col gap-1 max-h-[280px] overflow-y-auto">
                      <Show when={!isReposLoading()} fallback={
                        <div class="flex flex-col items-center justify-center gap-3 text-center py-4 text-muted-foreground">
                          <Loader2 class="w-4 h-4 animate-spin" />
                        </div>
                      }>
                        <Show when={githubRepos().length > 0} fallback={
                          <div class="flex flex-col items-center justify-center gap-3 text-center py-4 text-muted-foreground">
                            <p class="text-sm">No repositories found</p>
                          </div>
                        }>
                          <For each={githubRepos().slice(0, 8)}>
                            {(repo) => (
                              <button
                                class="flex items-center justify-between px-2.5 py-2 rounded-md text-left w-full transition-colors bg-transparent border-none cursor-pointer hover:bg-accent disabled:opacity-50 disabled:cursor-wait"
                                onClick={() => void handleCloneRepo(repo)}
                                disabled={isCloning()}
                              >
                                <div class="flex flex-col gap-0.5 min-w-0">
                                  <span class="text-sm font-medium truncate text-foreground">{repo.name}</span>
                                  <Show when={repo.description}>
                                    <span class="text-xs truncate text-muted-foreground max-w-[200px]">{repo.description}</span>
                                  </Show>
                                </div>
                                <div class="flex items-center gap-1.5 flex-shrink-0 text-muted-foreground">
                                  <Show when={repo.visibility === "private"}>
                                    <Lock class="w-3 h-3" />
                                  </Show>
                                  <span class="text-xs">{formatGitHubTime(repo.updatedAt)}</span>
                                </div>
                              </button>
                            )}
                          </For>
                        </Show>
                      </Show>
                    </div>
                  </Show>
                </Show>
              </Show>
            </div>
          </div>
        </div>

        {/* Keyboard shortcuts footer */}
        <div class="flex items-center justify-center gap-2 flex-wrap text-sm text-muted-foreground">
          <span><Kbd shortcut="cmd+n" /> Browse</span>
          <span class="text-border">·</span>
          <span><Kbd shortcut="cmd+shift+g" /> GitHub</span>
          <span class="text-border">·</span>
          <span><Kbd shortcut="cmd+1" /> - <Kbd shortcut="cmd+9" /> Recent</span>
          <span class="text-border">·</span>
          <button
            class="flex items-center gap-1 transition-colors text-muted-foreground bg-transparent border-none cursor-pointer hover:text-foreground"
            onClick={() => props.onOpenFullSettings?.()}
            title="Settings (Cmd+,)"
          >
            <Settings class="w-4 h-4" />
            <Kbd shortcut="cmd+," />
          </button>
        </div>
      </div>

      <AdvancedSettingsModal
        open={Boolean(props.advancedSettingsOpen)}
        onClose={() => props.onAdvancedSettingsClose?.()}
        selectedBinary={selectedBinary()}
        onBinaryChange={handleBinaryChange}
        isLoading={props.isLoading}
        onOpenFullSettings={props.onOpenFullSettings}
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
