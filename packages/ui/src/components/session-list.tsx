import { Component, For, Show, createSignal, createMemo, createEffect, JSX, on, onCleanup } from "solid-js"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"
import type { SessionStatus } from "../types/session"
import type { SessionThread } from "../stores/session-state"
import { getRetrySeconds, getSessionIdleFadeClass, getSessionRetry, getSessionStatus, shouldShowSessionStatus } from "../stores/session-status"
import { Bot, User, Copy, Trash2, Pencil, ShieldAlert, ChevronRight, Search, Square, CheckSquare, MinusSquare, Split, RotateCw } from "lucide-solid"
import KeyboardHint from "./keyboard-hint"
import LoadErrorState from "./load-error-state"
import SessionRenameDialog from "./session-rename-dialog"
import ActionOverflowMenu, { type ActionOverflowMenuItem } from "./action-overflow-menu"
import { useSessionRowOverflow } from "./session-row-overflow"
import { keyboardRegistry } from "../lib/keyboard-registry"
import { showToastNotification } from "../lib/notifications"
import { useI18n } from "../lib/i18n"
import { showConfirmDialog } from "../stores/alerts"
import {
  deleteSession,
  ensureSessionAncestorsExpanded,
  getVisibleSessionIds,
  isSessionExpanded,
  loadMessages,
  loading,
  renameSession,
  sessions as sessionStateSessions,
  setActiveSessionFromList,
  toggleSessionExpanded,
  loadMoreSessions,
  searchSessions,
  getSessionHasMore,
  getSessionListError,
  clearSessionSearch,
  fetchSessions,
  getSessionSearchQuery,
  getSessionSearchThreads,
  isSessionSearchLoading,
} from "../stores/sessions"
import { getGitRepoStatus, getWorktreeSlugForParentSession } from "../stores/worktrees"
import { collectSessionThreadIds, findSessionThread, flattenVisibleSessionThreads, sortSessionIdsDeepestFirst } from "../stores/session-tree"
import { getLogger } from "../lib/logger"
import { copyToClipboard } from "../lib/clipboard"
import { useConfig } from "../stores/preferences"
import { isSessionListViewportAttached, shouldRenderSessionRows } from "./session-list-visibility"
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
  const { preferences } = useConfig()
  const [renameTarget, setRenameTarget] = createSignal<{ id: string; title: string; label: string } | null>(null)
  const [isRenaming, setIsRenaming] = createSignal(false)

  const [filterQuery, setFilterQuery] = createSignal("")
  const normalizedQuery = createMemo(() => (props.enableFilterBar ? filterQuery().trim().toLowerCase() : ""))

  const [selectedSessionIds, setSelectedSessionIds] = createSignal<Set<string>>(new Set())
  const [reloadingSessionIds, setReloadingSessionIds] = createSignal<Set<string>>(new Set())
  const [now, setNow] = createSignal(Date.now())
  const [listEl, setListEl] = createSignal<HTMLDivElement>()
  const [listViewportAttached, setListViewportAttached] = createSignal(false)
  const [virtualizerHandle, setVirtualizerHandle] = createSignal<VirtualizerHandle>()
  const [focusedSessionId, setFocusedSessionId] = createSignal<string>()
  const [menuSessionId, setMenuSessionId] = createSignal<string>()
  let attachmentFrame: number | undefined

  const setListElement = (element: HTMLDivElement) => {
    setListEl(element)
    const detectAttachment = () => {
      if (isSessionListViewportAttached(element)) {
        attachmentFrame = undefined
        setListViewportAttached(true)
        return
      }
      setListViewportAttached(false)
      if (typeof requestAnimationFrame !== "undefined") attachmentFrame = requestAnimationFrame(detectAttachment)
    }
    detectAttachment()
  }

  onCleanup(() => {
    if (attachmentFrame !== undefined) cancelAnimationFrame(attachmentFrame)
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => window.clearInterval(timer))
  })

  const [sentinelEl, setSentinelEl] = createSignal<HTMLDivElement | null>(null)

  const hasMore = createMemo(() => {
    if (normalizedQuery()) return false
    return getSessionHasMore(props.instanceId)
  })

  const isFetchingSessions = createMemo(() => {
    return loading().fetchingSessions.get(props.instanceId) ?? false
  })
  const sessionListError = createMemo(() => getSessionListError(props.instanceId))

  const handleRetrySessions = () => {
    void fetchSessions(props.instanceId, { reset: true }).catch((error) => {
      log.error("Failed to retry session list:", error)
    })
  }

  createEffect(() => {
    const el = sentinelEl()
    if (!el || !hasMore() || isFetchingSessions()) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry?.isIntersecting && hasMore() && !isFetchingSessions()) {
          void loadMoreSessions(props.instanceId).catch((error) => {
            log.error("Failed to load more sessions:", error)
          })
        }
      },
      { root: listEl() ?? null, rootMargin: "0px 0px 200px 0px" }
    )

    observer.observe(el)
    onCleanup(() => observer.disconnect())
  })

  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null
  createEffect(() => {
    const query = normalizedQuery()
    if (!props.enableFilterBar) {
      clearSessionSearch(props.instanceId)
      return
    }

    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer)
    }

    if (!query) {
      clearSessionSearch(props.instanceId)
      return
    }

    // Always run server search in background for workspace-complete results.
    // Client-side filtering (filteredThreads) shows instant results from loaded sessions.
    const queryAtDispatch = query
    searchDebounceTimer = setTimeout(() => {
      void searchSessions(props.instanceId, queryAtDispatch)
        .catch((error) => {
          log.error("Failed to search sessions:", error)
        })
    }, 150)

    onCleanup(() => {
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer)
      }
    })
  })

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

  const filterThreadTree = (thread: SessionThread, query: string): SessionThread | null => {
    const matchingChildren: SessionThread[] = []
    for (const child of thread.children) {
      const filteredChild = filterThreadTree(child, query)
      if (filteredChild !== null) matchingChildren.push(filteredChild)
    }
    if (!sessionMatchesQuery(thread.session.id, query) && matchingChildren.length === 0) return null
    return { ...thread, children: matchingChildren }
  }

  const filteredThreads = createMemo<SessionThread[]>(() => {
    const query = normalizedQuery()
    if (!query) return props.threads

    const searchQuery = getSessionSearchQuery(props.instanceId)
    const searchLoading = isSessionSearchLoading(props.instanceId)
    if (searchQuery === query && !searchLoading) {
      return getSessionSearchThreads(props.instanceId)
    }

    const result: SessionThread[] = []
    for (const thread of props.threads) {
      const filtered = filterThreadTree(thread, query)
      if (filtered !== null) result.push(filtered)
    }
    return result
  })

  const visibleProjection = createMemo(() => {
    const expandAll = Boolean(normalizedQuery())
    const rows = flattenVisibleSessionThreads(
      filteredThreads(),
      (sessionId) => expandAll || isSessionExpanded(props.instanceId, sessionId),
    )
    const ids: string[] = []
    const rowsById = new Map<string, (typeof rows)[number]>()
    const indexById = new Map<string, number>()
    rows.forEach((row, index) => {
      ids.push(row.sessionId)
      rowsById.set(row.sessionId, row)
      indexById.set(row.sessionId, index)
    })
    return { ids, rowsById, indexById }
  })
  const keptMountedIndexes = createMemo(() => {
    const indexes = new Set<number>()
    for (const sessionId of [focusedSessionId(), menuSessionId()]) {
      const index = sessionId ? visibleProjection().indexById.get(sessionId) : undefined
      if (index !== undefined) indexes.add(index)
    }
    return indexes.size ? [...indexes] : undefined
  })

  const allMatchingSessionIds = createMemo<string[]>(() => {
    const ids: string[] = []
    const collectIds = (threads: SessionThread[]) => {
      for (const thread of threads) {
        ids.push(thread.session.id)
        collectIds(thread.children)
      }
    }
    collectIds(filteredThreads())
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
    // If the user selects a child session, make sure its parent thread is expanded.
    // For parent sessions we don't force expansion; user can collapse/expand freely.
    if (session?.parentId) {
      ensureSessionAncestorsExpanded(props.instanceId, session.id)
    }

    props.onSelect(sessionId)
  }
 
  const copySessionId = async (sessionId: string) => {
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
 
  const handleDeleteSession = async (sessionId: string) => {
    if (isSessionDeleting(sessionId)) return

    const confirmed = await showConfirmDialog(
      t("sessionList.delete.confirmMessage", { label: normalizeSessionLabel(sessionId) }),
      {
        title: t("sessionList.delete.title"),
        variant: "warning",
        confirmLabel: t("sessionList.delete.confirmLabel"),
        cancelLabel: t("sessionList.delete.cancelLabel"),
        dismissible: false,
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

  const isSessionReloading = (sessionId: string) => reloadingSessionIds().has(sessionId)

  const handleReloadSession = async (sessionId: string) => {
    if (isSessionReloading(sessionId)) return

    setReloadingSessionIds((prev) => {
      const next = new Set(prev)
      next.add(sessionId)
      return next
    })

    try {
      await loadMessages(props.instanceId, sessionId, { force: true })
    } catch (error) {
      log.error(`Failed to reload session ${sessionId}:`, error)
      showToastNotification({ message: t("sessionList.reload.error"), variant: "error" })
    } finally {
      setReloadingSessionIds((prev) => {
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    }
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

  const getSelectableThreadIds = (sessionId: string): string[] => {
    const source = normalizedQuery() ? filteredThreads() : props.threads
    const thread = findSessionThread(source, sessionId)
    return thread ? collectSessionThreadIds([thread]) : [sessionId]
  }

  const getAllSessionIdsInOrder = (threads: SessionThread[]): string[] => {
    return collectSessionThreadIds(threads)
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
        dismissible: false,
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

    const deletionOrder = sortSessionIdsDeepestFirst(sessionStateSessions().get(props.instanceId) ?? new Map(), selected)
    let failed = 0
    for (const sessionId of deletionOrder) {
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
    session: SessionThread["session"]
    depth: number
    isLastChild: boolean
    hasChildren: boolean
    expanded?: boolean
    isLastRow: boolean
    onToggleExpand?: () => void
  }> = (rowProps) => {
    const sessionId = () => rowProps.session.id
    const isChild = () => rowProps.depth > 0

    const worktreeSlug = createMemo(() => {
      if (isChild()) return "root"
      return getWorktreeSlugForParentSession(props.instanceId, sessionId())
    })

    const showWorktreeBadge = createMemo(() => {
      if (isChild()) return false
      if (getGitRepoStatus(props.instanceId) === false) return false
      const slug = worktreeSlug()
      return Boolean(slug) && slug !== "root"
    })

    const isActive = () => props.activeSessionId === sessionId()
    const title = () => rowProps.session.title || t("sessionList.session.untitled")
    const status = () => getSessionStatus(props.instanceId, sessionId())
    const interrupted = () => rowProps.session.generationRecovery === "interrupted"
    const retry = () => getSessionRetry(props.instanceId, sessionId())
    const statusLabel = () => {
      if (interrupted()) return t("sessionList.status.interrupted")
      const retryState = retry()
      if (retryState) {
        const seconds = getRetrySeconds(retryState.next, now())
        return seconds > 0 ? t("sessionList.status.retryingIn", { seconds: String(seconds) }) : t("sessionList.status.retrying")
      }
      switch (formatSessionStatus(status())) {
        case "working":
          return t("sessionList.status.working")
        case "compacting":
          return t("sessionList.status.compacting")
        default:
          return t("sessionList.status.idle")
      }
    }
    const needsPermission = () => Boolean(rowProps.session.pendingPermission)
    const needsQuestion = () => Boolean(rowProps.session.pendingForm)
    const needsInput = () => needsPermission() || needsQuestion()
    const statusClassName = () => {
      if (needsInput()) return "session-permission"
      if (interrupted()) return "session-interrupted"
      const base = `session-${retry() ? "retrying" : status()}`
      const fadeClass = getSessionIdleFadeClass(props.instanceId, sessionId())
      return fadeClass ? `${base} ${fadeClass}` : base
    }
    const showStatus = () =>
      interrupted() ||
      needsInput() ||
      shouldShowSessionStatus(
        props.instanceId,
        sessionId(),
        now(),
        preferences().keepUnseenSubagentIdleStatus,
      )
    const statusText = () =>
      needsPermission()
        ? t("sessionList.status.needsPermission")
        : needsQuestion()
          ? t("sessionList.status.needsInput")
          : statusLabel()
    const statusTooltip = () => {
      const retryState = retry()
      if (!retryState) return undefined
      return t("sessionList.status.retryTooltip", {
        message: retryState.message,
        attempt: String(retryState.attempt),
      })
    }
 
    const isSelected = () => selectedSessionIds().has(sessionId())

    const parentGroupState = createMemo(() => {
      const ids = rowProps.hasChildren ? getSelectableThreadIds(sessionId()) : [sessionId()]
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

    const nestedStyle = () => {
      if (!isChild()) return undefined
      const indent = (depth: number) => `round(nearest, calc(var(--session-tree-first-indent) + ${depth - 1} * var(--session-tree-step)), 1px)`
      return {
        "--session-indent": indent(rowProps.depth),
        "--session-parent-indent": rowProps.depth === 1 ? "var(--session-root-indent)" : indent(rowProps.depth - 1),
      }
    }

    const [rowElement, setRowElement] = createSignal<HTMLDivElement>()
    const actionsOverflow = useSessionRowOverflow(rowElement)
    const compactActions = () => actionsOverflow() || menuSessionId() === sessionId()
    const actionItems: ActionOverflowMenuItem[] = [
      {
        key: "copy",
        get label() { return t("sessionList.actions.copyId.title") },
        get icon() { return <Copy class="w-3.5 h-3.5" /> },
        onSelect: () => copySessionId(sessionId()),
      },
      {
        key: "reload",
        get label() { return t("sessionList.actions.reload.title") },
        get icon() { return <RotateCw class="w-3.5 h-3.5" /> },
        get disabled() { return isSessionReloading(sessionId()) },
        onSelect: () => handleReloadSession(sessionId()),
      },
      {
        key: "rename",
        get label() { return t("sessionList.actions.rename.title") },
        get icon() { return <Pencil class="w-3.5 h-3.5" /> },
        onSelect: () => openRenameDialog(sessionId()),
      },
      {
        key: "delete",
        get label() { return t("sessionList.actions.delete.title") },
        get icon() { return <Trash2 class="w-3.5 h-3.5" /> },
        get disabled() { return isSessionDeleting(sessionId()) },
        onSelect: () => handleDeleteSession(sessionId()),
      },
    ]

    return (
      <div class={`session-list-item group ${rowProps.isLastRow ? "session-list-item-last" : ""}`}>
        <div
          class={`session-item-base ${isChild() ? "session-item-nested" : ""} ${isChild() && rowProps.isLastChild ? "session-item-child-last" : ""} ${isChild() ? "session-item-border-assistant session-item-kind-assistant" : "session-item-border-user session-item-kind-user"} ${isActive() ? "session-item-active" : "session-item-inactive"}`}
          style={nestedStyle()}
          data-session-id={sessionId()}
          ref={setRowElement}
          data-compact-actions={compactActions()}
        >
          <Show when={props.enableFilterBar}>
            <input
              ref={(el) => {
                rowCheckboxEl = el
              }}
              type="checkbox"
              checked={parentGroupState().checked}
              onChange={(event) => setSelectedMany(parentGroupState().ids, event.currentTarget.checked)}
              aria-label={t("sessionList.selection.checkboxAriaLabel")}
            />
          </Show>
          <Show
            when={rowProps.hasChildren}
            fallback={<span class="session-item-expander session-item-expander--spacer" aria-hidden="true" />}
          >
            <button
              type="button"
              class={`session-item-expander opacity-80 hover:opacity-100 ${isActive() ? "hover:bg-white/20" : "hover:bg-surface-hover"}`}
              onClick={() => rowProps.onToggleExpand?.()}
              aria-expanded={Boolean(rowProps.expanded)}
              aria-label={
                rowProps.expanded ? t("sessionList.expand.collapseAriaLabel") : t("sessionList.expand.expandAriaLabel")
              }
              title={rowProps.expanded ? t("sessionList.expand.collapseTitle") : t("sessionList.expand.expandTitle")}
            >
              <ChevronRight class="disclosure-chevron w-3.5 h-3.5" />
            </button>
          </Show>
          <button
            type="button"
            class="session-item-select"
            onClick={() => selectSession(sessionId())}
            title={title()}
            aria-current={isActive() ? "true" : undefined}
          >
            <Show when={isChild()} fallback={<User class="session-item-kind-icon w-4 h-4 flex-shrink-0" aria-hidden="true" />}>
              <Bot class="session-item-kind-icon w-4 h-4 flex-shrink-0" aria-hidden="true" />
            </Show>
            <span class="session-item-title session-item-title--clamp" dir="auto">{title()}</span>
            <span class="session-item-badges">
              <Show when={showStatus()}>
                <span
                  class={`status-indicator session-status session-status-list ${statusClassName()} notranslate`}
                  title={statusTooltip()}
                  translate="no"
                >
                  {needsInput() ? <ShieldAlert class="w-3.5 h-3.5" aria-hidden="true" /> : <span class="status-dot" />}
                  <span class="session-item-status-label">{statusText()}</span>
                </span>
              </Show>
              <Show when={showWorktreeBadge()}>
                <span class="status-indicator session-status-list worktree-indicator" title={`Worktree: ${worktreeSlug()}`}>
                  <Split class="w-3.5 h-3.5" aria-hidden="true" />
                  <span class="worktree-indicator-label">{worktreeSlug()}</span>
                </span>
              </Show>
            </span>
          </button>
          <div class="session-item-actions">
            <div class="session-item-inline-actions" inert={compactActions()}>
              <For each={actionItems}>{(item) => (
                <button
                  type="button"
                  class="session-item-close"
                  title={item.label}
                  aria-label={item.label}
                  aria-disabled={item.disabled}
                  onClick={() => { if (!item.disabled) void item.onSelect() }}
                >
                  {item.icon}
                </button>
              )}</For>
            </div>
            <div class="session-item-overflow-actions">
              <ActionOverflowMenu
                label={t("messageItem.actions.more")}
                onOpenChange={(open) => {
                  setMenuSessionId(open ? sessionId() : undefined)
                  if (!open && !actionsOverflow()) requestAnimationFrame(() => {
                    const row = rowElement()
                    if (!row?.isConnected) return
                    const active = document.activeElement
                    if (active === document.body || row.querySelector(".session-item-overflow-actions")?.contains(active)) {
                      row.querySelector<HTMLButtonElement>(".session-item-inline-actions button")?.focus({ preventScroll: true })
                    }
                  })
                }}
                items={actionItems}
              />
            </div>
          </div>
        </div>
      </div>
    )
  }

  createEffect(on(
    () => [props.activeSessionId, virtualizerHandle()] as const,
    ([activeId, handle]) => {
      if (!activeId || activeId === "info" || !handle) return

      const scroll = () => {
        const index = visibleProjection().indexById.get(activeId)
        if (index !== undefined) handle.scrollToIndex(index, { align: "nearest" })
      }
      if (typeof requestAnimationFrame === "undefined") {
        scroll()
        return
      }

      const frame = requestAnimationFrame(scroll)
      onCleanup(() => cancelAnimationFrame(frame))
    },
  ))

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
              <h3 class="text-sm font-semibold text-primary notranslate" translate="no">
                {t("sessionList.header.title")}
              </h3>
              <KeyboardHint
                shortcuts={[keyboardRegistry.get("session-prev")!, keyboardRegistry.get("session-next")!].filter(Boolean)}
              />
            </div>
          )}
        </div>
      </Show>

       <div
         class="session-list flex-1 overflow-y-auto"
         ref={setListElement}
         onFocusIn={(event) => {
           const target = event.target
           if (!(target instanceof Element)) return
           const row = target.closest<HTMLElement>("[data-session-id]")
           setFocusedSessionId(row?.dataset.sessionId)
         }}
         onFocusOut={(event) => {
           const nextTarget = event.relatedTarget
           if (nextTarget instanceof Node && listEl()?.contains(nextTarget)) return
           setFocusedSessionId(undefined)
         }}
       >

          <Show when={sessionListError()}>
            {(error) => (
              <LoadErrorState
                variant="compact"
                title={t("sessionList.loadError.title")}
                error={error()}
                retryLabel={t("sessionList.loadError.retry")}
                onRetry={handleRetrySessions}
              />
            )}
          </Show>

          <Show when={!sessionListError() && (hasMore() || isFetchingSessions()) && visibleProjection().ids.length === 0}>
            <div class="flex items-center justify-center p-4 text-xs text-muted" role="status">
              <span class="animate-pulse">{t("sessionList.loading.initial")}</span>
            </div>
          </Show>

          <Show when={shouldRenderSessionRows(
            Boolean(sessionListError()),
            listViewportAttached() && (visibleProjection().ids.length > 0 || hasMore() || isFetchingSessions()),
          )}>
           <div class="session-section">
             <Show when={visibleProjection().ids.length > 0}>
               <Virtualizer
                 ref={setVirtualizerHandle}
                 data={visibleProjection().ids}
                 scrollRef={listEl()}
                 bufferSize={400}
                 keepMounted={keptMountedIndexes()}
               >
                 {(sessionId, index) => {
                   const row = createMemo(() => visibleProjection().rowsById.get(sessionId))
                   return (
                     <Show when={Boolean(row())}>
                       <SessionRow
                         session={row()!.thread.session}
                         depth={row()!.depth}
                         hasChildren={row()!.hasChildren}
                         expanded={row()!.expanded}
                         onToggleExpand={() => toggleSessionExpanded(props.instanceId, sessionId)}
                         isLastChild={row()!.isLastChild}
                         isLastRow={index() === visibleProjection().ids.length - 1 && !hasMore() && !isFetchingSessions()}
                       />
                     </Show>
                   )
                 }}
               </Virtualizer>
             </Show>
             <Show when={hasMore() || isFetchingSessions()}>
                <div
                  ref={(el) => setSentinelEl(el)}
                  class="session-list-sentinel flex items-center justify-center py-3 text-text-weak text-xs"
                  data-session-sentinel
                />
             </Show>
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
