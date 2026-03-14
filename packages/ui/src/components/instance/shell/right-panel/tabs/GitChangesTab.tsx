import { For, Show, Suspense, createMemo, lazy, type Accessor, type Component, type JSX } from "solid-js"
import type { File as GitFileStatus } from "@opencode-ai/sdk/v2/client"

import { RefreshCw } from "lucide-solid"

import DiffToolbar from "../components/DiffToolbar"
import SplitFilePanel from "../components/SplitFilePanel"
import type { DiffContextMode, DiffViewMode, DiffWordWrapMode } from "../types"

const LazyMonacoDiffViewer = lazy(() =>
  import("../../../../file-viewer/monaco-diff-viewer").then((module) => ({ default: module.MonacoDiffViewer })),
)

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
  diffWordWrapMode: Accessor<DiffWordWrapMode>
  onViewModeChange: (mode: DiffViewMode) => void
  onContextModeChange: (mode: DiffContextMode) => void
  onWordWrapModeChange: (mode: DiffWordWrapMode) => void

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
  const sessionId = createMemo(() => props.activeSessionId())
  const hasSession = createMemo(() => Boolean(sessionId() && sessionId() !== "info"))
  const entries = createMemo(() => (hasSession() ? props.entries() : null))

  const sorted = createMemo<GitFileStatus[]>(() => {
    const list = entries()
    if (!Array.isArray(list)) return []
    return [...list].sort((a, b) => String(a.path || "").localeCompare(String(b.path || "")))
  })

  const totals = createMemo(() => {
    return sorted().reduce(
      (acc, item) => {
        acc.additions += typeof item.added === "number" ? item.added : 0
        acc.deletions += typeof item.removed === "number" ? item.removed : 0
        return acc
      },
      { additions: 0, deletions: 0 },
    )
  })

  const nonDeleted = createMemo(() => sorted().filter((item) => item && item.status !== "deleted"))

  const selectedEntry = createMemo<GitFileStatus | null>(() => {
    const list = sorted()
    const selectedPath = props.selectedPath()
    const fallbackPath = props.mostChangedPath()
    const found =
      list.find((item) => item.path === selectedPath) ||
      (fallbackPath ? list.find((item) => item.path === fallbackPath) : undefined)
    return found ?? null
  })

  const emptyViewerMessage = createMemo(() => {
    if (!hasSession()) return props.t("instanceShell.sessionChanges.noSessionSelected")
    const currentEntries = entries()
    if (currentEntries === null) return props.t("instanceShell.sessionChanges.loading")
    if (nonDeleted().length === 0) return props.t("instanceShell.sessionChanges.empty")
    return props.t("instanceShell.filesShell.viewerEmpty")
  })

  const renderContent = (): JSX.Element => {
    const totalsValue = totals()
    const selected = selectedEntry()
    const sortedList = sorted()
    const nonDeletedList = nonDeleted()

    const renderViewer = () => (
      <div class="file-viewer-panel flex-1">
        <div class="file-viewer-content file-viewer-content--monaco">
          <Show
            when={props.selectedLoading()}
            fallback={
              <Show
                when={props.selectedError()}
                fallback={
                  <Show
                    when={
                      selected &&
                      props.selectedBefore() !== null &&
                      props.selectedAfter() !== null &&
                      selected.status !== "deleted"
                        ? {
                            path: selected.path,
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
                      <Suspense fallback={<div class="file-viewer-empty"><span class="file-viewer-empty-text">{props.t("instanceShell.sessionChanges.loading")}</span></div>}>
                        <LazyMonacoDiffViewer
                          scopeKey={props.scopeKey()}
                          path={String(file().path || "")}
                          before={String((file() as any).before || "")}
                          after={String((file() as any).after || "")}
                          viewMode={props.diffViewMode()}
                          contextMode={props.diffContextMode()}
                          wordWrap={props.diffWordWrapMode()}
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

    const renderEmptyList = () => <div class="p-3 text-xs text-secondary">{emptyViewerMessage()}</div>

    const renderListPanel = () => (
      <Show when={nonDeletedList.length > 0} fallback={renderEmptyList()}>
        <For each={sortedList}>
          {(item) => (
            <div
              class={`file-list-item ${props.selectedPath() === item.path ? "file-list-item-active" : ""}`}
              onClick={() => {
                props.onOpenFile(item.path)
              }}
            >
              <div class="file-list-item-content">
                <div class="file-list-item-path" title={item.path}>
                  <span class="file-path-text">{item.path}</span>
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
      <Show when={nonDeletedList.length > 0} fallback={renderEmptyList()}>
        <For each={sortedList}>
          {(item) => (
            <div
              class={`file-list-item ${props.selectedPath() === item.path ? "file-list-item-active" : ""}`}
              onClick={() => props.onOpenFile(item.path)}
              title={item.path}
            >
              <div class="file-list-item-content">
                <div class="file-list-item-path" title={item.path}>
                  <span class="file-path-text">{item.path}</span>
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
                <span class="files-tab-selected-path" title={selected?.path || props.t("instanceShell.rightPanel.tabs.gitChanges")}>
                  <span class="file-path-text">{selected?.path || props.t("instanceShell.rightPanel.tabs.gitChanges")}</span>
                </span>

            <div class="files-tab-stats" style={{ flex: "0 0 auto" }}>
              <span class="files-tab-stat files-tab-stat-additions">
                <span class="files-tab-stat-value">+{totalsValue.additions}</span>
              </span>
              <span class="files-tab-stat files-tab-stat-deletions">
                <span class="files-tab-stat-value">-{totalsValue.deletions}</span>
              </span>
              <Show when={props.statusError()}>{(err) => <span class="text-error">{err()}</span>}</Show>
            </div>

            <button
              type="button"
              class="files-header-icon-button"
              title={props.t("instanceShell.rightPanel.actions.refresh")}
              aria-label={props.t("instanceShell.rightPanel.actions.refresh")}
              disabled={!hasSession() || props.statusLoading() || entries() === null}
              style={{ "margin-left": "auto" }}
              onClick={() => props.onRefresh()}
            >
              <RefreshCw class={`h-4 w-4${props.statusLoading() ? " animate-spin" : ""}`} />
            </button>

              <DiffToolbar
                viewMode={props.diffViewMode()}
                contextMode={props.diffContextMode()}
                wordWrapMode={props.diffWordWrapMode()}
                onViewModeChange={props.onViewModeChange}
                onContextModeChange={props.onContextModeChange}
                onWordWrapModeChange={props.onWordWrapModeChange}
              />
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
