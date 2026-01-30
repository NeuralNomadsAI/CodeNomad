import { Component, For, Show, createSignal, createMemo, createEffect, JSX, onCleanup } from "solid-js"
import type { SessionStatus } from "../types/session"
import type { SessionThread } from "../stores/session-state"
import { getSessionStatus } from "../stores/session-status"
import { Bot, User, Copy, Trash2, Pencil, ShieldAlert, ChevronDown, Search, Square, CheckSquare, MinusSquare } from "lucide-solid"
import KeyboardHint from "./keyboard-hint"
import SessionRenameDialog from "./session-rename-dialog"
import { keyboardRegistry } from "../lib/keyboard-registry"
import { showToastNotification } from "../lib/notifications"
import { useI18n } from "../lib/i18n"
import { showConfirmDialog } from "../stores/alerts"
import {
  deleteSession,
  ensureSessionParentExpanded,
  getVisibleSessionIds,
  isSessionParentExpanded,
  loading,
  renameSession,
  sessions as sessionStateSessions,
  setActiveSessionFromList,
  toggleSessionParentExpanded,
} from "../stores/sessions"
import { getLogger } from "../lib/logger"
import { copyToClipboard } from "../lib/clipboard"
const log = getLogger("session")



interface SessionListProps {
  instanceId: string
  threads: SessionThread[]
  activeSessionId: string | null
  onSelect: (sessionId: string) => void
  onNew: () => void
  showHeader?: boolean
  showFooter?: boolean
  headerContent?: JSX.Element
  footerContent?: JSX.Element
  enableFilterBar?: boolean
}

function formatSessionStatus(status: SessionStatus): string {
  return status
}

const SessionList: Component<SessionListProps> = (props) => {
  const { t } = useI18n()
  const [renameTarget, setRenameTarget] = createSignal<{ id: string; title: string; label: string } | null>(null)
  const [isRenaming, setIsRenaming] = createSignal(false)

  const [filterQuery, setFilterQuery] = createSignal("")
  const normalizedQuery = createMemo(() => filterQuery().trim().toLowerCase())

  const [selectedSessionIds, setSelectedSessionIds] = createSignal<Set<string>>(new Set())

  const normalizeSessionLabel = (sessionId: string) => {
    const session = sessionStateSessions().get(props.instanceId)?.get(sessionId)
    const title = (session?.title ?? "").trim()
    return title || t("sessionList.session.untitled")
  }

  const sessionMatchesQuery = (sessionId: string, query: string) => {
    if (!query) return true
    const label = normalizeSessionLabel(sessionId).toLowerCase()
    if (label.includes(query)) return true
    return sessionId.toLowerCase().includes(query)
  }

  const filteredThreads = createMemo<SessionThread[]>(() => {
    const query = normalizedQuery()
    if (!query) return props.threads

    const next: SessionThread[] = []
    for (const thread of props.threads) {
      const parentMatches = sessionMatchesQuery(thread.parent.id, query)
      const matchingChildren = thread.children.filter((child) => sessionMatchesQuery(child.id, query))

      if (!parentMatches && matchingChildren.length === 0) continue

      next.push({
        parent: thread.parent,
        children: matchingChildren,
        latestUpdated: thread.latestUpdated,
      })
    }

    return next
  })

  const allMatchingSessionIds = createMemo<string[]>(() => {
    const ids: string[] = []
    for (const thread of filteredThreads()) {
      ids.push(thread.parent.id)
      for (const child of thread.children) ids.push(child.id)
    }
    return ids
  })

  const selectedCount = createMemo(() => selectedSessionIds().size)

  const isAllSelected = createMemo(() => {
    const ids = allMatchingSessionIds()
    if (ids.length === 0) return false
    const selected = selectedSessionIds()
    return ids.every((id) => selected.has(id))
  })
  const isSelectAllIndeterminate = createMemo(() => {
    const ids = allMatchingSessionIds()
    const total = ids.length
    if (total === 0) return false
    const count = selectedCount()
    return count > 0 && count < total
  })

  const isSessionDeleting = (sessionId: string) => {
    const deleting = loading().deletingSession.get(props.instanceId)
    return deleting ? deleting.has(sessionId) : false
  }
 

  const selectSession = (sessionId: string) => {
    const session = sessionStateSessions().get(props.instanceId)?.get(sessionId)
    const parentId = session?.parentId ?? session?.id
    if (parentId) {
      ensureSessionParentExpanded(props.instanceId, parentId)
    }

    props.onSelect(sessionId)
  }
 
  const copySessionId = async (event: MouseEvent, sessionId: string) => {
    event.stopPropagation()

    try {
      const success = await copyToClipboard(sessionId)
      if (success) {
        showToastNotification({ message: t("sessionList.copyId.success"), variant: "success" })
      } else {
        showToastNotification({ message: t("sessionList.copyId.error"), variant: "error" })
      }
    } catch (error) {
      log.error(`Failed to copy session ID ${sessionId}:`, error)
      showToastNotification({ message: t("sessionList.copyId.error"), variant: "error" })
    }
  }
 
  const handleDeleteSession = async (event: MouseEvent, sessionId: string) => {
    event.stopPropagation()
    if (isSessionDeleting(sessionId)) return

    const confirmed = await showConfirmDialog(
      t("sessionList.delete.confirmMessage", { label: normalizeSessionLabel(sessionId) }),
      {
        title: t("sessionList.delete.title"),
        variant: "warning",
        confirmLabel: t("sessionList.delete.confirmLabel"),
        cancelLabel: t("sessionList.delete.cancelLabel"),
      },
    )
    if (!confirmed) return

    const shouldSelectFallback = props.activeSessionId === sessionId
    let fallbackSessionId: string | undefined

    if (shouldSelectFallback) {
      const visible = getVisibleSessionIds(props.instanceId)
      const currentIndex = visible.indexOf(sessionId)
      const remaining = visible.filter((id) => id !== sessionId)

      if (remaining.length > 0) {
        if (currentIndex !== -1) {
          for (let i = currentIndex; i < visible.length; i++) {
            const candidate = visible[i]
            if (candidate && candidate !== sessionId) {
              fallbackSessionId = candidate
              break
            }
          }

          if (!fallbackSessionId) {
            for (let i = currentIndex - 1; i >= 0; i--) {
              const candidate = visible[i]
              if (candidate && candidate !== sessionId) {
                fallbackSessionId = candidate
                break
              }
            }
          }
        }

        fallbackSessionId ??= remaining[0]
      }
    }

    try {
      await deleteSession(props.instanceId, sessionId)
      if (fallbackSessionId) {
        setActiveSessionFromList(props.instanceId, fallbackSessionId)
      }
    } catch (error) {
      log.error(`Failed to delete session ${sessionId}:`, error)
      showToastNotification({ message: t("sessionList.delete.error"), variant: "error" })
    }
  }

  const openRenameDialog = (sessionId: string) => {
    const session = sessionStateSessions().get(props.instanceId)?.get(sessionId)
    if (!session) return
    const label = session.title && session.title.trim() ? session.title : sessionId
    setRenameTarget({ id: sessionId, title: session.title ?? "", label })
  }

  const closeRenameDialog = () => {
    setRenameTarget(null)
  }

  const handleRenameSubmit = async (nextTitle: string) => {
    const target = renameTarget()
    if (!target) return
 
    setIsRenaming(true)
    try {
      await renameSession(props.instanceId, target.id, nextTitle)
      setRenameTarget(null)
    } catch (error) {
      log.error(`Failed to rename session ${target.id}:`, error)
      showToastNotification({ message: t("sessionList.rename.error"), variant: "error" })
    } finally {
      setIsRenaming(false)
    }
  }

  const setSelectedMany = (sessionIds: string[], checked: boolean) => {
    if (sessionIds.length === 0) return
    setSelectedSessionIds((prev) => {
      const next = new Set(prev)
      sessionIds.forEach((id) => {
        if (checked) next.add(id)
        else next.delete(id)
      })
      return next
    })
  }

  const getSelectableThreadIds = (parentId: string): string[] => {
    const query = normalizedQuery()
    const source = query ? filteredThreads() : props.threads
    const thread = source.find((t) => t.parent.id === parentId)
    if (!thread) return [parentId]
    return [thread.parent.id, ...thread.children.map((c) => c.id)]
  }

  const getAllSessionIdsInOrder = (threads: SessionThread[]): string[] => {
    const ids: string[] = []
    threads.forEach((thread) => {
      ids.push(thread.parent.id)
      thread.children.forEach((child) => ids.push(child.id))
    })
    return ids
  }

  const handleToggleSelectAll = (checked: boolean) => {
    const ids = allMatchingSessionIds()
    setSelectedMany(ids, checked)
  }

  const toggleSelectAll = () => {
    if (isAllSelected()) {
      handleToggleSelectAll(false)
      return
    }
    handleToggleSelectAll(true)
  }

  const handleBulkDelete = async () => {
    const selected = Array.from(selectedSessionIds())
    if (selected.length === 0) return

    const confirmed = await showConfirmDialog(
      t("sessionList.bulkDelete.confirmMessage", { count: selected.length }),
      {
        title: t("sessionList.bulkDelete.title"),
        variant: "warning",
        confirmLabel: t("sessionList.bulkDelete.confirmLabel"),
        cancelLabel: t("sessionList.bulkDelete.cancelLabel"),
      },
    )

    if (!confirmed) return

    const deletedSet = new Set(selected)
    const currentActiveId = props.activeSessionId

    let fallbackSessionId: string | undefined
    if (currentActiveId && deletedSet.has(currentActiveId)) {
      const ordered = getAllSessionIdsInOrder(props.threads)
      const currentIndex = ordered.indexOf(currentActiveId)

      for (let i = Math.max(0, currentIndex); i < ordered.length; i++) {
        const candidate = ordered[i]
        if (candidate && !deletedSet.has(candidate)) {
          fallbackSessionId = candidate
          break
        }
      }
      if (!fallbackSessionId) {
        for (let i = currentIndex - 1; i >= 0; i--) {
          const candidate = ordered[i]
          if (candidate && !deletedSet.has(candidate)) {
            fallbackSessionId = candidate
            break
          }
        }
      }
    }

    let failed = 0
    for (const sessionId of selected) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await deleteSession(props.instanceId, sessionId)
      } catch (error) {
        failed += 1
        log.error(`Failed to delete session ${sessionId}:`, error)
      }
    }

    setSelectedSessionIds(new Set<string>())

    if (fallbackSessionId) {
      setActiveSessionFromList(props.instanceId, fallbackSessionId)
    }

    if (failed > 0) {
      showToastNotification({
        message: t("sessionList.bulkDelete.error", { count: failed }),
        variant: "error",
      })
    }
  }
 

  const SessionRow: Component<{
    sessionId: string
    isChild?: boolean
    isLastChild?: boolean
    hasChildren?: boolean
    expanded?: boolean
    onToggleExpand?: () => void
  }> = (rowProps) => {
    const session = createMemo(() => sessionStateSessions().get(props.instanceId)?.get(rowProps.sessionId))
    if (!session()) {
      return <></>
    }
    const isActive = () => props.activeSessionId === rowProps.sessionId
    const title = () => session()?.title || t("sessionList.session.untitled")
    const status = () => getSessionStatus(props.instanceId, rowProps.sessionId)
    const statusLabel = () => {
      switch (formatSessionStatus(status())) {
        case "working":
          return t("sessionList.status.working")
        case "compacting":
          return t("sessionList.status.compacting")
        default:
          return t("sessionList.status.idle")
      }
    }
    const needsPermission = () => Boolean(session()?.pendingPermission)
    const needsQuestion = () => Boolean((session() as any)?.pendingQuestion)
    const needsInput = () => needsPermission() || needsQuestion()
    const statusClassName = () => (needsInput() ? "session-permission" : `session-${status()}`)
    const statusText = () =>
      needsPermission()
        ? t("sessionList.status.needsPermission")
        : needsQuestion()
          ? t("sessionList.status.needsInput")
          : statusLabel()
 
    const isSelected = () => selectedSessionIds().has(rowProps.sessionId)

    const parentGroupState = createMemo(() => {
      if (rowProps.isChild) {
        return { checked: isSelected(), indeterminate: false, ids: [rowProps.sessionId] }
      }

      const ids = getSelectableThreadIds(rowProps.sessionId)
      const selected = selectedSessionIds()
      const selectedInGroup = ids.reduce((count, id) => (selected.has(id) ? count + 1 : count), 0)
      return {
        checked: selectedInGroup > 0 && selectedInGroup === ids.length,
        indeterminate: selectedInGroup > 0 && selectedInGroup < ids.length,
        ids,
      }
    })

    let rowCheckboxEl: HTMLInputElement | null = null
    createEffect(() => {
      if (!rowCheckboxEl) return
      rowCheckboxEl.indeterminate = parentGroupState().indeterminate
    })

    return (
      <div class="session-list-item group">
        <button
          class={`session-item-base ${rowProps.isChild ? `session-item-child${rowProps.isLastChild ? " session-item-child-last" : ""} session-item-border-assistant session-item-kind-assistant` : "session-item-border-user session-item-kind-user"} ${isActive() ? "session-item-active" : "session-item-inactive"}`}
          data-session-id={rowProps.sessionId}
          onClick={() => selectSession(rowProps.sessionId)}
          title={title()}
          role="button"
          aria-selected={isActive()}
          aria-expanded={rowProps.hasChildren ? Boolean(rowProps.expanded) : undefined}
        >
          <div class="session-item-row session-item-header">
            <div class="session-item-title-row">
              <Show when={props.enableFilterBar}>
                <input
                  ref={(el) => {
                    rowCheckboxEl = el
                  }}
                  type="checkbox"
                  checked={parentGroupState().checked}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    event.stopPropagation()
                    setSelectedMany(parentGroupState().ids, event.currentTarget.checked)
                  }}
                  aria-label={t("sessionList.selection.checkboxAriaLabel")}
                />
              </Show>

              {rowProps.isChild ? <Bot class="w-4 h-4 flex-shrink-0" /> : <User class="w-4 h-4 flex-shrink-0" />}
              <span class="session-item-title session-item-title--clamp">{title()}</span>
            </div>
          </div>
          <div class="session-item-row session-item-meta">
            <div class="flex items-center gap-2 min-w-0">
              <Show
                when={rowProps.hasChildren && !rowProps.isChild}
                fallback={rowProps.isChild ? null : <span class="session-item-expander session-item-expander--spacer" aria-hidden="true" />}
              >
                <span
                  class={`session-item-expander opacity-80 hover:opacity-100 ${isActive() ? "hover:bg-white/20" : "hover:bg-surface-hover"}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    rowProps.onToggleExpand?.()
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={
                    rowProps.expanded ? t("sessionList.expand.collapseAriaLabel") : t("sessionList.expand.expandAriaLabel")
                  }
                  title={rowProps.expanded ? t("sessionList.expand.collapseTitle") : t("sessionList.expand.expandTitle")}
                >
                  <ChevronDown class={`w-3.5 h-3.5 transition-transform ${rowProps.expanded ? "" : "-rotate-90"}`} />
                </span>
              </Show>
              <span class={`status-indicator session-status session-status-list ${statusClassName()}`}>
                {needsInput() ? <ShieldAlert class="w-3.5 h-3.5" aria-hidden="true" /> : <span class="status-dot" />}
                {statusText()}
              </span>
            </div>
            <div class="session-item-actions">
              <span
                class={`session-item-close opacity-80 hover:opacity-100 ${isActive() ? "hover:bg-white/20" : "hover:bg-surface-hover"}`}
                onClick={(event) => copySessionId(event, rowProps.sessionId)}
                role="button"
                tabIndex={0}
                aria-label={t("sessionList.actions.copyId.ariaLabel")}
                title={t("sessionList.actions.copyId.title")}
              >
                <Copy class="w-3 h-3" />
              </span>
              <span
                class={`session-item-close opacity-80 hover:opacity-100 ${isActive() ? "hover:bg-white/20" : "hover:bg-surface-hover"}`}
                onClick={(event) => {
                  event.stopPropagation()
                  openRenameDialog(rowProps.sessionId)
                }}
                role="button"
                tabIndex={0}
                aria-label={t("sessionList.actions.rename.ariaLabel")}
                title={t("sessionList.actions.rename.title")}
              >
                <Pencil class="w-3 h-3" />
              </span>
              <span
                class={`session-item-close opacity-80 hover:opacity-100 ${isActive() ? "hover:bg-white/20" : "hover:bg-surface-hover"}`}
                onClick={(event) => handleDeleteSession(event, rowProps.sessionId)}
                role="button"
                tabIndex={0}
                aria-label={t("sessionList.actions.delete.ariaLabel")}
                title={t("sessionList.actions.delete.title")}
              >
                <Show
                  when={!isSessionDeleting(rowProps.sessionId)}
                  fallback={
                    <svg class="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                      <path
                        class="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                  }
                >
                  <Trash2 class="w-3 h-3" />
                </Show>
              </span>
            </div>
          </div>
        </button>
      </div>
    )
  }
 
  const activeParentId = createMemo(() => {
    const activeId = props.activeSessionId
    if (!activeId || activeId === "info") return null

    const activeSession = sessionStateSessions().get(props.instanceId)?.get(activeId)
    if (!activeSession) return null

    return activeSession.parentId ?? activeSession.id
  })

  createEffect(() => {
    const parentId = activeParentId()
    if (!parentId) return
    ensureSessionParentExpanded(props.instanceId, parentId)
  })
 
  const listEl = createSignal<HTMLElement | null>(null)

  const escapeCss = (value: string) => {
    if (typeof CSS !== "undefined" && typeof (CSS as any).escape === "function") {
      return (CSS as any).escape(value)
    }
    return value.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"")
  }

  const scrollActiveIntoView = (sessionId: string) => {
    const root = listEl[0]()
    if (!root) return

    const selector = `[data-session-id="${escapeCss(sessionId)}"]`

    const scrollNow = () => {
      const target = root.querySelector(selector) as HTMLElement | null
      if (!target) return
      target.scrollIntoView({ block: "nearest", inline: "nearest" })
    }

    if (typeof requestAnimationFrame === "undefined") {
      scrollNow()
      return
    }

    // Wait a couple frames so expand/collapse DOM settles.
    let raf1 = 0
    let raf2 = 0
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        scrollNow()
      })
    })

    onCleanup(() => {
      if (raf1) cancelAnimationFrame(raf1)
      if (raf2) cancelAnimationFrame(raf2)
    })
  }

  createEffect(() => {
    const activeId = props.activeSessionId
    if (!activeId || activeId === "info") return
    scrollActiveIntoView(activeId)
  })

  return (
    <div
      class="session-list-container bg-surface-secondary border-r border-base flex flex-col w-full"
    >
      <Show when={props.enableFilterBar}>
        <div class="p-3 border-b border-base">
          <div class="flex items-center gap-2">
            <div class="relative flex-1 min-w-0">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true">
                <Search class="w-4 h-4" />
              </span>
              <input
                type="text"
                class="form-input pl-9"
                value={filterQuery()}
                onInput={(e) => setFilterQuery(e.currentTarget.value)}
                placeholder={t("sessionList.filter.placeholder")}
                aria-label={t("sessionList.filter.ariaLabel")}
              />
            </div>

            <button
              type="button"
              class="button-tertiary p-2 inline-flex items-center justify-center"
              onClick={toggleSelectAll}
              disabled={allMatchingSessionIds().length === 0}
              aria-label={t("sessionList.selection.selectAllAriaLabel")}
              title={t("sessionList.selection.selectAllLabel")}
            >
              <Show
                when={isSelectAllIndeterminate()}
                fallback={isAllSelected() ? <CheckSquare class="w-4 h-4" /> : <Square class="w-4 h-4" />}
              >
                <MinusSquare class="w-4 h-4" />
              </Show>
            </button>
          </div>

          <Show when={selectedCount() > 0}>
            <div class="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                class="button-tertiary"
                onClick={handleBulkDelete}
                aria-label={t("sessionList.bulkDelete.ariaLabel", { count: selectedCount() })}
              >
                {t("sessionList.bulkDelete.button", { count: selectedCount() })}
              </button>
              <button
                type="button"
                class="button-tertiary"
                onClick={() => setSelectedSessionIds(new Set<string>())}
                aria-label={t("sessionList.selection.clearAriaLabel")}
              >
                {t("sessionList.selection.clearLabel")}
              </button>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={props.showHeader !== false}>
        <div class="session-list-header p-3 border-b border-base">
          {props.headerContent ?? (
            <div class="flex items-center justify-between gap-3">
              <h3 class="text-sm font-semibold text-primary">{t("sessionList.header.title")}</h3>
              <KeyboardHint
                shortcuts={[keyboardRegistry.get("session-prev")!, keyboardRegistry.get("session-next")!].filter(Boolean)}
              />
            </div>
          )}
        </div>
      </Show>

       <div class="session-list flex-1 overflow-y-auto" ref={(el) => listEl[1](el)}>

          <Show when={filteredThreads().length > 0}>
            <div class="session-section">
              <For each={filteredThreads()}>

               {(thread) => {
                 const expanded = () => (normalizedQuery() ? true : isSessionParentExpanded(props.instanceId, thread.parent.id))
                 return (
                   <>
                       <SessionRow
                         sessionId={thread.parent.id}
                         hasChildren={thread.children.length > 0}
                         expanded={expanded()}
                         onToggleExpand={() => toggleSessionParentExpanded(props.instanceId, thread.parent.id)}
                       />

                     <Show when={expanded() && thread.children.length > 0}>
                       <For each={thread.children}>
                         {(child, index) => (
                           <SessionRow sessionId={child.id} isChild isLastChild={index() === thread.children.length - 1} />
                         )}
                       </For>
                     </Show>
                   </>
                 )
               }}
            </For>
          </div>
        </Show>
      </div>

      <Show when={props.showFooter !== false}>
        <div class="session-list-footer p-3 border-t border-base">
          {props.footerContent ?? null}
        </div>
      </Show>

      <SessionRenameDialog
        open={Boolean(renameTarget())}
        currentTitle={renameTarget()?.title ?? ""}
        sessionLabel={renameTarget()?.label}
        isSubmitting={isRenaming()}
        onRename={handleRenameSubmit}
        onClose={closeRenameDialog}
      />
    </div>
  )
}

export default SessionList
