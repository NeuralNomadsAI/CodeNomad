import { For, Show, type Accessor, type Component, type JSX } from "solid-js"

import { MonacoDiffViewer } from "../../../../file-viewer/monaco-diff-viewer"

import DiffToolbar from "../components/DiffToolbar"
import SplitFilePanel from "../components/SplitFilePanel"
import type { DiffContextMode, DiffViewMode } from "../types"

interface ChangesTabProps {
  t: (key: string, vars?: Record<string, any>) => string

  instanceId: string
  activeSessionId: Accessor<string | null>
  activeSessionDiffs: Accessor<any[] | undefined>

  selectedFile: Accessor<string | null>
  onSelectFile: (file: string, closeList: boolean) => void

  diffViewMode: Accessor<DiffViewMode>
  diffContextMode: Accessor<DiffContextMode>
  onViewModeChange: (mode: DiffViewMode) => void
  onContextModeChange: (mode: DiffContextMode) => void

  listOpen: Accessor<boolean>
  onToggleList: () => void
  splitWidth: Accessor<number>
  onResizeMouseDown: (event: MouseEvent) => void
  onResizeTouchStart: (event: TouchEvent) => void
  isPhoneLayout: Accessor<boolean>
}

const ChangesTab: Component<ChangesTabProps> = (props) => {
  const renderContent = (): JSX.Element => {
    const sessionId = props.activeSessionId()

    const hasSession = Boolean(sessionId && sessionId !== "info")
    const diffs = hasSession ? props.activeSessionDiffs() : null

    const sorted = Array.isArray(diffs) ? [...diffs].sort((a, b) => String(a.file || "").localeCompare(String(b.file || ""))) : []
    const totals = sorted.reduce(
      (acc, item) => {
        acc.additions += typeof item.additions === "number" ? item.additions : 0
        acc.deletions += typeof item.deletions === "number" ? item.deletions : 0
        return acc
      },
      { additions: 0, deletions: 0 },
    )

    const mostChanged = sorted.length
      ? sorted.reduce((best, item) => {
          const bestAdd = typeof (best as any)?.additions === "number" ? (best as any).additions : 0
          const bestDel = typeof (best as any)?.deletions === "number" ? (best as any).deletions : 0
          const bestScore = bestAdd + bestDel

          const add = typeof (item as any)?.additions === "number" ? (item as any).additions : 0
          const del = typeof (item as any)?.deletions === "number" ? (item as any).deletions : 0
          const score = add + del

          if (score > bestScore) return item
          if (score < bestScore) return best
          return String(item.file || "").localeCompare(String((best as any)?.file || "")) < 0 ? item : best
        }, sorted[0])
      : null

    // Auto-select the most-changed file if none selected.
    const currentSelected = props.selectedFile()
    const selectedFileData = sorted.find((f) => f.file === currentSelected) || mostChanged

    const scopeKey = `${props.instanceId}:${hasSession ? sessionId : "no-session"}`

    const isBinaryDiff = (item: any) => {
      const before = typeof item?.before === "string" ? item.before : ""
      const after = typeof item?.after === "string" ? item.after : ""
      if (before.length === 0 && after.length === 0) {
        // OpenCode stores empty before/after for binaries.
        return true
      }
      return false
    }

    const emptyViewerMessage = () => {
      if (!hasSession) return props.t("instanceShell.sessionChanges.noSessionSelected")
      if (diffs === undefined) return props.t("instanceShell.sessionChanges.loading")
      if (!Array.isArray(diffs) || diffs.length === 0) return props.t("instanceShell.sessionChanges.empty")
      return props.t("instanceShell.filesShell.viewerEmpty")
    }

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
            when={selectedFileData && hasSession && Array.isArray(diffs) && diffs.length > 0}
            fallback={
              <div class="file-viewer-empty">
                <span class="file-viewer-empty-text">{emptyViewerMessage()}</span>
              </div>
            }
          >
            {(file) => (
              <Show
                when={!isBinaryDiff(file())}
                fallback={
                  <div class="file-viewer-empty">
                    <span class="file-viewer-empty-text">Binary file cannot be displayed</span>
                  </div>
                }
              >
                <MonacoDiffViewer
                  scopeKey={scopeKey}
                  path={String(file().file || "")}
                  before={String((file() as any).before || "")}
                  after={String((file() as any).after || "")}
                  viewMode={props.diffViewMode()}
                  contextMode={props.diffContextMode()}
                />
              </Show>
            )}
          </Show>
        </div>
      </div>
    )

    const renderEmptyList = () => (
      <div class="p-3 text-xs text-secondary">{emptyViewerMessage()}</div>
    )

    const renderListPanel = () => (
      <Show when={sorted.length > 0} fallback={renderEmptyList()}>
        <For each={sorted}>
          {(item) => (
            <div
              class={`file-list-item ${selectedFileData?.file === item.file ? "file-list-item-active" : ""}`}
              onClick={() => {
                props.onSelectFile(item.file, props.isPhoneLayout())
              }}
            >
              <div class="file-list-item-content">
                <div class="file-list-item-path" title={item.file}>
                  <span class="file-path-text">{item.file}</span>
                </div>
                <div class="file-list-item-stats">
                  <span class="file-list-item-additions">+{item.additions}</span>
                  <span class="file-list-item-deletions">-{item.deletions}</span>
                </div>
              </div>
            </div>
          )}
        </For>
      </Show>
    )

    const renderListOverlay = () => (
      <Show when={sorted.length > 0} fallback={renderEmptyList()}>
        <For each={sorted}>
          {(item) => (
            <div
              class={`file-list-item ${selectedFileData?.file === item.file ? "file-list-item-active" : ""}`}
              onClick={() => {
                props.onSelectFile(item.file, true)
              }}
              title={item.file}
            >
              <div class="file-list-item-content">
                <div class="file-list-item-path" title={item.file}>
                  <span class="file-path-text">{item.file}</span>
                </div>
                <div class="file-list-item-stats">
                  <span class="file-list-item-additions">+{item.additions}</span>
                  <span class="file-list-item-deletions">-{item.deletions}</span>
                </div>
              </div>
            </div>
          )}
        </For>
      </Show>
    )

    const headerPath = () => (selectedFileData?.file ? selectedFileData.file : props.t("instanceShell.rightPanel.tabs.changes"))

    return (
      <SplitFilePanel
        header={
          <>
            <span class="files-tab-selected-path" title={headerPath()}>
              <span class="file-path-text">{headerPath()}</span>
            </span>

            <div class="files-tab-stats" style={{ flex: "0 0 auto" }}>
              <span class="files-tab-stat files-tab-stat-additions">
                <span class="files-tab-stat-value">+{totals.additions}</span>
              </span>
              <span class="files-tab-stat files-tab-stat-deletions">
                <span class="files-tab-stat-value">-{totals.deletions}</span>
              </span>
            </div>
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
        overlayAriaLabel="Changes"
      />
    )
  }

  return <>{renderContent()}</>
}

export default ChangesTab
