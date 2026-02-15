import { Select } from "@kobalte/core/select"
import { Component, createSignal, Show, For, onMount, onCleanup, createEffect } from "solid-js"
import { Folder, Clock, Trash2, FolderPlus, Settings, ChevronRight, MonitorUp, Star, Languages, ChevronDown, X } from "lucide-solid"
import { useConfig } from "../stores/preferences"
import AdvancedSettingsModal from "./advanced-settings-modal"
import DirectoryBrowserDialog from "./directory-browser-dialog"
import Kbd from "./kbd"
import { ThemeModeToggle } from "./theme-mode-toggle"
import { openNativeFolderDialog, supportsNativeDialogs } from "../lib/native/native-functions"
import VersionPill from "./version-pill"
import { DiscordSymbolIcon, GitHubMarkIcon } from "./brand-icons"
import { githubStars } from "../stores/github-stars"
import { formatCompactCount } from "../lib/formatters"
import { useI18n, type Locale } from "../lib/i18n"

const codeNomadLogo = new URL("../images/CodeNomad-Icon.png", import.meta.url).href


interface FolderSelectionViewProps {
  onSelectFolder: (folder: string, binaryPath?: string) => void
  isLoading?: boolean
  advancedSettingsOpen?: boolean
  onAdvancedSettingsOpen?: () => void
  onAdvancedSettingsClose?: () => void
  onOpenRemoteAccess?: () => void
  onClose?: () => void
}

const FolderSelectionView: Component<FolderSelectionViewProps> = (props) => {
  const { recentFolders, removeRecentFolder, preferences, updatePreferences } = useConfig()
  const { t, locale } = useI18n()
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [focusMode, setFocusMode] = createSignal<"recent" | "new" | null>("recent")
  const [selectedBinary, setSelectedBinary] = createSignal(preferences().lastUsedBinary || "opencode")
  const [isFolderBrowserOpen, setIsFolderBrowserOpen] = createSignal(false)
  const nativeDialogsAvailable = supportsNativeDialogs()
  let recentListRef: HTMLDivElement | undefined

  type LanguageOption = { value: Locale; label: string }

  const languageOptions: LanguageOption[] = [
    { value: "en", label: "English" },
    { value: "es", label: "Español" },
    { value: "fr", label: "Français" },
    { value: "ru", label: "Русский" },
    { value: "ja", label: "日本語" },
    { value: "zh-Hans", label: "简体中文" },
  ]

  const selectedLanguageOption = () => languageOptions.find((opt) => opt.value === locale()) ?? languageOptions[0]
 
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
    let activeElement: HTMLElement | null = null
    if (typeof document !== "undefined") {
      activeElement = document.activeElement as HTMLElement | null
    }
    const insideModal = activeElement?.closest(".modal-surface") || activeElement?.closest("[role='dialog']")
    const isEditingField =
      activeElement &&
      (["INPUT", "TEXTAREA", "SELECT"].includes(activeElement.tagName) || activeElement.isContentEditable || Boolean(insideModal))

    if (isEditingField) {
      return
    }

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

    if (days > 0) return t("time.relative.daysAgoShort", { count: days })
    if (hours > 0) return t("time.relative.hoursAgoShort", { count: hours })
    if (minutes > 0) return t("time.relative.minutesAgoShort", { count: minutes })
    return t("time.relative.justNow")
  }

  function handleFolderSelect(path: string) {
    if (isLoading()) return
    props.onSelectFolder(path, selectedBinary())
  }

  const openExternalLink = (url: string) => {
    if (typeof window === "undefined") return
    window.open(url, "_blank", "noopener,noreferrer")
  }
 
  async function handleBrowse() {
    if (isLoading()) return
    setFocusMode("new")
    if (nativeDialogsAvailable) {
      const fallbackPath = folders()[0]?.path
      const selected = await openNativeFolderDialog({
        title: t("folderSelection.dialog.title"),
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
    if (!path) return path

    // macOS: /Users/<name>/...
    if (path.startsWith("/Users/")) {
      return path.replace(/^\/Users\/[^/]+/, "~")
    }

    // Linux: /home/<name>/...
    if (path.startsWith("/home/")) {
      return path.replace(/^\/home\/[^/]+/, "~")
    }

    // Windows: C:\Users\<name>\... (and the forward-slash variant)
    if (/^[A-Za-z]:\\Users\\/.test(path)) {
      return path.replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~")
    }
    if (/^[A-Za-z]:\/Users\//.test(path)) {
      return path.replace(/^[A-Za-z]:\/Users\/[^/]+/, "~")
    }

    return path
  }

  function looksLikeWindowsPath(value: string): boolean {
    if (!value) return false
    // Drive letter (C:\...) or UNC (\\server\share\...)
    return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)
  }

  function splitFolderPath(rawPath: string): { baseName: string; dirName: string } {
    if (!rawPath) return { baseName: "", dirName: "" }

    const isWindows = looksLikeWindowsPath(rawPath)
    const trimmed = rawPath.replace(/[\\/]+$/, "")

    // Root edge-cases ("/", "C:\\", "\\\\server\\share\\")
    if (!trimmed) {
      return { baseName: rawPath, dirName: "" }
    }

    if (isWindows && /^[A-Za-z]:$/.test(trimmed)) {
      return { baseName: `${trimmed}\\`, dirName: "" }
    }

    const lastSlash = trimmed.lastIndexOf("/")
    const lastBackslash = isWindows ? trimmed.lastIndexOf("\\") : -1
    const lastSep = Math.max(lastSlash, lastBackslash)

    if (lastSep < 0) {
      return { baseName: trimmed, dirName: "" }
    }

    const baseName = trimmed.slice(lastSep + 1) || trimmed
    const dirName = trimmed.slice(0, lastSep)
    return { baseName, dirName }
  }

  return (
    <>
      <div
        class="flex h-screen w-full items-start justify-center overflow-hidden py-6 px-4 sm:px-6 relative"
        style="background-color: var(--surface-secondary)"
      >
        <div
          class="w-full max-w-5xl h-full px-4 sm:px-8 pb-2 flex flex-col overflow-hidden"
          aria-busy={isLoading() ? "true" : "false"}
        >
          <div class="absolute top-4 left-6">
            <Select<LanguageOption>
              value={selectedLanguageOption()}
              onChange={(value) => {
                if (!value) return
                if (value.value === locale()) return
                updatePreferences({ locale: value.value })
              }}
              options={languageOptions}
              optionValue="value"
              optionTextValue="label"
              itemComponent={(itemProps) => (
                <Select.Item item={itemProps.item} class="selector-option">
                  <Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.label}</Select.ItemLabel>
                </Select.Item>
              )}
            >
              <Select.Trigger
                class="selector-trigger"
                aria-label={t("folderSelection.language.ariaLabel")}
                title={t("folderSelection.language.ariaLabel")}
              >
                <Languages class="w-4 h-4 icon-muted" aria-hidden="true" />
                <div class="flex-1 min-w-0">
                  <Select.Value<LanguageOption>>
                    {(state) => (
                      <span class="selector-trigger-primary selector-trigger-primary--align-left">
                        {state.selectedOption()?.label}
                      </span>
                    )}
                  </Select.Value>
                </div>
                <Select.Icon class="selector-trigger-icon">
                  <ChevronDown class="w-3 h-3" />
                </Select.Icon>
              </Select.Trigger>

              <Select.Portal>
                <Select.Content class="selector-popover min-w-[180px]">
                  <Select.Listbox class="selector-listbox" />
                </Select.Content>
              </Select.Portal>
            </Select>
          </div>
          <div class="absolute top-4 right-6 flex items-center gap-2">
            <ThemeModeToggle class="selector-button selector-button-secondary w-auto p-2 inline-flex items-center justify-center" />
            <Show when={props.onOpenRemoteAccess}>
              <button
                type="button"
                class="selector-button selector-button-secondary w-auto p-2 inline-flex items-center justify-center"
                onClick={() => props.onOpenRemoteAccess?.()}
              >
                  <MonitorUp class="w-4 h-4" />
                </button>
            </Show>
            <Show when={props.onClose}>
              <button
                type="button"
                class="selector-button selector-button-secondary w-auto p-2 inline-flex items-center justify-center"
                onClick={() => props.onClose?.()}
                aria-label={t("app.launchError.close")}
                title={t("app.launchError.closeTitle")}
              >
                <X class="w-4 h-4" />
              </button>
            </Show>
          </div>
          <div class="mb-6 text-center shrink-0">
            <div class="mb-3 flex justify-center">
              <img src={codeNomadLogo} alt={t("folderSelection.logoAlt")} class="h-32 w-auto sm:h-48" loading="lazy" />
            </div>
            <h1 class="mb-2 text-3xl font-semibold text-primary">CodeNomad</h1>
            <div class="mt-3 flex justify-center gap-2">
              <a
                href="https://github.com/NeuralNomadsAI/CodeNomad"
                target="_blank"
                rel="noreferrer"
                class="selector-button selector-button-secondary w-auto p-2 inline-flex items-center justify-center"
                aria-label={t("folderSelection.links.github")}
                title={t("folderSelection.links.github")}
                onClick={(event) => {
                  event.preventDefault()
                  openExternalLink("https://github.com/NeuralNomadsAI/CodeNomad")
                }}
              >
                <GitHubMarkIcon class="w-4 h-4" />
              </a>
              <a
                href="https://github.com/NeuralNomadsAI/CodeNomad"
                target="_blank"
                rel="noreferrer"
                class="selector-button selector-button-secondary w-auto px-3 py-1.5 inline-flex items-center justify-center gap-1.5"
                aria-label={t("folderSelection.links.githubStars")}
                title={t("folderSelection.links.githubStars")}
                onClick={(event) => {
                  event.preventDefault()
                  openExternalLink("https://github.com/NeuralNomadsAI/CodeNomad")
                }}
              >
                <Star class="w-4 h-4" />
                <Show when={githubStars() !== null}>
                  <span class="text-xs font-medium">{formatCompactCount(githubStars()!)}</span>
                </Show>
              </a>
              <a
                href="https://discord.com/channels/1391832426048651334/1458412028325793887/1464701235683917945"
                target="_blank"
                rel="noreferrer"
                class="selector-button selector-button-secondary w-auto p-2 inline-flex items-center justify-center"
                aria-label={t("folderSelection.links.discord")}
                title={t("folderSelection.links.discord")}
                onClick={(event) => {
                  event.preventDefault()
                  openExternalLink(
                    "https://discord.com/channels/1391832426048651334/1458412028325793887/1464701235683917945",
                  )
                }}
              >
                <DiscordSymbolIcon class="w-4 h-4" />
              </a>
            </div>
            <p class="mt-3 text-base text-secondary">{t("folderSelection.tagline")}</p>
          </div>

          <div class="flex-1 min-h-0 overflow-hidden flex flex-col gap-4">
            <div class="flex-1 min-h-0 overflow-hidden flex flex-col lg:flex-row gap-4">
              {/* Right column: recent folders */}
              <div class="order-1 lg:order-2 flex flex-col gap-4 flex-1 min-h-0 overflow-hidden">
              <Show
                when={folders().length > 0}
                fallback={
                  <div class="panel panel-empty-state flex-1">
                    <div class="panel-empty-state-icon">
                      <Clock class="w-12 h-12 mx-auto" />
                    </div>
                    <p class="panel-empty-state-title">{t("folderSelection.empty.title")}</p>
                    <p class="panel-empty-state-description">{t("folderSelection.empty.description")}</p>
                  </div>
                }
              >
                <div class="panel flex flex-col flex-1 min-h-0">
                  <div class="panel-header">
                    <h2 class="panel-title">{t("folderSelection.recent.title")}</h2>
                    <p class="panel-subtitle">
                      {t(
                        folders().length === 1
                          ? "folderSelection.recent.subtitle.one"
                          : "folderSelection.recent.subtitle.other",
                        { count: folders().length },
                      )}
                    </p>
                  </div>
                  <div
                    class="panel-list panel-list--fill flex-1 min-h-0 overflow-auto"
                    ref={(el) => (recentListRef = el)}
                  >
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
                                      {splitFolderPath(folder.path).baseName}
                                    </span>
                                  </div>
                                  <div class="flex items-center gap-2 pl-6 text-xs text-muted min-w-0">
                                    <span class="font-mono truncate-start flex-1 min-w-0">
                                      {getDisplayPath(folder.path)}
                                    </span>
                                    <span class="flex-shrink-0">{formatRelativeTime(folder.lastAccessed)}</span>
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
                              title={t("folderSelection.recent.remove")}
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

              {/* Left column: version + browse + advanced settings */}
              <div class="order-2 lg:order-1 flex flex-col gap-4 flex-1 min-h-0">
              <div class="panel shrink-0">
                <div class="panel-header hidden sm:block">
                  <h2 class="panel-title">{t("folderSelection.browse.title")}</h2>
                  <p class="panel-subtitle">{t("folderSelection.browse.subtitle")}</p>
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
                      <span>
                        {props.isLoading
                          ? t("folderSelection.browse.buttonOpening")
                          : t("folderSelection.browse.button")}
                      </span>
                    </div>
                    <Kbd shortcut="cmd+n" class="ml-2 kbd-hint" />
                  </button>
                </div>

                {/* Advanced settings section */}
                <div class="panel-section w-full">
                  <button onClick={() => props.onAdvancedSettingsOpen?.()} class="panel-section-header w-full justify-between">
                    <div class="flex items-center gap-2">
                      <Settings class="w-4 h-4 icon-muted" />
                      <span class="text-sm font-medium text-secondary">{t("folderSelection.advancedSettings")}</span>
                    </div>
                    <ChevronRight class="w-4 h-4 icon-muted" />
                  </button>
                </div>
              </div>

              <div class="panel shrink-0">
                <div class="panel-body flex items-center justify-center">
                  <VersionPill />
                </div>
              </div>
            </div>

            </div>

            <div class="panel panel-footer shrink-0 hidden sm:block keyboard-hints">
              <div class="panel-footer-hints">
                <Show when={folders().length > 0}>
                  <div class="flex items-center gap-1.5">
                    <kbd class="kbd">↑</kbd>
                    <kbd class="kbd">↓</kbd>
                    <span>{t("folderSelection.hints.navigate")}</span>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <kbd class="kbd">Enter</kbd>
                    <span>{t("folderSelection.hints.select")}</span>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <kbd class="kbd">Del</kbd>
                    <span>{t("folderSelection.hints.remove")}</span>
                  </div>
                </Show>
                <div class="flex items-center gap-1.5">
                  <Kbd shortcut="cmd+n" class="kbd-hint" />
                  <span>{t("folderSelection.hints.browse")}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <Show when={isLoading()}>
          <div class="folder-loading-overlay">
            <div class="folder-loading-indicator">
              <div class="spinner" />
              <p class="folder-loading-text">{t("folderSelection.loading.title")}</p>
              <p class="folder-loading-subtext">{t("folderSelection.loading.subtitle")}</p>
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
        title={t("folderSelection.dialog.title")}
        description={t("folderSelection.dialog.description")}
        onClose={() => setIsFolderBrowserOpen(false)}
        onSelect={handleBrowserSelect}
      />
    </>
  )
}

export default FolderSelectionView
