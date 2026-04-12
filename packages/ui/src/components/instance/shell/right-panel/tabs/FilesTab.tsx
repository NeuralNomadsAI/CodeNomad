import { For, Show, Suspense, createSignal, type Accessor, type Component, type JSX } from "solid-js"
import type { FileNode } from "@opencode-ai/sdk/v2/client"

import { RefreshCw, Save, Upload, Download, Trash2, Eye, Code } from "lucide-solid"

import SplitFilePanel from "../components/SplitFilePanel"
import type { FileOperationState } from "../hooks/useFileOperations"
import { filePreviewers, selectPreviewer } from "../../../../file-viewer/registry"
import { isMarkdown } from "../../../../../lib/file-types"

type MdViewMode = "rendered" | "code"

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
  browserSelectedBlobUrl: Accessor<string | null>
  browserSelectedMimeType: Accessor<string | null>

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

  // New file operation props
  onUpload?: (targetPath: string, file: File) => Promise<void>
  onDownload?: (relativePath: string) => Promise<void>
  onDelete?: (relativePath: string) => Promise<void>
  onGetBlobUrl?: (filePath: string) => Promise<string | null>
  operationState?: FileOperationState
  onResetOperation?: () => void
}

const FilesTab: Component<FilesTabProps> = (props) => {
  const [mdViewMode, setMdViewMode] = createSignal<MdViewMode>("rendered")
  const isMarkdownFile = () => {
    const path = props.browserSelectedPath()
    return path ? isMarkdown(path) : false
  }

  const handleSave = () => {
    const content = props.browserSelectedContent()
    if (content !== undefined && content !== null) {
      props.onSave(content)
    }
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

    const parent = props.parentPath()

    const headerDisplayedPath = () => props.browserSelectedPath() || props.browserPath()

    const emptyViewerMessage = () => {
      if (props.browserLoading() && entriesValue === null) return props.t("instanceInfo.loading")
      return props.t("instanceShell.filesShell.viewerEmpty")
    }

    const renderViewer = () => {
      const selectedPath = props.browserSelectedPath()
      const blobUrl = props.browserSelectedBlobUrl()
      const mimeType = props.browserSelectedMimeType()
      const error = props.browserSelectedError()

      if (error) {
        return (
          <div class="file-viewer-empty">
            <span class="file-viewer-empty-text text-error">{error}</span>
          </div>
        )
      }

      if (!selectedPath || props.browserSelectedContent() === null) {
        return (
          <div class="file-viewer-empty">
            <span class="file-viewer-empty-text">{emptyViewerMessage()}</span>
          </div>
        )
      }

      const previewer = selectPreviewer(filePreviewers, selectedPath, mimeType ?? undefined)
      if (!previewer) {
        return (
          <div class="file-viewer-empty">
            <span class="file-viewer-empty-text">{emptyViewerMessage()}</span>
          </div>
        )
      }

      const PreviewerComponent = previewer.component
      return (
        <Suspense
          fallback={
            <div class="file-viewer-empty">
              <span class="file-viewer-empty-text">{props.t("instanceInfo.loading")}</span>
            </div>
          }
        >
          <PreviewerComponent
            path={selectedPath}
            content={props.browserSelectedContent() ?? ""}
            blobUrl={blobUrl ?? undefined}
            mimeType={mimeType ?? undefined}
            scopeKey={props.scopeKey()}
            onSave={props.onSave}
            onContentChange={props.onContentChange}
            onNavigate={(navPath: string) => props.onRequestOpenFile(navPath)}
            onGetBlobUrl={props.onGetBlobUrl}
            initialViewMode={mdViewMode()}
          />
        </Suspense>
      )
    }

    const renderList = () => (
      <>
        <Show when={parent}>
          {(p) => (
            <div class="file-list-item" onClick={() => props.onLoadEntries(p())}>
              <div class="file-list-item-content">
                <div class="file-list-item-path" title={p()}>
                  <span class="file-path-text">..</span>
                </div>
              </div>
              <div class="file-list-item-actions" />
            </div>
          )}
        </Show>

        <Show when={props.browserLoading() && entriesValue === null}>
          <div class="p-3 text-xs text-secondary">{props.t("instanceInfo.loading")}</div>
        </Show>

        <For each={sorted}>
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
                <div class="file-list-item-stats">
                  <span class="text-[10px] text-secondary">{item.type}</span>
                </div>
              </div>
              <div class="file-list-item-actions">
                <Show when={item.type === "file"}>
                  <Show when={props.onDownload}>
                    <button
                      type="button"
                      class="file-action-btn"
                      title={props.t("instanceShell.rightPanel.actions.download")}
                      onClick={(e) => {
                        e.stopPropagation()
                        props.onDownload?.(item.path)
                      }}
                    >
                      <Download class="h-4 w-4" />
                    </button>
                  </Show>
                  <Show when={props.onDelete}>
                    <button
                      type="button"
                      class="file-action-btn delete"
                      title={props.t("instanceShell.rightPanel.actions.delete")}
                      onClick={(e) => {
                        e.stopPropagation()
                        props.onDelete?.(item.path)
                      }}
                    >
                      <Trash2 class="h-4 w-4" />
                    </button>
                  </Show>
                </Show>
              </div>
            </div>
          )}
        </For>
      </>
    )

    return (
      <SplitFilePanel
        header={
          <>
            <button
              type="button"
              class="files-header-icon-button upload-button"
              title={props.t("instanceShell.rightPanel.actions.upload")}
              aria-label={props.t("instanceShell.rightPanel.actions.upload")}
            >
              <Upload class="h-4 w-4" />
              <input
                type="file"
                class="upload-file-input"
                onChange={async (e) => {
                  const file = (e.target as HTMLInputElement).files?.[0]
                  if (file && props.onUpload) {
                    const targetPath = props.browserPath() === "." ? file.name : `${props.browserPath()}/${file.name}`
                    await props.onUpload(targetPath, file)
                  }
                  ;(e.target as HTMLInputElement).value = ""
                }}
              />
            </button>
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
            <Show when={isMarkdownFile()}>
              <button
                type="button"
                class="files-header-icon-button md-view-toggle"
                classList={{ active: mdViewMode() === "rendered" }}
                title={props.t("fileViewer.markdown.rendered")}
                aria-label={props.t("fileViewer.markdown.rendered")}
                onClick={() => setMdViewMode("rendered")}
              >
                <Eye class="h-4 w-4" />
              </button>
              <button
                type="button"
                class="files-header-icon-button md-view-toggle"
                classList={{ active: mdViewMode() === "code" }}
                title={props.t("fileViewer.markdown.code")}
                aria-label={props.t("fileViewer.markdown.code")}
                onClick={() => setMdViewMode("code")}
              >
                <Code class="h-4 w-4" />
              </button>
            </Show>
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
        operationState={props.operationState}
        onResetOperation={props.onResetOperation}
      />
    )
  }

  return <>{renderContent()}</>
}

export default FilesTab
