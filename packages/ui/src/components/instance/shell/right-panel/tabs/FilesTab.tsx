import { For, Show, Suspense, createEffect, createSignal, lazy, type Accessor, type Component, type JSX } from "solid-js"
import type { FileNode } from "@opencode-ai/sdk/v2/client"

import { Copy, RefreshCw, Save, Search } from "lucide-solid"

import SplitFilePanel from "../components/SplitFilePanel"
import { copyToClipboard } from "../../../../../lib/clipboard"
import { showToastNotification } from "../../../../../lib/notifications"

const LazyMonacoFileViewer = lazy(() =>
  import("../../../../file-viewer/monaco-file-viewer").then((module) => ({ default: module.MonacoFileViewer })),
)

interface FilesTabProps {
  t: (key: string, vars?: Record<string, any>) => string

  browserPath: Accessor<string>
  browserEntries: Accessor<FileNode[] | null>
  browserLoading: Accessor<boolean>
  browserError: Accessor<string | null>

  browserSelectedPath: Accessor<string | null>
  browserSelectedContent: Accessor<string | null>
  browserSelectedLoading: Accessor<boolean>
  browserSelectedError: Accessor<string | null>
  browserSelectedDirty: Accessor<boolean>
  browserSelectedSaving: Accessor<boolean>

  parentPath: Accessor<string | null>
  scopeKey: Accessor<string>

  onLoadEntries: (path: string) => void
  onRequestOpenFile: (path: string) => void
  onRefresh: () => void
  onSave: (content: string) => void
  onContentChange: (content: string) => void

  listOpen: Accessor<boolean>
  onToggleList: () => void
  splitWidth: Accessor<number>
  onResizeMouseDown: (event: MouseEvent) => void
  onResizeTouchStart: (event: TouchEvent) => void
  isPhoneLayout: Accessor<boolean>
}

const FilesTab: Component<FilesTabProps> = (props) => {
  const [filterQuery, setFilterQuery] = createSignal("")

  createEffect(() => {
    props.browserPath()
    setFilterQuery("")
  })

  const handleSave = () => {
    const content = props.browserSelectedContent()
    if (content !== undefined && content !== null) {
      props.onSave(content)
    }
  }

  const handleCopyPath = async (path: string, event?: MouseEvent) => {
    event?.stopPropagation()
    const ok = await copyToClipboard(path)
    showToastNotification({
      message: ok ? props.t("instanceShell.filesShell.toast.copyPathSuccess") : props.t("instanceShell.filesShell.toast.copyPathError"),
      variant: ok ? "success" : "error",
    })
  }

  const renderContent = (): JSX.Element => {
    const entriesValue = props.browserEntries()
    const entries = entriesValue || []
    const sorted = [...entries].sort((a, b) => {
      const aDir = a.type === "directory" ? 0 : 1
      const bDir = b.type === "directory" ? 0 : 1
      if (aDir !== bDir) return aDir - bDir
      return String(a.name || "").localeCompare(String(b.name || ""))
    })
    const normalizedQuery = filterQuery().trim().toLowerCase()
    const filtered = normalizedQuery
      ? sorted.filter((item) => {
          const name = String(item.name || "").toLowerCase()
          const path = String(item.path || "").toLowerCase()
          return name.includes(normalizedQuery) || path.includes(normalizedQuery)
        })
      : sorted
    const listEmptyMessage = () =>
      normalizedQuery ? props.t("instanceShell.filesShell.search.empty") : props.t("instanceShell.filesShell.listEmpty")

    const parent = props.parentPath()

    const headerDisplayedPath = () => props.browserSelectedPath() || props.browserPath()

    const emptyViewerMessage = () => {
      if (props.browserLoading() && entriesValue === null) return props.t("instanceInfo.loading")
      return props.t("instanceShell.filesShell.viewerEmpty")
    }

    const renderViewer = () => (
      <div class="file-viewer-panel flex-1">
        <div class="file-viewer-content file-viewer-content--monaco">
          <Show
            when={props.browserSelectedLoading()}
            fallback={
              <Show
                when={props.browserSelectedError()}
                fallback={
                  <Show
                    when={
                      props.browserSelectedPath() && props.browserSelectedContent() !== null
                        ? { path: props.browserSelectedPath() as string, content: props.browserSelectedContent() as string }
                        : null
                    }
                    fallback={
                      <div class="file-viewer-empty">
                        <span class="file-viewer-empty-text">{emptyViewerMessage()}</span>
                      </div>
                    }
                  >
                    {(payload) => (
                      <Suspense
                        fallback={
                          <div class="file-viewer-empty">
                            <span class="file-viewer-empty-text">{props.t("instanceInfo.loading")}</span>
                          </div>
                        }
                      >
                        <LazyMonacoFileViewer
                          scopeKey={props.scopeKey()}
                          path={payload().path}
                          content={payload().content}
                          onSave={props.onSave}
                          onContentChange={props.onContentChange}
                        />
                      </Suspense>
                    )}
                  </Show>
                }
              >
                {(err) => (
                  <div class="file-viewer-empty">
                    <span class="file-viewer-empty-text">{err()}</span>
                  </div>
                )}
              </Show>
            }
          >
            <div class="file-viewer-empty">
              <span class="file-viewer-empty-text">{props.t("instanceInfo.loading")}</span>
            </div>
          </Show>
        </div>
      </div>
    )

    const renderList = () => (
      <>
        <div class="file-list-header">
          <span class="file-list-title">{props.t("instanceShell.filesShell.fileListTitle")}</span>
          <span class="file-list-count">{filtered.length}</span>
        </div>

        <div class="px-2 py-2 border-b border-base">
          <div class="selector-input-group">
            <div class="flex items-center gap-2 px-3 text-muted">
              <Search class="w-4 h-4" />
            </div>
            <input
              type="text"
              value={filterQuery()}
              onInput={(event) => setFilterQuery(event.currentTarget.value)}
              placeholder={props.t("instanceShell.filesShell.search.placeholder")}
              aria-label={props.t("instanceShell.filesShell.search.ariaLabel")}
              class="selector-input"
            />
          </div>
        </div>

        <Show when={parent}>
          {(p) => (
            <div class="file-list-item" onClick={() => props.onLoadEntries(p())}>
              <div class="file-list-item-content">
                <div class="file-list-item-path" title={p()}>
                  <span class="file-path-text">..</span>
                </div>
              </div>
            </div>
          )}
        </Show>

        <Show when={props.browserLoading() && entriesValue === null}>
          <div class="p-3 text-xs text-secondary">{props.t("instanceInfo.loading")}</div>
        </Show>

        <Show when={filtered.length > 0} fallback={<div class="p-3 text-xs text-secondary">{listEmptyMessage()}</div>}>
          <For each={filtered}>
          {(item) => (
            <div
              class={`file-list-item ${props.browserSelectedPath() === item.path ? "file-list-item-active" : ""}`}
              onClick={() => {
                if (item.type === "directory") {
                  props.onLoadEntries(item.path)
                  return
                }
                props.onRequestOpenFile(item.path)
              }}
              title={item.path}
            >
              <div class="file-list-item-content">
                <div class="file-list-item-path" title={item.path}>
                  <span class="file-path-text">{item.name}</span>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <div class="file-list-item-stats">
                    <span class="text-[10px] text-secondary">{item.type}</span>
                  </div>
                  <button
                    type="button"
                    class="git-change-row-action"
                    title={props.t("instanceShell.filesShell.actions.copyPath")}
                    aria-label={props.t("instanceShell.filesShell.actions.copyPath")}
                    onClick={(event) => void handleCopyPath(item.path, event)}
                  >
                    <Copy class="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>
          )}
          </For>
        </Show>
      </>
    )

    return (
      <SplitFilePanel
        header={
          <>
            <div class="files-tab-stats">
              <span class="files-tab-stat">
                <span class="files-tab-selected-path" title={headerDisplayedPath()}>
                  <span class="file-path-text">{headerDisplayedPath()}</span>
                </span>
              </span>
              <Show when={props.browserLoading()}>
                <span>{props.t("instanceInfo.loading")}</span>
              </Show>
              <Show when={props.browserError()}>{(err) => <span class="text-error">{err()}</span>}</Show>
            </div>
            <button
              type="button"
              class="files-header-icon-button"
              title={props.t("instanceShell.rightPanel.actions.save") || "Save (Ctrl+S)"}
              aria-label={props.t("instanceShell.rightPanel.actions.save") || "Save"}
              disabled={props.browserSelectedSaving() || !props.browserSelectedDirty()}
              style={{ "margin-inline-start": "auto" }}
              onClick={handleSave}
            >
              <Show when={props.browserSelectedSaving()} fallback={<Save class="h-4 w-4" />}>
                <RefreshCw class="h-4 w-4 animate-spin" />
              </Show>
            </button>
            <button
              type="button"
              class="files-header-icon-button"
              title={props.t("instanceShell.rightPanel.actions.refresh")}
              aria-label={props.t("instanceShell.rightPanel.actions.refresh")}
              disabled={props.browserLoading()}
              onClick={() => props.onRefresh()}
            >
              <RefreshCw class={`h-4 w-4${props.browserLoading() ? " animate-spin" : ""}`} />
            </button>
          </>
        }
        list={{ panel: renderList, overlay: renderList }}
        viewer={renderViewer()}
        listOpen={props.listOpen()}
        onToggleList={props.onToggleList}
        splitWidth={props.splitWidth()}
        onResizeMouseDown={props.onResizeMouseDown}
        onResizeTouchStart={props.onResizeTouchStart}
        isPhoneLayout={props.isPhoneLayout()}
        overlayAriaLabel={props.t("instanceShell.rightPanel.tabs.files")}
      />
    )
  }

  return <>{renderContent()}</>
}

export default FilesTab
