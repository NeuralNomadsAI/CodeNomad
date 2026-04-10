import { For, Show, Suspense, createMemo, createSignal, lazy, type Accessor, type Component, type JSX } from "solid-js"

import { ChevronDown, ChevronRight, RefreshCw } from "lucide-solid"

import DiffToolbar from "../components/DiffToolbar"
import SplitFilePanel from "../components/SplitFilePanel"
import type { DiffContextMode, DiffViewMode, DiffWordWrapMode, GitChangeEntry, GitChangeListItem } from "../types"
import { buildGitChangeListItems } from "../git-changes-model"

const LazyMonacoDiffViewer = lazy(() =>
  import("../../../../file-viewer/monaco-diff-viewer").then((module) => ({ default: module.MonacoDiffViewer })),
)

interface GitChangesTabProps {
  t: (key: string, vars?: Record<string, any>) => string

  activeSessionId: Accessor<string | null>

  entries: Accessor<GitChangeEntry[] | null>
  statusLoading: Accessor<boolean>
  statusError: Accessor<string | null>

  selectedItemId: Accessor<string | null>
  selectedLoading: Accessor<boolean>
  selectedError: Accessor<string | null>
  selectedBefore: Accessor<string | null>
  selectedAfter: Accessor<string | null>
  mostChangedItemId: Accessor<string | null>

  scopeKey: Accessor<string>

  diffViewMode: Accessor<DiffViewMode>
  diffContextMode: Accessor<DiffContextMode>
  diffWordWrapMode: Accessor<DiffWordWrapMode>
  onViewModeChange: (mode: DiffViewMode) => void
  onContextModeChange: (mode: DiffContextMode) => void
  onWordWrapModeChange: (mode: DiffWordWrapMode) => void

  onOpenFile: (itemId: string) => void
  onRefresh: () => void
  onInsertContext: (item: GitChangeListItem, selection: { startLine: number; endLine: number } | null) => void

  stagedOpen: Accessor<boolean>
  unstagedOpen: Accessor<boolean>
  onToggleStagedOpen: () => void
  onToggleUnstagedOpen: () => void

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

  const sorted = createMemo<GitChangeEntry[]>(() => {
    const list = entries()
    if (!Array.isArray(list)) return []
    return [...list].sort((a, b) => String(a.path || "").localeCompare(String(b.path || "")))
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

  const nonDeleted = createMemo(() => sorted().filter((item) => item && item.status !== "deleted"))

  const listItems = createMemo<GitChangeListItem[]>(() => buildGitChangeListItems(sorted()))
  const nonDeletedItems = createMemo(() => listItems().filter((item) => item && item.status !== "deleted"))
  const stagedItems = createMemo(() => nonDeletedItems().filter((item) => item.section === "staged"))
  const unstagedItems = createMemo(() => nonDeletedItems().filter((item) => item.section === "unstaged"))
  const [lineSelection, setLineSelection] = createSignal<{ startLine: number; endLine: number } | null>(null)

  const selectedEntry = createMemo<GitChangeEntry | null>(() => {
    const list = listItems()
    const selectedId = props.selectedItemId()
    const fallbackId = props.mostChangedItemId()
    const found =
      list.find((item) => item.id === selectedId) ||
      (fallbackId ? list.find((item) => item.id === fallbackId) : undefined)
    return found?.entry ?? null
  })

  const selectedItem = createMemo<GitChangeListItem | null>(() => {
    const selectedId = props.selectedItemId()
    if (!selectedId) return null
    return listItems().find((item) => item.id === selectedId) ?? null
  })

  const emptyViewerMessage = createMemo(() => {
    if (!hasSession()) return props.t("instanceShell.gitChanges.noSessionSelected")
    const currentEntries = entries()
    if (currentEntries === null) return props.t("instanceShell.gitChanges.loading")
    if (nonDeletedItems().length === 0) return props.t("instanceShell.gitChanges.empty")
    return props.t("instanceShell.filesShell.viewerEmpty")
  })

  const renderContent = (): JSX.Element => {
    const totalsValue = totals()
    const selected = selectedEntry()
    const nonDeletedList = nonDeletedItems()
    const stagedList = stagedItems()
    const unstagedList = unstagedItems()

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
                      <Suspense
                        fallback={
                          <div class="file-viewer-empty">
                            <span class="file-viewer-empty-text">{props.t("instanceInfo.loading")}</span>
                          </div>
                        }
                      >
                        <LazyMonacoDiffViewer
                          scopeKey={props.scopeKey()}
                          path={String(file().path || "")}
                          before={String((file() as any).before || "")}
                          after={String((file() as any).after || "")}
                          viewMode={props.diffViewMode()}
                          contextMode={props.diffContextMode()}
                          wordWrap={props.diffWordWrapMode()}
                          onSelectionChange={setLineSelection}
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

    const renderListItem = (item: GitChangeListItem) => (
      <div
        class={`file-list-item git-change-list-item ${props.selectedItemId() === item.id ? "file-list-item-active" : ""}`}
        onClick={() => props.onOpenFile(item.id)}
        title={item.path}
      >
        <div class="file-list-item-content">
          <div class="git-change-list-item-text" title={item.path}>
            <span class="git-change-list-item-name">{item.displayName}</span>
            <Show when={item.parentPath}>
              <span class="git-change-list-item-parent">{item.parentPath}</span>
            </Show>
          </div>
          <div class="file-list-item-stats">
            <span class="file-list-item-additions">+{item.additions}</span>
            <span class="file-list-item-deletions">-{item.deletions}</span>
          </div>
        </div>
      </div>
    )

    const renderSection = (
      title: string,
      items: GitChangeListItem[],
      isOpen: boolean,
      onToggle: () => void,
    ) => (
      <div class="git-change-section">
        <button type="button" class="git-change-section-header" onClick={onToggle}>
          <span class="git-change-section-header-main">
            <span class="git-change-section-chevron">
              {isOpen ? <ChevronDown class="h-3.5 w-3.5" /> : <ChevronRight class="h-3.5 w-3.5" />}
            </span>
            <span class="git-change-section-title">{title}</span>
          </span>
          <span class="git-change-section-count">{items.length}</span>
        </button>
        <Show when={isOpen}>
          <div class="git-change-section-items">
            <For each={items}>{(item) => renderListItem(item)}</For>
          </div>
        </Show>
      </div>
    )

    const renderGroupedList = () => (
      <Show when={nonDeletedList.length > 0} fallback={renderEmptyList()}>
        <div class="git-change-sections">
          {renderSection(
            props.t("instanceShell.gitChanges.sections.staged"),
            stagedList,
            props.stagedOpen(),
            props.onToggleStagedOpen,
          )}
          {renderSection(
            props.t("instanceShell.gitChanges.sections.unstaged"),
            unstagedList,
            props.unstagedOpen(),
            props.onToggleUnstagedOpen,
          )}
        </div>
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
              title={props.t("instanceShell.gitChanges.actions.insertContext")}
              aria-label={props.t("instanceShell.gitChanges.actions.insertContext")}
              disabled={!selectedItem()}
              onClick={() => {
                const item = selectedItem()
                if (!item) return
                props.onInsertContext(item, lineSelection())
              }}
            >
              <ChevronRight class="h-4 w-4" />
            </button>

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
        list={{ panel: renderGroupedList, overlay: renderGroupedList }}
        viewer={renderViewer()}
        listOpen={props.listOpen()}
        onToggleList={props.onToggleList}
        splitWidth={props.splitWidth()}
        onResizeMouseDown={props.onResizeMouseDown}
        onResizeTouchStart={props.onResizeTouchStart}
        isPhoneLayout={props.isPhoneLayout()}
        overlayAriaLabel={props.t("instanceShell.rightPanel.tabs.gitChanges")}
      />
    )
  }

  return <>{renderContent()}</>
}

export default GitChangesTab
