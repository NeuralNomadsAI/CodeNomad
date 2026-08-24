import { createEffect, createMemo, createSignal, lazy, type Accessor, type JSX } from "solid-js"
import type { FileContent, FileNode } from "@opencode-ai/sdk/v2/client"

import type { DiffWordWrapMode, RightPanelTab } from "../types"

import { getRootClient } from "../../../../../stores/opencode-client"
import { getOpenCodeWorkspaceIdForWorktree } from "../../../../../stores/opencode-workspaces"
import { requestData } from "../../../../../lib/opencode-api"
import { serverApi } from "../../../../../lib/api-client"
import { showConfirmDialog } from "../../../../../stores/alerts"
import { showToastNotification } from "../../../../../lib/notifications"
import { writeClientLayoutValue } from "../../../../../stores/client-state"
import {
  RIGHT_PANEL_FILES_LIST_OPEN_NONPHONE_KEY,
  RIGHT_PANEL_FILES_LIST_OPEN_PHONE_KEY,
  RIGHT_PANEL_FILES_SPLIT_WIDTH_KEY,
  RIGHT_PANEL_FILES_WORD_WRAP_KEY,
  readStoredBool,
  readStoredEnum,
} from "../../storage"
import { createSplitResize } from "./split-resize"

const LazyFilesTab = lazy(() => import("./FilesTab"))

interface FilesTabRuntimeOptions {
  t: (key: string, vars?: Record<string, any>) => string
  instanceId: string
  rightPanelTab: Accessor<RightPanelTab>
  worktreeSlug: Accessor<string>
  isPhoneLayout: Accessor<boolean>
  rightDrawerWidth: Accessor<number>
  rightDrawerWidthInitialized: Accessor<boolean>
}

export function createFilesTabRuntime(options: FilesTabRuntimeOptions): () => JSX.Element {
  const [browserPath, setBrowserPath] = createSignal(".")
  const [browserEntries, setBrowserEntries] = createSignal<FileNode[] | null>(null)
  const [browserLoading, setBrowserLoading] = createSignal(false)
  const [browserError, setBrowserError] = createSignal<string | null>(null)
  const [browserSelectedPath, setBrowserSelectedPath] = createSignal<string | null>(null)
  const [browserSelectedContent, setBrowserSelectedContent] = createSignal<string | null>(null)
  const [browserSelectedLoading, setBrowserSelectedLoading] = createSignal(false)
  const [browserSelectedError, setBrowserSelectedError] = createSignal<string | null>(null)
  const [browserSelectedDirty, setBrowserSelectedDirty] = createSignal(false)
  const [browserSelectedSaving, setBrowserSelectedSaving] = createSignal(false)
  const [browserSelectedOriginalContent, setBrowserSelectedOriginalContent] = createSignal<string | null>(null)
  const [filesWordWrapMode, setFilesWordWrapMode] = createSignal<DiffWordWrapMode>(
    readStoredEnum(RIGHT_PANEL_FILES_WORD_WRAP_KEY, ["on", "off"] as const) ?? "off",
  )
  const [filesListOpen, setFilesListOpen] = createSignal(true)
  const [filesListTouched, setFilesListTouched] = createSignal(false)
  const browserClient = createMemo(() => getRootClient(options.instanceId))
  const filesSplit = createSplitResize({
    storageKey: RIGHT_PANEL_FILES_SPLIT_WIDTH_KEY,
    defaultWidth: 320,
    rightDrawerWidth: options.rightDrawerWidth,
    rightDrawerWidthInitialized: options.rightDrawerWidthInitialized,
  })

  const filesListOpenStorageKey = createMemo(() =>
    options.isPhoneLayout() ? RIGHT_PANEL_FILES_LIST_OPEN_PHONE_KEY : RIGHT_PANEL_FILES_LIST_OPEN_NONPHONE_KEY,
  )

  const fileWorkspacePayload = async () => {
    const workspace = await getOpenCodeWorkspaceIdForWorktree(options.instanceId, options.worktreeSlug())
    return workspace ? { workspace } : {}
  }

  createEffect(() => {
    filesListOpenStorageKey()
    const persisted = readStoredBool(filesListOpenStorageKey())
    if (persisted !== null) {
      setFilesListOpen(persisted)
      setFilesListTouched(true)
    } else {
      setFilesListOpen(true)
      setFilesListTouched(false)
    }
  })

  createEffect(() => {
    if (options.rightPanelTab() !== "files") return
    if (filesListTouched()) return
    if (!browserSelectedPath()) setFilesListOpen(true)
  })

  createEffect(() => writeClientLayoutValue(RIGHT_PANEL_FILES_WORD_WRAP_KEY, filesWordWrapMode()))

  createEffect(() => {
    options.worktreeSlug()
    setBrowserPath(".")
    setBrowserEntries(null)
    setBrowserError(null)
    setBrowserSelectedPath(null)
    setBrowserSelectedContent(null)
    setBrowserSelectedError(null)
    setBrowserSelectedLoading(false)
  })

  const normalizeBrowserPath = (input: string) => {
    const raw = String(input || ".").trim()
    if (!raw || raw === "./") return "."
    const cleaned = raw.replace(/\\/g, "/").replace(/\/+$/, "")
    return cleaned === "" ? "." : cleaned
  }

  const getParentPath = (path: string): string | null => {
    const current = normalizeBrowserPath(path)
    if (current === ".") return null
    const parts = current.split("/").filter(Boolean)
    parts.pop()
    return parts.length ? parts.join("/") : "."
  }

  const loadBrowserEntries = async (path: string) => {
    const normalized = normalizeBrowserPath(path)
    setBrowserLoading(true)
    setBrowserError(null)
    try {
      const nodes = await requestData<FileNode[]>(browserClient().file.list({ path: normalized, ...(await fileWorkspacePayload()) }), "file.list")
      setBrowserPath(normalized)
      setBrowserEntries(Array.isArray(nodes) ? nodes : [])
    } catch (error) {
      setBrowserError(error instanceof Error ? error.message : "Failed to load files")
      setBrowserEntries([])
    } finally {
      setBrowserLoading(false)
    }
  }

  const openBrowserFile = async (path: string) => {
    setBrowserSelectedPath(path)
    setBrowserSelectedLoading(true)
    setBrowserSelectedError(null)
    setBrowserSelectedContent(null)
    setBrowserSelectedDirty(false)
    setBrowserSelectedOriginalContent(null)

    if (options.isPhoneLayout()) setFilesListOpen(false)
    try {
      const content = await requestData<FileContent>(browserClient().file.read({ path, ...(await fileWorkspacePayload()) }), "file.read")
      const type = (content as any)?.type
      const encoding = (content as any)?.encoding
      if (type && type !== "text") throw new Error("Binary file cannot be displayed")
      if (encoding === "base64") throw new Error("Binary file cannot be displayed")
      const text = (content as any)?.content
      if (typeof text !== "string") throw new Error("Unsupported file type")
      setBrowserSelectedContent(text)
      setBrowserSelectedOriginalContent(text)
    } catch (error) {
      setBrowserSelectedError(error instanceof Error ? error.message : "Failed to read file")
    } finally {
      setBrowserSelectedLoading(false)
    }
  }

  const saveBrowserFile = async (content: string): Promise<boolean> => {
    const path = browserSelectedPath()
    if (!path) return false

    const originalContent = browserSelectedOriginalContent()
    if (originalContent !== null) {
      try {
        const currentDiskContent = await requestData<FileContent>(
          browserClient().file.read({ path, ...(await fileWorkspacePayload()) }),
          "file.read",
        )
        const diskContent = (currentDiskContent as any)?.content
        if (diskContent !== originalContent && diskContent !== content) {
          const confirmed = await showConfirmDialog(options.t("instanceShell.rightPanel.actions.conflict.message", { path }), {
            variant: "warning",
            confirmLabel: options.t("instanceShell.rightPanel.actions.conflict.confirmLabel"),
            cancelLabel: options.t("instanceShell.rightPanel.actions.conflict.cancelLabel"),
            dismissible: false,
          })
          if (!confirmed) return false
        }
      } catch {
        // If conflict detection fails, keep the existing behavior and try the save.
      }
    }

    setBrowserSelectedSaving(true)
    try {
      await serverApi.writeWorkspaceFile(options.instanceId, path, content, { worktree: options.worktreeSlug() })
      setBrowserSelectedContent(content)
      setBrowserSelectedOriginalContent(content)
      setBrowserSelectedDirty(false)
      showToastNotification({ message: options.t("instanceShell.rightPanel.toast.saveSuccess"), variant: "success" })
      return true
    } catch (error) {
      setBrowserSelectedError(error instanceof Error ? error.message : "Failed to save file")
      showToastNotification({ message: options.t("instanceShell.rightPanel.toast.saveError"), variant: "error" })
      return false
    } finally {
      setBrowserSelectedSaving(false)
    }
  }

  const handleOpenBrowserFileRequest = async (path: string) => {
    if (browserSelectedDirty()) {
      const confirmed = await showConfirmDialog(
        options.t("instanceShell.rightPanel.actions.saveConfirm.message", { path: browserSelectedPath() || "" }),
        {
          variant: "warning",
          confirmLabel: options.t("instanceShell.rightPanel.actions.saveConfirm.confirmLabel"),
          cancelLabel: options.t("instanceShell.rightPanel.actions.saveConfirm.cancelLabel"),
          dismissible: false,
        },
      )
      if (confirmed) {
        const saveSuccess = await saveBrowserFile(browserSelectedContent() || "")
        if (!saveSuccess) return
      } else {
        setBrowserSelectedDirty(false)
      }
    }
    await openBrowserFile(path)
  }

  createEffect(() => {
    if (options.rightPanelTab() !== "files") return
    if (browserLoading()) return
    if (browserEntries() !== null) return
    void loadBrowserEntries(browserPath())
  })

  createEffect(() => {
    if (options.rightPanelTab() === "files") return
    setBrowserSelectedContent(null)
    setBrowserSelectedLoading(false)
    setBrowserSelectedError(null)
    setBrowserSelectedDirty(false)
  })

  const toggleFilesList = () => {
    setFilesListTouched(true)
    setFilesListOpen((current) => {
      const next = !current
      writeClientLayoutValue(filesListOpenStorageKey(), next ? "true" : "false")
      return next
    })
  }

  const refreshFilesTab = async () => {
    if (browserSelectedDirty()) {
      const confirmed = await showConfirmDialog(options.t("instanceShell.rightPanel.actions.refreshDirty.message"), {
        variant: "warning",
        confirmLabel: options.t("instanceShell.rightPanel.actions.refreshDirty.confirmLabel"),
        cancelLabel: options.t("instanceShell.rightPanel.actions.refreshDirty.cancelLabel"),
        dismissible: false,
      })
      if (!confirmed) return
    }

    void loadBrowserEntries(browserPath())
    const selected = browserSelectedPath()
    if (!selected) return

    setBrowserSelectedLoading(true)
    setBrowserSelectedError(null)
    try {
      const content = await requestData<FileContent>(browserClient().file.read({ path: selected, ...(await fileWorkspacePayload()) }), "file.read")
      const type = (content as any)?.type
      const encoding = (content as any)?.encoding
      if (type && type !== "text") throw new Error("Binary file cannot be displayed")
      if (encoding === "base64") throw new Error("Binary file cannot be displayed")
      const text = (content as any)?.content
      if (typeof text !== "string") throw new Error("Unsupported file type")
      setBrowserSelectedContent(text)
      setBrowserSelectedOriginalContent(text)
      setBrowserSelectedDirty(false)
    } catch (error) {
      setBrowserSelectedError(error instanceof Error ? error.message : "Failed to read file")
    } finally {
      setBrowserSelectedLoading(false)
    }
  }

  const browserParentPath = createMemo(() => getParentPath(browserPath()))
  const browserScopeKey = createMemo(() => `${options.instanceId}:${options.worktreeSlug()}`)

  return () => (
    <LazyFilesTab
      t={options.t}
      browserPath={browserPath}
      browserEntries={browserEntries}
      browserLoading={browserLoading}
      browserError={browserError}
      browserSelectedPath={browserSelectedPath}
      browserSelectedContent={browserSelectedContent}
      browserSelectedLoading={browserSelectedLoading}
      browserSelectedError={browserSelectedError}
      browserSelectedDirty={browserSelectedDirty}
      browserSelectedSaving={browserSelectedSaving}
      wordWrapMode={filesWordWrapMode}
      parentPath={browserParentPath}
      scopeKey={browserScopeKey}
      instanceId={options.instanceId}
      worktreeSlug={options.worktreeSlug}
      onLoadEntries={(path: string) => void loadBrowserEntries(path)}
      onRequestOpenFile={(path: string) => void handleOpenBrowserFileRequest(path)}
      onRefresh={() => void refreshFilesTab()}
      onSave={(content: string) => void saveBrowserFile(content)}
      onContentChange={(content: string) => {
        setBrowserSelectedContent(content)
        setBrowserSelectedDirty(true)
      }}
      onWordWrapModeChange={setFilesWordWrapMode}
      listOpen={filesListOpen}
      onToggleList={toggleFilesList}
      splitWidth={filesSplit.splitWidth}
      onResizeMouseDown={filesSplit.onResizeMouseDown}
      onResizeTouchStart={filesSplit.onResizeTouchStart}
      isPhoneLayout={options.isPhoneLayout}
    />
  )
}
