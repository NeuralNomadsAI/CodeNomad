import { Dialog } from "@kobalte/core/dialog"
import { Select } from "@kobalte/core/select"
import { Component, createSignal, Show, For, onMount, onCleanup, createEffect, createMemo } from "solid-js"
import type { ConnectionProfile, SshConnectionProfile } from "../../../server/src/api-types"
import { Folder, Clock, Trash2, FolderPlus, Settings, ChevronRight, MonitorUp, Star, Languages, ChevronDown, X, Globe, Loader2, Terminal } from "lucide-solid"
import { useConfig } from "../stores/preferences"
import DirectoryBrowserDialog from "./directory-browser-dialog"
import Kbd from "./kbd"
import { openNativeFolderDialog, supportsNativeDialogsInCurrentWindow } from "../lib/native/native-functions"
import { useFolderDrop } from "../lib/hooks/use-folder-drop"
import VersionPill from "./version-pill"
import { DiscordSymbolIcon, GitHubMarkIcon } from "./brand-icons"
import { githubStars } from "../stores/github-stars"
import { formatCompactCount } from "../lib/formatters"
import { useI18n, type Locale } from "../lib/i18n"
import { showAlertDialog } from "../stores/alerts"
import { openSettings, settingsOpen } from "../stores/settings-screen"
import { openExternalUrl } from "../lib/external-url"
import { serverApi } from "../lib/api-client"
import { canOpenRemoteWindows, isTauriHost } from "../lib/runtime-env"
import { openRemoteServerWindow } from "../lib/native/remote-window"

const codeNomadLogo = new URL("../images/CodeNomad-Icon.png", import.meta.url).href
const GITHUB_URL = "https://github.com/NeuralNomadsAI/CodeNomad"
const DISCORD_URL = "https://discord.com/channels/1391832426048651334/1458412028325793887/1464701235683917945"

type HomeTab = "local" | "servers"


interface FolderSelectionViewProps {
  onSelectFolder: (folder: string, binaryPath?: string, options?: { executionProfileId?: string }) => void
  onOpenSidecar?: () => void
  isLoading?: boolean
  onClose?: () => void
}

const FolderSelectionView: Component<FolderSelectionViewProps> = (props) => {
  const {
    recentFolders,
    removeRecentFolder,
    preferences,
    updatePreferences,
    serverSettings,
    executionProfiles,
    defaultExecutionProfileId,
    lastSelectedExecutionProfileId,
    setLastSelectedExecutionProfileId,
    connectionProfiles,
    saveConnectionProfile,
    removeConnectionProfile,
    saveRemoteServerProfile,
    markRemoteServerConnected,
  } = useConfig()
  const { t, locale } = useI18n()
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [focusMode, setFocusMode] = createSignal<"recent" | "new" | null>("recent")
  const [selectedBinary, setSelectedBinary] = createSignal(serverSettings().opencodeBinary || "opencode")
  const [selectedExecutionProfileId, setSelectedExecutionProfileId] = createSignal<string | null>(lastSelectedExecutionProfileId() ?? defaultExecutionProfileId() ?? null)
  const [isFolderBrowserOpen, setIsFolderBrowserOpen] = createSignal(false)
  const [activeTab, setActiveTab] = createSignal<HomeTab>("local")
  const [isServerDialogOpen, setIsServerDialogOpen] = createSignal(false)
  const [serverName, setServerName] = createSignal("")
  const [serverUrl, setServerUrl] = createSignal("")
  const [skipTlsVerify, setSkipTlsVerify] = createSignal(false)
  const [serverDialogError, setServerDialogError] = createSignal<string | null>(null)
  const [isSavingServer, setIsSavingServer] = createSignal(false)
  const [isSshDialogOpen, setIsSshDialogOpen] = createSignal(false)
  const [sshProfileName, setSshProfileName] = createSignal("")
  const [sshHost, setSshHost] = createSignal("")
  const [sshPort, setSshPort] = createSignal("22")
  const [sshRemoteServerPort, setSshRemoteServerPort] = createSignal("9898")
  const [sshUsername, setSshUsername] = createSignal("")
  const [sshRemotePath, setSshRemotePath] = createSignal("")
  const [sshBootstrapScript, setSshBootstrapScript] = createSignal("")
  const [sshDialogError, setSshDialogError] = createSignal<string | null>(null)
  const [isSavingSsh, setIsSavingSsh] = createSignal(false)
  const [connectingServerId, setConnectingServerId] = createSignal<string | null>(null)
  let recentListRef: HTMLDivElement | undefined

  type LanguageOption = { value: Locale; label: string }
  type ExecutionProfileOption = { value: string; label: string; subtitle: string }

  const languageOptions: LanguageOption[] = [
    { value: "en", label: "English" },
    { value: "es", label: "Español" },
    { value: "fr", label: "Français" },
    { value: "ru", label: "Русский" },
    { value: "ja", label: "日本語" },
    { value: "zh-Hans", label: "简体中文" },
    { value: "he", label: "עברית" },
  ]

  const selectedLanguageOption = () => languageOptions.find((opt) => opt.value === locale()) ?? languageOptions[0]
  const executionProfileOptions = createMemo<ExecutionProfileOption[]>(() =>
    executionProfiles().map((profile) => ({
      value: profile.id,
      label: profile.name,
      subtitle: profile.kind,
    })),
  )
  const selectedExecutionProfileOption = createMemo(() => {
    const options = executionProfileOptions()
    const selectedId = selectedExecutionProfileId()
    return options.find((option) => option.value === selectedId) ?? options[0]
  })
  
  const folders = () => recentFolders()
  const serverList = () => connectionProfiles()
  const isLoading = () => Boolean(props.isLoading)
  const canUseRemoteServerWindows = () => canOpenRemoteWindows()

  function getActiveListLength() {
    return activeTab() === "local" ? folders().length : serverList().length
  }

  // Update selected binary when preferences change
  createEffect(() => {
    const lastUsed = serverSettings().opencodeBinary
    if (!lastUsed) return
    setSelectedBinary((current) => (current === lastUsed ? current : lastUsed))
  })

  createEffect(() => {
    const options = executionProfileOptions()
    if (options.length === 0) {
      setSelectedExecutionProfileId(null)
      return
    }

    const defaultId = defaultExecutionProfileId()
    const selectedId = selectedExecutionProfileId()
    const targetId =
      selectedId && options.some((option) => option.value === selectedId)
        ? selectedId
        : lastSelectedExecutionProfileId() && options.some((option) => option.value === lastSelectedExecutionProfileId())
          ? lastSelectedExecutionProfileId()!
        : defaultId && options.some((option) => option.value === defaultId)
          ? defaultId
          : options[0]?.value

    setSelectedExecutionProfileId((current) => (current === targetId ? current : targetId ?? null))
  })

  createEffect(() => {
    const selectedId = selectedExecutionProfileId()
    if (!selectedId) return
    if (lastSelectedExecutionProfileId() === selectedId) return
    setLastSelectedExecutionProfileId(selectedId)
  })


  function scrollToIndex(index: number) {
    const container = recentListRef
    if (!container) return
    const element = container.querySelector(`[data-list-index="${index}"]`) as HTMLElement | null
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
    const blockedKeys = ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", "Enter"]

    if (isLoading()) {
      if (isBrowseShortcut || blockedKeys.includes(e.key)) {
        e.preventDefault()
      }
      return
    }

    if (isBrowseShortcut) {
      e.preventDefault()
      void handleBrowse()
      return
    }

    const listLength = getActiveListLength()
    if (listLength === 0) return

    if (e.key === "ArrowDown") {
      e.preventDefault()
      const newIndex = Math.min(selectedIndex() + 1, listLength - 1)
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
      const newIndex = Math.min(selectedIndex() + pageSize, listLength - 1)
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
      const newIndex = listLength - 1
      setSelectedIndex(newIndex)
      setFocusMode("recent")
      scrollToIndex(newIndex)
    } else if (e.key === "Enter") {
      e.preventDefault()
      handleEnterKey()
    }
  }


  function handleEnterKey() {
    if (isLoading()) return
    const index = selectedIndex()

    if (activeTab() === "local") {
      const folder = folders()[index]
      if (folder) {
        handleFolderSelect(folder.path)
      }
      return
    }

    const server = serverList()[index]
    if (server) {
      void handleConnectSavedConnection(server.id)
    }
  }

  createEffect(() => {
    activeTab()
    if (!canUseRemoteServerWindows() && activeTab() !== "local") {
      setActiveTab("local")
      return
    }
    setSelectedIndex(0)
    setFocusMode("recent")
  })

  createEffect(() => {
    const length = getActiveListLength()
    if (length === 0) {
      setSelectedIndex(0)
      return
    }

    if (selectedIndex() >= length) {
      setSelectedIndex(length - 1)
    }
  })


  onMount(() => {
    window.addEventListener("keydown", handleKeyDown)
    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown)
    })
  })

  function dropTargetBlocked() {
    return isLoading() || isFolderBrowserOpen() || settingsOpen()
  }

  function showInvalidFolderDropAlert() {
    showAlertDialog(t("folderSelection.drop.invalidMessage"), {
      title: t("folderSelection.drop.invalidTitle"),
      variant: "warning",
    })
  }


  const folderDrop = useFolderDrop({
    enabled: () => !dropTargetBlocked(),
    onInvalidDrop: showInvalidFolderDropAlert,
    onDrop: async (paths) => {
      const firstPath = paths[0]
      if (!firstPath) {
        showInvalidFolderDropAlert()
        return
      }
      handleFolderSelect(firstPath)
    },
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
    props.onSelectFolder(path, selectedBinary(), {
      executionProfileId: selectedExecutionProfileId() ?? undefined,
    })
  }

  function resetServerDialog() {
    setServerName("")
    setServerUrl("")
    setSkipTlsVerify(false)
    setServerDialogError(null)
  }

  function openServerDialog() {
    if (!canUseRemoteServerWindows()) return
    resetServerDialog()
    setIsServerDialogOpen(true)
  }

  function resetSshDialog() {
    setSshProfileName("")
    setSshHost("")
    setSshPort("22")
    setSshRemoteServerPort("9898")
    setSshUsername("")
    setSshRemotePath("")
    setSshBootstrapScript("")
    setSshDialogError(null)
  }

  function openSshDialog() {
    if (!canUseRemoteServerWindows()) return
    resetSshDialog()
    setIsSshDialogOpen(true)
  }

  async function probeAndOpenServer(input: { id?: string; name: string; baseUrl: string; skipTlsVerify: boolean }, openWindow: boolean) {
    if (openWindow && !canUseRemoteServerWindows()) {
      throw new Error("Remote server windows can only be opened from a local desktop window")
    }

    const trimmedName = input.name.trim()
    const trimmedUrl = input.baseUrl.trim()
    if (!trimmedName || !trimmedUrl) {
      throw new Error(t("folderSelection.servers.dialog.errorRequired"))
    }

    const probe = await serverApi.probeRemoteServer({
      baseUrl: trimmedUrl,
      skipTlsVerify: input.skipTlsVerify,
    })

    if (!probe.ok) {
      throw new Error(probe.error || t("folderSelection.servers.dialog.errorConnect"))
    }

    const profile = await saveRemoteServerProfile({
      id: input.id,
      name: trimmedName,
      baseUrl: probe.normalizedUrl,
      skipTlsVerify: input.skipTlsVerify,
    })

    if (openWindow) {
      const remoteProxySession =
        isTauriHost() && profile.skipTlsVerify && profile.baseUrl.startsWith("https://")
          ? await serverApi.createRemoteProxySession({
              baseUrl: profile.baseUrl,
              skipTlsVerify: profile.skipTlsVerify,
            })
          : undefined

      try {
        await openRemoteServerWindow(profile, remoteProxySession?.windowUrl, remoteProxySession?.sessionId)
      } catch (error) {
        if (remoteProxySession) {
          void serverApi.deleteRemoteProxySession(remoteProxySession.sessionId).catch(() => {})
        }
        throw error
      }

      await markRemoteServerConnected(profile.id)
    }

    return profile
  }

  async function handleSaveServer(openWindow: boolean) {
    if (isSavingServer()) return
    setIsSavingServer(true)
    setServerDialogError(null)
    try {
      await probeAndOpenServer(
        {
          name: serverName(),
          baseUrl: serverUrl(),
          skipTlsVerify: skipTlsVerify(),
        },
        openWindow,
      )
      setIsServerDialogOpen(false)
      resetServerDialog()
    } catch (error) {
      setServerDialogError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSavingServer(false)
    }
  }

  async function handleConnectSavedConnection(id: string) {
    if (!canUseRemoteServerWindows()) return
    const target = connectionProfiles().find((entry) => entry.id === id)
    if (!target || connectingServerId()) return
    setConnectingServerId(id)
    try {
      if (target.kind === "remote-server") {
        await probeAndOpenServer(target, true)
        return
      }

      await connectSshProfile(target)
    } catch (error) {
      showAlertDialog(error instanceof Error ? error.message : String(error), {
        title: t("folderSelection.servers.errorTitle"),
        variant: "warning",
      })
    } finally {
      setConnectingServerId(null)
    }
  }

  async function handleRemoveSavedConnection(profile: ConnectionProfile) {
    if (profile.kind === "ssh") {
      await serverApi.disconnectSshRemote(profile.id).catch(() => undefined)
    }
    removeConnectionProfile(profile.id)
  }

  function createConnectionProfileId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID()
    }
    return `conn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }

  function buildSshConnectionProfile(): SshConnectionProfile {
    const host = sshHost().trim()
    const profileName = sshProfileName().trim() || host
    const port = sshPort().trim().length > 0 ? Number(sshPort()) : undefined
    const remoteServerPort = sshRemoteServerPort().trim().length > 0 ? Number(sshRemoteServerPort()) : 9898

    return {
      id: createConnectionProfileId(),
      kind: "ssh",
      name: profileName,
      host,
      port,
      remoteServerPort,
      username: sshUsername().trim() || undefined,
      remotePath: sshRemotePath().trim() || undefined,
      bootstrapScript: sshBootstrapScript().trim() || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  async function connectSshProfile(profile: SshConnectionProfile) {
    const result = await serverApi.connectSshRemote({
      connectionProfileId: profile.id,
      name: profile.name,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      remotePath: profile.remotePath,
      remoteServerPort: profile.remoteServerPort,
      bootstrapScript: profile.bootstrapScript,
    })

    const now = new Date().toISOString()
    await saveConnectionProfile({
      ...profile,
      updatedAt: now,
      lastConnectedAt: now,
    })

    await openRemoteServerWindow({
      id: profile.id,
      name: profile.name,
      baseUrl: result.baseUrl,
      skipTlsVerify: false,
    })
  }

  async function handleSaveSsh(openWindow: boolean) {
    if (isSavingSsh()) return
    const host = sshHost().trim()
    const port = sshPort().trim().length > 0 ? Number(sshPort()) : undefined
    const remoteServerPort = sshRemoteServerPort().trim().length > 0 ? Number(sshRemoteServerPort()) : 9898

    if (!host) {
      setSshDialogError(t("folderSelection.ssh.dialog.errorHost"))
      return
    }
    if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
      setSshDialogError(t("folderSelection.ssh.dialog.errorPort"))
      return
    }
    if (!Number.isInteger(remoteServerPort) || remoteServerPort <= 0 || remoteServerPort > 65535) {
      setSshDialogError(t("folderSelection.ssh.dialog.errorRemoteServerPort"))
      return
    }

    setIsSavingSsh(true)
    setSshDialogError(null)
    try {
      const profile = buildSshConnectionProfile()
      await saveConnectionProfile(profile)
      if (openWindow) {
        await connectSshProfile(profile)
      }
      setIsSshDialogOpen(false)
      resetSshDialog()
    } catch (error) {
      setSshDialogError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSavingSsh(false)
    }
  }

  async function handleBrowse() {
    if (isLoading()) return
    setFocusMode("new")
    if (supportsNativeDialogsInCurrentWindow()) {
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
        onDragEnter={folderDrop.bind.onDragEnter}
        onDragOver={folderDrop.bind.onDragOver}
        onDragLeave={folderDrop.bind.onDragLeave}
        onDrop={folderDrop.bind.onDrop}
      >
        <div
          class="w-full max-w-5xl h-full px-4 sm:px-8 pb-2 flex flex-col overflow-hidden"
          aria-busy={isLoading() ? "true" : "false"}
        >
          <div class="absolute top-4" style="inset-inline-start: 1.5rem;">
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
          <div class="absolute top-4 flex items-center gap-2" style="inset-inline-end: 1.5rem;">
            <button
              type="button"
              class="selector-button selector-button-secondary w-auto p-2 inline-flex items-center justify-center"
              onClick={() => openSettings("appearance")}
              aria-label={t("settings.open.title")}
              title={t("settings.open.title")}
            >
              <Settings class="w-4 h-4" />
            </button>
            <Show when={canUseRemoteServerWindows()}>
              <button
                type="button"
                class="selector-button selector-button-secondary w-auto p-2 inline-flex items-center justify-center"
                onClick={() => openSettings("remote")}
                aria-label={t("instanceTabs.remote.ariaLabel")}
                title={t("instanceTabs.remote.title")}
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
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                class="selector-button selector-button-secondary w-auto p-2 inline-flex items-center justify-center"
                aria-label={t("folderSelection.links.github")}
                title={t("folderSelection.links.github")}
                onClick={(event) => {
                  event.preventDefault()
                  void openExternalUrl(GITHUB_URL, "folder-selection")
                }}
              >
                <GitHubMarkIcon class="w-4 h-4" />
              </a>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                class="selector-button selector-button-secondary w-auto px-3 py-1.5 inline-flex items-center justify-center gap-1.5"
                aria-label={t("folderSelection.links.githubStars")}
                title={githubStars() !== null ? `${t("folderSelection.links.githubStars")}: ${githubStars()!.toLocaleString()}` : t("folderSelection.links.githubStars")}
                onClick={(event) => {
                  event.preventDefault()
                  void openExternalUrl(GITHUB_URL, "folder-selection")
                }}
              >
                <Star class="w-4 h-4" />
                <Show when={githubStars() !== null}>
                  <span class="text-xs font-medium">{formatCompactCount(githubStars()!)}</span>
                </Show>
              </a>
              <a
                href={DISCORD_URL}
                target="_blank"
                rel="noreferrer"
                class="selector-button selector-button-secondary w-auto p-2 inline-flex items-center justify-center"
                aria-label={t("folderSelection.links.discord")}
                title={t("folderSelection.links.discord")}
                onClick={(event) => {
                  event.preventDefault()
                  void openExternalUrl(DISCORD_URL, "folder-selection")
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
                <div class="panel flex flex-col flex-1 min-h-0">
                  <div class="panel-header !gap-0 !p-0">
                    <div class={`grid ${canUseRemoteServerWindows() ? "grid-cols-2" : "grid-cols-1"} gap-0 overflow-hidden border border-base rounded-t-lg rounded-b-none`}>
                      <button
                        type="button"
                        class="border-r border-base px-4 py-3 text-left transition-colors"
                        classList={{
                          "text-primary": activeTab() === "local",
                          "text-muted hover:text-secondary": activeTab() !== "local",
                        }}
                        style={{
                          "background-color": "var(--surface-secondary)",
                        }}
                        onClick={() => setActiveTab("local")}
                      >
                        <div
                          class="panel-title text-base"
                          style={{
                            color: activeTab() === "local" ? "var(--text-primary)" : "var(--text-secondary)",
                          }}
                        >
                          {t("folderSelection.recent.title")}
                        </div>
                        <p
                          class="panel-subtitle mt-1"
                          style={{
                            color: activeTab() === "local" ? "var(--text-muted)" : "var(--text-secondary)",
                          }}
                        >
                          {t(
                            folders().length === 1
                              ? "folderSelection.recent.subtitle.one"
                              : "folderSelection.recent.subtitle.other",
                            { count: folders().length },
                          )}
                        </p>
                      </button>
                      <Show when={canUseRemoteServerWindows()}>
                        <button
                          type="button"
                          class="px-4 py-3 text-left transition-colors"
                          classList={{
                            "text-primary": activeTab() === "servers",
                            "text-muted hover:text-secondary": activeTab() !== "servers",
                          }}
                          style={{
                            "background-color": "var(--surface-secondary)",
                          }}
                          onClick={() => setActiveTab("servers")}
                        >
                          <div
                            class="panel-title text-base"
                            style={{
                              color: activeTab() === "servers" ? "var(--text-primary)" : "var(--text-secondary)",
                            }}
                          >
                            {t("folderSelection.tabs.servers")}
                          </div>
                          <p
                            class="panel-subtitle mt-1"
                            style={{
                              color: activeTab() === "servers" ? "var(--text-muted)" : "var(--text-secondary)",
                            }}
                          >
                            {t("folderSelection.servers.count", { count: serverList().length })}
                          </p>
                        </button>
                      </Show>
                    </div>
                  </div>

                  <Show
                    when={activeTab() === "local"}
                    fallback={
                      <Show
                        when={canUseRemoteServerWindows() && serverList().length > 0}
                        fallback={
                          <Show when={canUseRemoteServerWindows()}>
                            <div class="panel-empty-state flex-1">
                              <div class="panel-empty-state-icon">
                                <Globe class="w-12 h-12 mx-auto" />
                              </div>
                              <p class="panel-empty-state-title">{t("folderSelection.servers.empty.title")}</p>
                              <p class="panel-empty-state-description">{t("folderSelection.servers.empty.description")}</p>
                              <button
                                type="button"
                                class="button-primary mt-4 w-auto self-center inline-flex items-center justify-center gap-2 px-4"
                                onClick={openServerDialog}
                              >
                                <Globe class="w-4 h-4" />
                                <span>{t("folderSelection.actions.connectButton")}</span>
                              </button>
                              <button
                                type="button"
                                class="button-primary mt-3 w-auto self-center inline-flex items-center justify-center gap-2 px-4"
                                onClick={openSshDialog}
                              >
                                <Terminal class="w-4 h-4" />
                                <span>{t("folderSelection.actions.connectSshButton")}</span>
                              </button>
                            </div>
                          </Show>
                        }
                      >
                        <div
                          class="panel-list panel-list--fill flex-1 min-h-0 overflow-auto"
                          ref={(el) => (recentListRef = el)}
                        >
                          <For each={serverList()}>
                            {(server, index) => (
                              <div
                                class="panel-list-item"
                                classList={{
                                  "panel-list-item-highlight": focusMode() === "recent" && selectedIndex() === index(),
                                }}
                              >
                                <div class="flex items-center gap-2 w-full px-1">
                                  <button
                                    data-list-index={index()}
                                    class="panel-list-item-content flex-1"
                                    onClick={() => void handleConnectSavedConnection(server.id)}
                                    onMouseEnter={() => {
                                      setFocusMode("recent")
                                      setSelectedIndex(index())
                                    }}
                                  >
                                    <div class="flex items-center justify-between gap-3 w-full">
                                      <div class="flex-1 min-w-0 text-left">
                                        <div class="flex items-center gap-2 mb-1">
                                          <Show when={server.kind === "remote-server"} fallback={<MonitorUp class="w-4 h-4 flex-shrink-0 icon-muted" />}>
                                            <Globe class="w-4 h-4 flex-shrink-0 icon-muted" />
                                          </Show>
                                          <span class="text-sm font-medium truncate text-primary">{server.name}</span>
                                          <span class="text-[10px] uppercase text-muted">{server.kind === "remote-server" ? "server" : "ssh"}</span>
                                        </div>
                                        <div class="flex items-center gap-2 pl-6 text-xs text-muted min-w-0">
                                          <span class="font-mono truncate-start flex-1 min-w-0">
                                            {server.kind === "remote-server"
                                              ? server.baseUrl
                                              : `${server.username ? `${server.username}@` : ""}${server.host}${server.remotePath ? ` · ${server.remotePath}` : ""}`}
                                          </span>
                                        </div>
                                      </div>
                                      <Show when={connectingServerId() === server.id} fallback={<Show when={focusMode() === "recent" && selectedIndex() === index()}><kbd class="kbd">↵</kbd></Show>}>
                                        <Loader2 class="w-4 h-4 animate-spin icon-muted" />
                                      </Show>
                                    </div>
                                  </button>
                                  <button
                                    onClick={() => void handleRemoveSavedConnection(server)}
                                    class="p-2 transition-all hover:bg-red-100 dark:hover:bg-red-900/30 opacity-70 hover:opacity-100 rounded"
                                    title={t("folderSelection.servers.remove")}
                                  >
                                    <Trash2 class="w-3.5 h-3.5 transition-colors icon-muted hover:text-red-600 dark:hover:text-red-400" />
                                  </button>
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    }
                  >
                    <Show
                      when={folders().length > 0}
                      fallback={
                        <div class="panel-empty-state flex-1">
                          <div class="panel-empty-state-icon">
                            <Clock class="w-12 h-12 mx-auto" />
                          </div>
                          <p class="panel-empty-state-title">{t("folderSelection.empty.title")}</p>
                          <p class="panel-empty-state-description">{t("folderSelection.empty.description")}</p>
                        </div>
                      }
                    >
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
                                  data-list-index={index()}
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
                    </Show>
                  </Show>
                </div>

              </div>

              {/* Left column: version + browse + advanced settings */}
              <div class="order-2 lg:order-1 flex flex-col gap-4 flex-1 min-h-0">
              <div class="panel shrink-0">
                <div class="panel-header hidden sm:block">
                  <h2 class="panel-title">{t("folderSelection.actions.title")}</h2>
                  <p class="panel-subtitle">{t("folderSelection.actions.subtitle")}</p>
                </div>

                 <div class="panel-body flex flex-col gap-3">
                  <Show when={executionProfileOptions().length > 0}>
                    <div class="flex flex-col gap-2">
                      <div>
                        <div class="text-sm font-medium text-secondary">{t("folderSelection.executionProfile.label")}</div>
                        <div class="text-xs text-muted">{t("folderSelection.executionProfile.subtitle")}</div>
                      </div>
                      <Select<ExecutionProfileOption>
                        value={selectedExecutionProfileOption()}
                        onChange={(option) => {
                          if (!option) return
                          setSelectedExecutionProfileId(option.value)
                        }}
                        options={executionProfileOptions()}
                        optionValue="value"
                        optionTextValue="label"
                        itemComponent={(itemProps) => (
                          <Select.Item item={itemProps.item} class="selector-option">
                            <div class="flex flex-col">
                              <Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.label}</Select.ItemLabel>
                              <span class="text-xs text-muted uppercase">{itemProps.item.rawValue.subtitle}</span>
                            </div>
                          </Select.Item>
                        )}
                      >
                        <Select.Trigger class="selector-trigger" aria-label={t("folderSelection.executionProfile.label")}>
                          <div class="flex-1 min-w-0 text-left">
                            <Select.Value<ExecutionProfileOption>>
                              {(state) => (
                                <div class="flex flex-col min-w-0">
                                  <span class="selector-trigger-primary selector-trigger-primary--align-left">
                                    {state.selectedOption()?.label}
                                  </span>
                                  <span class="text-xs text-muted uppercase">{state.selectedOption()?.subtitle}</span>
                                </div>
                              )}
                            </Select.Value>
                          </div>
                          <Select.Icon class="selector-trigger-icon">
                            <ChevronDown class="w-3 h-3" />
                          </Select.Icon>
                        </Select.Trigger>

                        <Select.Portal>
                          <Select.Content class="selector-popover">
                            <Select.Listbox class="selector-listbox" />
                          </Select.Content>
                        </Select.Portal>
                      </Select>
                    </div>
                  </Show>

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

                  <button
                    type="button"
                    onClick={() => props.onOpenSidecar?.()}
                    class="button-primary mt-3 w-full flex items-center justify-center text-sm"
                  >
                    <div class="flex items-center gap-2">
                      <MonitorUp class="w-4 h-4" />
                      <span>{t("folderSelection.sidecars.button")}</span>
                    </div>
                  </button>

                  <Show when={canUseRemoteServerWindows()}>
                    <button
                      onClick={openServerDialog}
                      class="button-primary w-full flex items-center justify-center text-sm"
                    >
                      <div class="flex items-center gap-2">
                        <Globe class="w-4 h-4" />
                        <span>{t("folderSelection.actions.connectButton")}</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={openSshDialog}
                      class="button-primary w-full flex items-center justify-center text-sm"
                    >
                      <div class="flex items-center gap-2">
                        <Terminal class="w-4 h-4" />
                        <span>{t("folderSelection.actions.connectSshButton")}</span>
                      </div>
                    </button>
                  </Show>
                </div>

                {/* OpenCode settings section */}
                <div class="panel-section w-full">
                  <button onClick={() => openSettings("opencode")} class="panel-section-header w-full justify-between">
                    <div class="flex items-center gap-2">
                      <Settings class="w-4 h-4 icon-muted" />
                      <span class="text-sm font-medium text-secondary">{t("folderSelection.opencode")}</span>
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
        <Show when={folderDrop.isSupported && folderDrop.isActive() && !dropTargetBlocked()}>
          <div class="folder-drop-overlay" aria-hidden="true">
            <div class="folder-drop-card">
              <FolderPlus class="w-8 h-8 icon-muted" />
              <p class="folder-drop-title">{t("folderSelection.drop.title")}</p>
              <p class="folder-drop-subtext">{t("folderSelection.drop.subtitle")}</p>
            </div>
          </div>
        </Show>
      </div>

      <DirectoryBrowserDialog
        open={isFolderBrowserOpen()}
        title={t("folderSelection.dialog.title")}
        description={t("folderSelection.dialog.description")}
        initialPath={folders()[0]?.path}
        onClose={() => setIsFolderBrowserOpen(false)}
        onSelect={handleBrowserSelect}
      />

      <Dialog open={isServerDialogOpen()} onOpenChange={(open) => !open && setIsServerDialogOpen(false)}>
        <Dialog.Portal>
          <Dialog.Overlay class="modal-overlay" />
          <div class="fixed inset-0 z-[1300] flex items-center justify-center p-4">
            <Dialog.Content class="modal-surface w-full max-w-lg p-6 flex flex-col gap-5" tabIndex={-1}>
              <div>
                <Dialog.Title class="text-xl font-semibold text-primary">
                  {t("folderSelection.servers.dialog.title")}
                </Dialog.Title>
                <Dialog.Description class="text-sm text-secondary mt-2">
                  {t("folderSelection.servers.dialog.description")}
                </Dialog.Description>
              </div>

              <label class="flex flex-col gap-2 text-sm text-secondary">
                <span>{t("folderSelection.servers.dialog.name")}</span>
                <input
                  class="selector-input w-full"
                  value={serverName()}
                  onInput={(event) => setServerName(event.currentTarget.value)}
                  placeholder={t("folderSelection.servers.dialog.namePlaceholder")}
                />
              </label>

              <label class="flex flex-col gap-2 text-sm text-secondary">
                <span>{t("folderSelection.servers.dialog.url")}</span>
                <input
                  class="selector-input w-full"
                  value={serverUrl()}
                  onInput={(event) => setServerUrl(event.currentTarget.value)}
                  placeholder={t("folderSelection.servers.dialog.urlPlaceholder")}
                />
              </label>

              <label class="flex items-start gap-3 text-sm text-secondary">
                <input
                  type="checkbox"
                  checked={skipTlsVerify()}
                  onChange={(event) => setSkipTlsVerify(event.currentTarget.checked)}
                />
                <span>{t("folderSelection.servers.dialog.skipTls")}</span>
              </label>

              <Show when={serverDialogError()}>
                {(message) => <p class="text-sm text-red-500 break-words">{message()}</p>}
              </Show>

              <div class="flex items-center justify-end gap-3">
                <button class="selector-button selector-button-secondary w-auto px-4" onClick={() => setIsServerDialogOpen(false)}>
                  {t("folderSelection.servers.dialog.cancel")}
                </button>
                <button
                  class="selector-button selector-button-secondary w-auto px-4"
                  disabled={isSavingServer()}
                  onClick={() => void handleSaveServer(false)}
                >
                  {t("folderSelection.servers.dialog.save")}
                </button>
                <button
                  class="selector-button selector-button-secondary w-auto px-4"
                  disabled={isSavingServer()}
                  onClick={() => void handleSaveServer(true)}
                >
                  <Show when={isSavingServer()} fallback={<span>{t("folderSelection.servers.dialog.connect")}</span>}>
                    <span class="inline-flex items-center gap-2">
                      <Loader2 class="w-4 h-4 animate-spin" />
                      {t("folderSelection.servers.dialog.connecting")}
                    </span>
                  </Show>
                </button>
              </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog>

      <Dialog open={isSshDialogOpen()} onOpenChange={(open) => !open && setIsSshDialogOpen(false)}>
        <Dialog.Portal>
          <Dialog.Overlay class="modal-overlay" />
          <div class="fixed inset-0 z-[1300] flex items-center justify-center p-4">
            <Dialog.Content class="modal-surface w-full max-w-lg p-6 flex flex-col gap-5" tabIndex={-1}>
              <div>
                <Dialog.Title class="text-xl font-semibold text-primary">
                  {t("folderSelection.ssh.dialog.title")}
                </Dialog.Title>
                <Dialog.Description class="text-sm text-secondary mt-2">
                  {t("folderSelection.ssh.dialog.description")}
                </Dialog.Description>
              </div>

              <label class="flex flex-col gap-2 text-sm text-secondary">
                <span>{t("folderSelection.ssh.dialog.name")}</span>
                <input
                  class="selector-input w-full"
                  value={sshProfileName()}
                  onInput={(event) => setSshProfileName(event.currentTarget.value)}
                  placeholder={t("folderSelection.ssh.dialog.namePlaceholder")}
                />
              </label>

              <label class="flex flex-col gap-2 text-sm text-secondary">
                <span>{t("folderSelection.ssh.dialog.host")}</span>
                <input
                  class="selector-input w-full"
                  value={sshHost()}
                  onInput={(event) => setSshHost(event.currentTarget.value)}
                  placeholder={t("folderSelection.ssh.dialog.hostPlaceholder")}
                />
              </label>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label class="flex flex-col gap-2 text-sm text-secondary">
                  <span>{t("folderSelection.ssh.dialog.port")}</span>
                  <input
                    class="selector-input w-full"
                    value={sshPort()}
                    inputMode="numeric"
                    onInput={(event) => setSshPort(event.currentTarget.value)}
                    placeholder={t("folderSelection.ssh.dialog.portPlaceholder")}
                  />
                </label>

                <label class="flex flex-col gap-2 text-sm text-secondary">
                  <span>{t("folderSelection.ssh.dialog.remoteServerPort")}</span>
                  <input
                    class="selector-input w-full"
                    value={sshRemoteServerPort()}
                    inputMode="numeric"
                    onInput={(event) => setSshRemoteServerPort(event.currentTarget.value)}
                    placeholder={t("folderSelection.ssh.dialog.remoteServerPortPlaceholder")}
                  />
                </label>
              </div>

              <label class="flex flex-col gap-2 text-sm text-secondary">
                <span>{t("folderSelection.ssh.dialog.username")}</span>
                <input
                  class="selector-input w-full"
                  value={sshUsername()}
                  onInput={(event) => setSshUsername(event.currentTarget.value)}
                  placeholder={t("folderSelection.ssh.dialog.usernamePlaceholder")}
                />
              </label>

              <label class="flex flex-col gap-2 text-sm text-secondary">
                <span>{t("folderSelection.ssh.dialog.remotePath")}</span>
                <input
                  class="selector-input w-full"
                  value={sshRemotePath()}
                  onInput={(event) => setSshRemotePath(event.currentTarget.value)}
                  placeholder={t("folderSelection.ssh.dialog.remotePathPlaceholder")}
                />
              </label>

              <label class="flex flex-col gap-2 text-sm text-secondary">
                <span>{t("folderSelection.ssh.dialog.bootstrapScript")}</span>
                <textarea
                  class="selector-input w-full min-h-[8rem]"
                  value={sshBootstrapScript()}
                  onInput={(event) => setSshBootstrapScript(event.currentTarget.value)}
                  placeholder={t("folderSelection.ssh.dialog.bootstrapScriptPlaceholder")}
                />
              </label>

              <Show when={sshDialogError()}>
                {(message) => <p class="text-sm text-red-500 break-words">{message()}</p>}
              </Show>

              <div class="flex items-center justify-end gap-3">
                <button class="selector-button selector-button-secondary w-auto px-4" onClick={() => setIsSshDialogOpen(false)}>
                  {t("folderSelection.ssh.dialog.cancel")}
                </button>
                <button
                  class="selector-button selector-button-secondary w-auto px-4"
                  disabled={isSavingSsh()}
                  onClick={() => void handleSaveSsh(false)}
                >
                  {t("folderSelection.ssh.dialog.save")}
                </button>
                <button
                  class="selector-button selector-button-secondary w-auto px-4"
                  disabled={isSavingSsh()}
                  onClick={() => void handleSaveSsh(true)}
                >
                  <Show when={isSavingSsh()} fallback={<span>{t("folderSelection.ssh.dialog.connect")}</span>}>
                    <span class="inline-flex items-center gap-2">
                      <Loader2 class="w-4 h-4 animate-spin" />
                      {t("folderSelection.ssh.dialog.connecting")}
                    </span>
                  </Show>
                </button>
              </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog>
    </>
  )
}

export default FolderSelectionView
