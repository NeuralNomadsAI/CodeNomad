import { For, Show, Suspense, createMemo, lazy, type Accessor, type Component, type JSX } from "solid-js"

import DiffToolbar from "../components/DiffToolbar"
import SplitFilePanel from "../components/SplitFilePanel"
import type { DiffContextMode, DiffViewMode, DiffWordWrapMode } from "../types"

const LazyMonacoDiffViewer = lazy(() =>
  import("../../../../file-viewer/monaco-diff-viewer").then((module) => ({ default: module.MonacoDiffViewer })),
)

interface ChangesTabProps {
  t: (key: string, vars?: Record<string, any>) => string

  instanceId: string
  activeSessionId: Accessor<string | null>
  activeSessionDiffs: Accessor<any[] | undefined>

  selectedFile: Accessor<string | null>
  onSelectFile: (file: string, closeList: boolean) => void

  diffViewMode: Accessor<DiffViewMode>
  diffContextMode: Accessor<DiffContextMode>
  diffWordWrapMode: Accessor<DiffWordWrapMode>
  onViewModeChange: (mode: DiffViewMode) => void
  onContextModeChange: (mode: DiffContextMode) => void
  onWordWrapModeChange: (mode: DiffWordWrapMode) => void

  listOpen: Accessor<boolean>
  onToggleList: () => void
  splitWidth: Accessor<number>
  onResizeMouseDown: (event: MouseEvent) => void
  onResizeTouchStart: (event: TouchEvent) => void
  isPhoneLayout: Accessor<boolean>
}

const ChangesTab: Component<ChangesTabProps> = (props) => {
  const sessionId = createMemo(() => props.activeSessionId())
  const hasSession = createMemo(() => Boolean(sessionId() && sessionId() !== "info"))
  const diffs = createMemo(() => (hasSession() ? props.activeSessionDiffs() : null))

  const sorted = createMemo<any[]>(() => {
    const list = diffs()
    if (!Array.isArray(list)) return []
    return [...list].sort((a, b) => String(a.file || "").localeCompare(String(b.file || "")))
  })

  const totals = createMemo(() => {
    return sorted().reduce(
      (acc, item) => {
        acc.additions += typeof item.additions === "number" ? item.additions : 0
        acc.deletions += typeof item.deletions === "number" ? item.deletions : 0
        return acc
      },
      { additions: 0, deletions: 0 },
    )
  })

  const mostChanged = createMemo<any | null>(() => {
    const items = sorted()
    if (items.length === 0) return null
    return items.reduce((best, item) => {
      const bestAdd = typeof (best as any)?.additions === "number" ? (best as any).additions : 0
      const bestDel = typeof (best as any)?.deletions === "number" ? (best as any).deletions : 0
      const bestScore = bestAdd + bestDel

      const add = typeof (item as any)?.additions === "number" ? (item as any).additions : 0
      const del = typeof (item as any)?.deletions === "number" ? (item as any).deletions : 0
      const score = add + del

      if (score > bestScore) return item
      if (score < bestScore) return best
      return String(item.file || "").localeCompare(String((best as any)?.file || "")) < 0 ? item : best
    }, items[0])
  })

  const selectedFileData = createMemo<any | null>(() => {
    const currentSelected = props.selectedFile()
    const items = sorted()
    if (currentSelected) {
      const match = items.find((f) => f.file === currentSelected)
      if (match) return match
    }
    return mostChanged()
  })

  const scopeKey = createMemo(() => `${props.instanceId}:${hasSession() ? sessionId() : "no-session"}`)

  const emptyViewerMessage = createMemo(() => {
    if (!hasSession()) return props.t("instanceShell.sessionChanges.noSessionSelected")
    const currentDiffs = diffs()
    if (currentDiffs === undefined) return props.t("instanceShell.sessionChanges.loading")
    if (!Array.isArray(currentDiffs) || currentDiffs.length === 0) return props.t("instanceShell.sessionChanges.empty")
    return props.t("instanceShell.filesShell.viewerEmpty")
  })

  const headerPath = createMemo(() => {
    const file = selectedFileData()
    return file?.file ? String(file.file) : props.t("instanceShell.rightPanel.tabs.changes")
  })

  const renderContent = (): JSX.Element => {
    const sortedList = sorted()
    const totalsValue = totals()
    const selected = selectedFileData()

    const renderViewer = () => (
      <div class="file-viewer-panel flex-1">
        <div class="file-viewer-content file-viewer-content--monaco">
          <Show
            when={selected && hasSession() && sortedList.length > 0 ? selected : null}
            fallback={
              <div class="file-viewer-empty">
                <span class="file-viewer-empty-text">{emptyViewerMessage()}</span>
              </div>
            }
          >
            {(file) => (
              <Suspense
                fallback={
                  <div class="file-viewer-empty">
                    <span class="file-viewer-empty-text">{props.t("instanceInfo.loading")}</span>
                  </div>
                }
              >
                <LazyMonacoDiffViewer
                  scopeKey={scopeKey()}
                  path={String(file().file || "")}
                  before={String((file() as any).before || "")}
                  after={String((file() as any).after || "")}
                  viewMode={props.diffViewMode()}
                  contextMode={props.diffContextMode()}
                  wordWrap={props.diffWordWrapMode()}
                />
              </Suspense>
            )}
          </Show>
        </div>
      </div>
    )

    const renderEmptyList = () => (
      <div class="p-3 text-xs text-secondary">{emptyViewerMessage()}</div>
    )

    const renderListPanel = () => (
      <Show when={sortedList.length > 0} fallback={renderEmptyList()}>
        <For each={sortedList}>
          {(item) => (
            <div
              class={`file-list-item ${selected?.file === item.file ? "file-list-item-active" : ""}`}
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
      <Show when={sortedList.length > 0} fallback={renderEmptyList()}>
        <For each={sortedList}>
          {(item) => (
            <div
              class={`file-list-item ${selected?.file === item.file ? "file-list-item-active" : ""}`}
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

    return (
      <SplitFilePanel
        header={
          <>
            <span class="files-tab-selected-path" title={headerPath()}>
              <span class="file-path-text">{headerPath()}</span>
            </span>

            <div class="files-tab-stats" style={{ flex: "0 0 auto" }}>
              <span class="files-tab-stat files-tab-stat-additions">
                <span class="files-tab-stat-value">+{totalsValue.additions}</span>
              </span>
              <span class="files-tab-stat files-tab-stat-deletions">
                <span class="files-tab-stat-value">-{totalsValue.deletions}</span>
              </span>
            </div>

            <div style={{ "margin-left": "auto" }}>
              <DiffToolbar
                viewMode={props.diffViewMode()}
                contextMode={props.diffContextMode()}
                wordWrapMode={props.diffWordWrapMode()}
                onViewModeChange={props.onViewModeChange}
                onContextModeChange={props.onContextModeChange}
                onWordWrapModeChange={props.onWordWrapModeChange}
              />
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
        overlayAriaLabel={props.t("instanceShell.rightPanel.tabs.changes")}
      />
    )
  }

  return <>{renderContent()}</>
}

export default ChangesTab
