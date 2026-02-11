import { For, Show, type Accessor, type Component, type JSX } from "solid-js"
import type { File as GitFileStatus } from "@opencode-ai/sdk/v2/client"

import { RefreshCw } from "lucide-solid"

import { MonacoDiffViewer } from "../../../../file-viewer/monaco-diff-viewer"

import DiffToolbar from "../components/DiffToolbar"
import SplitFilePanel from "../components/SplitFilePanel"
import type { DiffContextMode, DiffViewMode } from "../types"

interface GitChangesTabProps {
  t: (key: string, vars?: Record<string, any>) => string

  activeSessionId: Accessor<string | null>

  entries: Accessor<GitFileStatus[] | null>
  statusLoading: Accessor<boolean>
  statusError: Accessor<string | null>

  selectedPath: Accessor<string | null>
  selectedLoading: Accessor<boolean>
  selectedError: Accessor<string | null>
  selectedBefore: Accessor<string | null>
  selectedAfter: Accessor<string | null>
  mostChangedPath: Accessor<string | null>

  scopeKey: Accessor<string>

  diffViewMode: Accessor<DiffViewMode>
  diffContextMode: Accessor<DiffContextMode>
  onViewModeChange: (mode: DiffViewMode) => void
  onContextModeChange: (mode: DiffContextMode) => void

  onOpenFile: (path: string) => void
  onRefresh: () => void

  listOpen: Accessor<boolean>
  onToggleList: () => void
  splitWidth: Accessor<number>
  onResizeMouseDown: (event: MouseEvent) => void
  onResizeTouchStart: (event: TouchEvent) => void
  isPhoneLayout: Accessor<boolean>
}

const GitChangesTab: Component<GitChangesTabProps> = (props) => {
  const renderContent = (): JSX.Element => {
    const sessionId = props.activeSessionId()

    const hasSession = Boolean(sessionId && sessionId !== "info")
    const entries = hasSession ? props.entries() : null

    const sorted = Array.isArray(entries)
      ? [...entries].sort((a, b) => String(a.path || "").localeCompare(String(b.path || "")))
      : []

    const totals = sorted.reduce(
      (acc, item) => {
        acc.additions += typeof item.added === "number" ? item.added : 0
        acc.deletions += typeof item.removed === "number" ? item.removed : 0
        return acc
      },
      { additions: 0, deletions: 0 },
    )

    const nonDeleted = sorted.filter((item) => item && item.status !== "deleted")

    const emptyViewerMessage = () => {
      if (!hasSession) return "Select a session to view changes."
      if (entries === null) return "Loading git changes…"
      if (nonDeleted.length === 0) return "No git changes yet."
      return "No file selected."
    }

    const selectedPath = props.selectedPath()
    const fallbackPath = props.mostChangedPath()
    const selectedEntry =
      sorted.find((item) => item.path === selectedPath) ||
      (fallbackPath ? sorted.find((item) => item.path === fallbackPath) : null)

    const renderViewer = () => (
      <div class="file-viewer-panel flex-1">
        <div class="file-viewer-header">
          <DiffToolbar
            viewMode={props.diffViewMode()}
            contextMode={props.diffContextMode()}
            onViewModeChange={props.onViewModeChange}
            onContextModeChange={props.onContextModeChange}
          />
        </div>
        <div class="file-viewer-content file-viewer-content--monaco">
          <Show
            when={props.selectedLoading()}
            fallback={
              <Show
                when={props.selectedError()}
                fallback={
                  <Show
                    when={
                      selectedEntry &&
                      props.selectedBefore() !== null &&
                      props.selectedAfter() !== null &&
                      selectedEntry.status !== "deleted"
                        ? {
                            path: selectedEntry.path,
                            before: props.selectedBefore() as string,
                            after: props.selectedAfter() as string,
                          }
                        : null
                    }
                    fallback={
                      <div class="file-viewer-empty">
                        <span class="file-viewer-empty-text">{emptyViewerMessage()}</span>
                      </div>
                    }
                  >
                    {(file) => (
                      <MonacoDiffViewer
                        scopeKey={props.scopeKey()}
                        path={String(file().path || "")}
                        before={String((file() as any).before || "")}
                        after={String((file() as any).after || "")}
                        viewMode={props.diffViewMode()}
                        contextMode={props.diffContextMode()}
                      />
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

    const renderEmptyList = () => <div class="p-3 text-xs text-secondary">{emptyViewerMessage()}</div>

    const renderListPanel = () => (
      <Show when={nonDeleted.length > 0} fallback={renderEmptyList()}>
        <For each={sorted}>
          {(item) => (
            <div
              class={`file-list-item ${props.selectedPath() === item.path ? "file-list-item-active" : ""}`}
              onClick={() => {
                props.onOpenFile(item.path)
              }}
            >
              <div class="file-list-item-content">
                <div class="file-list-item-path" title={item.path}>
                  {item.path}
                </div>
                <div class="file-list-item-stats">
                  <Show when={item.status === "deleted"}>
                    <span class="text-[10px] text-secondary">deleted</span>
                  </Show>
                  <Show when={item.status !== "deleted"}>
                    <>
                      <span class="file-list-item-additions">+{item.added}</span>
                      <span class="file-list-item-deletions">-{item.removed}</span>
                    </>
                  </Show>
                </div>
              </div>
            </div>
          )}
        </For>
      </Show>
    )

    const renderListOverlay = () => (
      <Show when={nonDeleted.length > 0} fallback={renderEmptyList()}>
        <For each={sorted}>
          {(item) => (
            <div
              class={`file-list-item ${props.selectedPath() === item.path ? "file-list-item-active" : ""}`}
              onClick={() => props.onOpenFile(item.path)}
              title={item.path}
            >
              <div class="file-list-item-content">
                <div class="file-list-item-path" title={item.path}>
                  {item.path}
                </div>
                <div class="file-list-item-stats">
                  <Show when={item.status === "deleted"}>
                    <span class="text-[10px] text-secondary">deleted</span>
                  </Show>
                  <Show when={item.status !== "deleted"}>
                    <>
                      <span class="file-list-item-additions">+{item.added}</span>
                      <span class="file-list-item-deletions">-{item.removed}</span>
                    </>
                  </Show>
                </div>
              </div>
            </div>
          )}
        </For>
      </Show>
    )

    return (
      <SplitFilePanel
        header={
          <>
            <span class="files-tab-selected-path" title={selectedEntry?.path || "Git Changes"}>
              {selectedEntry?.path || "Git Changes"}
            </span>

            <div class="files-tab-stats" style={{ flex: "0 0 auto" }}>
              <span class="files-tab-stat files-tab-stat-additions">
                <span class="files-tab-stat-value">+{totals.additions}</span>
              </span>
              <span class="files-tab-stat files-tab-stat-deletions">
                <span class="files-tab-stat-value">-{totals.deletions}</span>
              </span>
              <Show when={props.statusError()}>{(err) => <span class="text-error">{err()}</span>}</Show>
            </div>

            <button
              type="button"
              class="files-header-icon-button"
              title={props.t("instanceShell.rightPanel.actions.refresh")}
              aria-label={props.t("instanceShell.rightPanel.actions.refresh")}
              disabled={!hasSession || props.statusLoading() || entries === null}
              style={{ "margin-left": "auto" }}
              onClick={() => props.onRefresh()}
            >
              <RefreshCw class={`h-4 w-4${props.statusLoading() ? " animate-spin" : ""}`} />
            </button>
          </>
        }
        list={{ panel: renderListPanel, overlay: renderListOverlay }}
        viewer={renderViewer()}
        listOpen={props.listOpen()}
        onToggleList={props.onToggleList}
        splitWidth={props.splitWidth()}
        onResizeMouseDown={props.onResizeMouseDown}
        onResizeTouchStart={props.onResizeTouchStart}
        isPhoneLayout={props.isPhoneLayout()}
        overlayAriaLabel="Git Changes"
      />
    )
  }

  return <>{renderContent()}</>
}

export default GitChangesTab
