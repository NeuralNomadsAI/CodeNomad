import {
  For,
  Show,
  Suspense,
  createMemo,
  lazy,
  type Accessor,
  type Component,
  type JSX,
} from "solid-js"

import { ChevronDown, ChevronRight, GitBranch, RefreshCw } from "lucide-solid"

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
  selectedBulkItemIds: Accessor<Set<string>>
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

  onRowClick: (item: GitChangeListItem, event: MouseEvent) => void
  onRefresh: () => void
  onInsertContext: (item: GitChangeListItem, selection: { startLine: number; endLine: number }) => void
  onStageFile: (item: GitChangeListItem) => void
  onUnstageFile: (item: GitChangeListItem) => void
  commitMessage: Accessor<string>
  commitSubmitting: Accessor<boolean>
  onCommitMessageInput: (value: string) => void
  onSubmitCommit: () => void
  branchLabel: Accessor<string | null>

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

  const listItems = createMemo<GitChangeListItem[]>(() => buildGitChangeListItems(sorted()))

  const totals = createMemo(() => {
    return listItems().reduce(
      (acc, item) => {
        acc.additions += typeof item.additions === "number" ? item.additions : 0
        acc.deletions += typeof item.deletions === "number" ? item.deletions : 0
        return acc
      },
      { additions: 0, deletions: 0 },
    )
  })
  const stagedItems = createMemo(() => listItems().filter((item) => item.section === "staged"))
  const unstagedItems = createMemo(() => listItems().filter((item) => item.section === "unstaged"))
  const canCommit = createMemo(() => stagedItems().length > 0 && props.commitMessage().trim().length > 0 && !props.commitSubmitting())

  const selectedEntry = createMemo<GitChangeEntry | null>(() => {
    const list = listItems()
    const selectedId = props.selectedItemId()
    const fallbackId = props.mostChangedItemId()
    const found =
      list.find((item) => item.id === selectedId) ||
      (fallbackId ? list.find((item) => item.id === fallbackId) : undefined)
    return found?.entry ?? null
  })

  const emptyViewerMessage = createMemo(() => {
    if (!hasSession()) return props.t("instanceShell.gitChanges.noSessionSelected")
    const currentEntries = entries()
    if (currentEntries === null) return props.t("instanceShell.gitChanges.loading")
    if (listItems().length === 0) return props.t("instanceShell.gitChanges.empty")
    return props.t("instanceShell.filesShell.viewerEmpty")
  })

  const binaryViewerActive = createMemo(() => props.selectedError() === props.t("instanceShell.gitChanges.binaryViewer"))

  const renderContent = (): JSX.Element => {
    const totalsValue = totals()
    const selected = selectedEntry()
    const allItems = listItems()
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
                      true
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
                          insertContextLabel={props.t("instanceShell.gitChanges.actions.insertContext")}
                          onRequestInsertContext={binaryViewerActive() ? undefined : (selection) => {
                            const selectedId = props.selectedItemId()
                            if (!selectedId) return
                            const item = listItems().find((entry) => entry.id === selectedId)
                            if (!item) return
                            props.onInsertContext(item, selection)
                          }}
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

    const renderListItem = (item: GitChangeListItem) => {
      const isBulkSelected = createMemo(() => props.selectedBulkItemIds().has(item.id))
      const actionLabel =
        item.section === "staged"
          ? props.t("instanceShell.gitChanges.actions.unstage")
          : props.t("instanceShell.gitChanges.actions.stage")

      const triggerAction = () => {
        if (item.section === "staged") props.onUnstageFile(item)
        else props.onStageFile(item)
      }

      return (
        <div
          class={`file-list-item git-change-list-item ${props.selectedItemId() === item.id ? "file-list-item-active" : ""} ${isBulkSelected() ? "git-change-list-item-bulk-selected" : ""}`}
          onMouseDown={(event) => {
            if (event.shiftKey || event.ctrlKey || event.metaKey) {
              event.preventDefault()
            }
          }}
          onClick={(event) => props.onRowClick(item, event)}
          title={item.path}
        >
          <div class="file-list-item-content" title={item.path}>
            <div class="file-list-item-path" title={item.path}>
              <span class="file-path-text">{item.path}</span>
            </div>
            <div class="git-change-list-item-right">
              <div class="file-list-item-stats">
                <span class="file-list-item-additions">+{item.additions}</span>
                <span class="file-list-item-deletions">-{item.deletions}</span>
              </div>
            </div>
          </div>
          <div class="git-change-list-item-actions-zone">
            <div class="git-change-list-item-actions">
              <button
                type="button"
                class="git-change-row-action"
                title={actionLabel}
                aria-label={actionLabel}
                onClick={(event) => {
                  event.stopPropagation()
                  triggerAction()
                }}
              >
                <span
                  class={`git-change-row-action-glyph ${item.section === "staged" ? "git-change-row-action-glyph-minus" : "git-change-row-action-glyph-plus"}`}
                  aria-hidden="true"
                >
                  <span class="git-change-row-action-bar git-change-row-action-bar-horizontal" />
                  <Show when={item.section !== "staged"}>
                    <span class="git-change-row-action-bar git-change-row-action-bar-vertical" />
                  </Show>
                </span>
              </button>
            </div>
          </div>
        </div>
      )
    }

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
      <Show when={allItems.length > 0} fallback={renderEmptyList()}>
        <div class="git-change-sections">
          <div class="git-change-section">
            <button type="button" class="git-change-section-header" onClick={props.onToggleStagedOpen}>
              <span class="git-change-section-header-main">
                <span class="git-change-section-chevron">
                  {props.stagedOpen() ? <ChevronDown class="h-3.5 w-3.5" /> : <ChevronRight class="h-3.5 w-3.5" />}
                </span>
                <span class="git-change-section-title-row">
                  <span class="git-change-section-title">{props.t("instanceShell.gitChanges.sections.staged")}</span>
                  <Show when={props.branchLabel()}>
                    {(label) => (
                      <span class="status-indicator session-status-list worktree-indicator git-change-section-badge" title={`Branch: ${label()}`}>
                        <GitBranch class="w-3.5 h-3.5" aria-hidden="true" />
                        <span class="worktree-indicator-label">{label()}</span>
                      </span>
                    )}
                  </Show>
                </span>
              </span>
              <span class="git-change-section-count">{stagedList.length}</span>
            </button>
            <Show when={props.stagedOpen()}>
              <div class="git-change-section-items">
                <div class="git-change-commit-box">
                  <div class="git-change-commit-input-wrap">
                    <textarea
                      class="git-change-commit-input"
                      value={props.commitMessage()}
                      rows={1}
                      placeholder={props.t("instanceShell.gitChanges.commit.placeholder")}
                      onInput={(event) => props.onCommitMessageInput(event.currentTarget.value)}
                    />
                    <button
                      type="button"
                      class="git-change-commit-button git-change-commit-button-overlay"
                      disabled={!canCommit()}
                      onClick={() => props.onSubmitCommit()}
                    >
                      {props.commitSubmitting()
                        ? props.t("instanceShell.gitChanges.commit.submitting")
                        : props.t("instanceShell.gitChanges.commit.submit")}
                    </button>
                  </div>
                </div>
                <For each={stagedList}>{(item) => renderListItem(item)}</For>
              </div>
            </Show>
          </div>
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
