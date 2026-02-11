import { For, Show, type Accessor, type Component, type JSX } from "solid-js"
import type { FileNode } from "@opencode-ai/sdk/v2/client"

import { RefreshCw } from "lucide-solid"

import { MonacoFileViewer } from "../../../../file-viewer/monaco-file-viewer"

import SplitFilePanel from "../components/SplitFilePanel"

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

  parentPath: Accessor<string | null>
  scopeKey: Accessor<string>

  onLoadEntries: (path: string) => void
  onOpenFile: (path: string) => void
  onRefresh: () => void

  listOpen: Accessor<boolean>
  onToggleList: () => void
  splitWidth: Accessor<number>
  onResizeMouseDown: (event: MouseEvent) => void
  onResizeTouchStart: (event: TouchEvent) => void
  isPhoneLayout: Accessor<boolean>
}

const FilesTab: Component<FilesTabProps> = (props) => {
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
      if (props.browserLoading() && entriesValue === null) return "Loading files..."
      return "Select a file to preview"
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
                      <MonacoFileViewer scopeKey={props.scopeKey()} path={payload().path} content={payload().content} />
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
              <span class="file-viewer-empty-text">Loading…</span>
            </div>
          </Show>
        </div>
      </div>
    )

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
            </div>
          )}
        </Show>

        <Show when={props.browserLoading() && entriesValue === null}>
          <div class="p-3 text-xs text-secondary">Loading files...</div>
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
                props.onOpenFile(item.path)
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
            </div>
          )}
        </For>
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
                <span>Loading…</span>
              </Show>
              <Show when={props.browserError()}>{(err) => <span class="text-error">{err()}</span>}</Show>
            </div>

            <button
              type="button"
              class="files-header-icon-button"
              title={props.t("instanceShell.rightPanel.actions.refresh")}
              aria-label={props.t("instanceShell.rightPanel.actions.refresh")}
              disabled={props.browserLoading()}
              style={{ "margin-left": "auto" }}
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
        overlayAriaLabel="Files"
      />
    )
  }

  return <>{renderContent()}</>
}

export default FilesTab
