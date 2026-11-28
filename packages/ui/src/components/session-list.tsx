import { Component, For, Show, batch, createSignal, createMemo, createEffect, JSX, on, onCleanup } from "solid-js"
import { focusInterruption } from "../stores/interruption-navigation"
import { beginGesture } from "../stores/session-surface"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"
import { observeListEnd } from "../lib/list-end-observer"
import { preserveListFocus } from "../lib/preserve-list-focus"
import type { SessionStatus } from "../types/session"
import type { SessionThread } from "../stores/session-state"
import { clearSessionIdleFade, getRetrySeconds, idleFadeClassForSession, shouldShowSessionStatusForRow } from "../stores/session-status"
import { createDeadlineMemo } from "../lib/deadline-memo"
import { Archive, ArchiveRestore, Bot, User, Copy, Trash2, Pencil, ShieldAlert, Search, Square, CheckSquare, MinusSquare, Split, RotateCw, Star } from "lucide-solid"
import { childActivityKind, childActivityLabel, createDescendantActivity } from "./session-child-activity"
import LoadErrorState from "./load-error-state"
import SessionRenameDialog from "./session-rename-dialog"
import ActionOverflowMenu, { type ActionOverflowMenuItem } from "./action-overflow-menu"
import SessionExpander from "./session-expander"
import { useSessionRowOverflow } from "./session-row-overflow"
import { showToastNotification } from "../lib/notifications"
import { useI18n } from "../lib/i18n"
import { captureBackendOperation } from "../lib/backend-operation"
import { toggleSweepClear, toggleSweepGroup } from "../lib/toggle-sweep"
import { isSessionInterruptionUnseen, markSessionInterruptionSeen } from "../stores/session-interruption-seen"
import { showConfirmDialog } from "../stores/alerts"
import {
  deleteSession,
  ensureSessionAncestorsExpanded,
  getVisibleSessionIds,
  isSessionExpanded,
  loadMessages,
  loading,
  markSessionIdleSeen,
  renameSession,
  sessions as sessionStateSessions,
  setActiveSessionFromList,
  toggleSessionExpanded,
  loadMoreSessions,
  loadAllSessions,
  searchSessions,
  getSessionHasMore,
  getSessionListError,
  clearSessionSearch,
  fetchSessions,
  getSessionSearchQuery,
  getSessionSearchSessions,
  isSessionSearchLoading,
} from "../stores/sessions"
import { getGitRepoStatus, getWorktreeSlugForParentSession, getWorktrees } from "../stores/worktrees"
import { collectSessionThreadIds, findSessionThread, flattenVisibleSessionThreads, isSessionArchived, projectSessionFamilies, projectSessionSearchResults, projectUnarchivedSessionThreads, sortSessionIdsDeepestFirst, type SessionFamilySort, type SessionArchiveFilter } from "../stores/session-tree"
import { setSessionArchived } from "../stores/session-archive"
import { normalizeSessionDirectory } from "../stores/session-list-options"
import { getLogger } from "../lib/logger"
import { copyToClipboard } from "../lib/clipboard"
import { useConfig } from "../stores/preferences"
import { isSessionListViewportAttached, shouldRenderSessionRows } from "./session-list-visibility"
import { getDescendantSessions, getListedSessionMap, getSessionAncestorIds, isSessionInWorkspaceScope, revealSubsession } from "../stores/session-state"
import { getSessionListView } from "../stores/session-list-view"
import { instances } from "../stores/instances"
import { hydrateRestoredSessionChain } from "../stores/session-api"
import { useSessionFavorites } from "../stores/session-favorites"
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

  const view = getSessionListView(props.instanceId)
  const [filterQuery, setFilterQuery] = view.query
  const [sortBy, setSortBy] = view.sort
  const [worktreeDirectory, setWorktreeDirectory] = view.directory
  const [includeMainSessions, setIncludeMainSessions] = view.main
  const [includeSubsessions, setIncludeSubsessions] = view.children
  const [archiveFilter, setArchiveFilter] = view.archive
  const [favoritesOnly, setFavoritesOnly] = view.favoritesOnly
  const favoriteStore = useSessionFavorites(() => props.instanceId, view)
  const favorites = createMemo(() => new Set(Object.keys(favoriteStore.records())))
  const includesFavorite = (id: string) => favorites().has(id)
    || getDescendantSessions(props.instanceId, id).some(session => favorites().has(session.id))
  let favoritesFilter: HTMLButtonElement | undefined
  let searchInput: HTMLInputElement | undefined
  const [archivingSessionIds, setArchivingSessionIds] = createSignal<Set<string>>(new Set())
  const normalizedQuery = createMemo(() => (props.enableFilterBar ? filterQuery().trim().toLowerCase() : ""))
  let failedSortExhaustion: string | undefined

  // Resolve known IDs directly, using the same owned proxy and ancestry restore
  // as saved selection. Do not exhaust history just to bring favorites forward.
  createEffect(on(() => [props.instanceId, instances().get(props.instanceId)?.client, favorites()] as const,
    ([id, client, ids]) => {
      if (!client || !ids.size) return
      const controller = new AbortController()
      onCleanup(() => controller.abort())
      void hydrateRestoredSessionChain(id, [...ids], controller.signal, undefined, { resolveListPlacement: true }).catch(error => {
        if (!controller.signal.aborted) log.warn("Could not load favorite sessions", error)
      })
    }))

  createEffect(() => {
    const selected = normalizeSessionDirectory(worktreeDirectory())
    if (!selected) return
    const exists = getWorktrees(props.instanceId).some((worktree) => (
      normalizeSessionDirectory(worktree.serviceDirectory ?? worktree.directory) === selected
    ))
    if (!exists) setWorktreeDirectory("")
  })

  const [selectedSessionIds, setSelectedSessionIds] = createSignal<Set<string>>(new Set())
  const [reloadingSessionIds, setReloadingSessionIds] = createSignal<Set<string>>(new Set())
  const [listEl, setListEl] = createSignal<HTMLDivElement>()
  preserveListFocus(listEl)
  const [listViewportAttached, setListViewportAttached] = createSignal(false)
  const [virtualizerHandle, setVirtualizerHandle] = createSignal<VirtualizerHandle>()
  const [focusedSessionId, setFocusedSessionId] = createSignal<string>()
  const [actionFocusSessionId, setActionFocusSessionId] = createSignal<string>()
  let actionFocus: ReturnType<typeof claimActionFocus>
  onCleanup(() => actionFocus?.release())
  const [menuSessionId, setMenuSessionId] = createSignal<string>()
  const [expanderMenuSessionId, setExpanderMenuSessionId] = createSignal<string>()
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

  const [sentinelEl, setSentinelEl] = createSignal<HTMLDivElement | null>(null)

  const hasMore = createMemo(() => {
    if (normalizedQuery()) return false
    return getSessionHasMore(props.instanceId)
  })

  const isFetchingSessions = createMemo(() => {
    return loading().fetchingSessions.get(props.instanceId) ?? false
  })
  const sessionListError = createMemo(() => getSessionListError(props.instanceId))
  // Over the listed sessions only, like the rows and the tab indicator.
  const listedSessions = createMemo(() => getListedSessionMap(props.instanceId))

  createEffect(() => {
    const sort = sortBy()
    const key = `${props.instanceId}:${sort}`
    if (sort === "activity" && !props.enableFilterBar) {
      failedSortExhaustion = undefined
      return
    }
    if (normalizedQuery() || failedSortExhaustion === key
      || !getSessionHasMore(props.instanceId) || isFetchingSessions()) return
    void loadAllSessions(props.instanceId).catch((error) => {
      failedSortExhaustion = key
      log.error("Failed to load all sessions for sorting:", error)
    })
  })

  const handleRetrySessions = () => {
    failedSortExhaustion = undefined
    void fetchSessions(props.instanceId, { reset: true }).catch((error) => {
      log.error("Failed to retry session list:", error)
    })
  }

  createEffect(() => {
    const el = sentinelEl()
    if (!el || !hasMore() || isFetchingSessions()) return

    onCleanup(observeListEnd(el, listEl() ?? null, () => {
        if (hasMore() && !isFetchingSessions()) {
          failedSortExhaustion = undefined
          void loadMoreSessions(props.instanceId).catch((error) => {
            log.error("Failed to load more sessions:", error)
          })
        }
    }, 200))
  })

  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null
  createEffect(() => {
    const query = normalizedQuery()
    const operation = captureBackendOperation(props.instanceId)
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
      if (!operation.current()) return
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

  const worktreeLabelByDirectory = createMemo(() => {
    const labels = new Map<string, string | undefined>()
    const rootLabel = t("sessionList.worktree.workspace")
    for (const candidate of getWorktrees(props.instanceId)) {
      const key = normalizeSessionDirectory(candidate.serviceDirectory ?? candidate.directory)
      if (labels.has(key)) continue
      labels.set(key, candidate.kind === "root" ? rootLabel : candidate.label ?? candidate.slug)
    }
    return labels
  })
  const getWorktreeLabel = (directory: string) =>
    worktreeLabelByDirectory().get(normalizeSessionDirectory(directory)) ?? directory
  const normalThreads = createMemo(() => projectSessionFamilies(projectUnarchivedSessionThreads(props.threads, props.activeSessionId), {
    sort: "activity", getWorktreeLabel, favoriteIds: favorites(),
  }))
  const searchMatches = createMemo<SessionThread[]>(() => {
    if (!props.enableFilterBar) return []
    const query = normalizedQuery()
    const hasSearchResults = query && getSessionSearchQuery(props.instanceId) === query && !isSessionSearchLoading(props.instanceId)
    const instanceSessions = sessionStateSessions().get(props.instanceId)
    const candidates = hasSearchResults ? getSessionSearchSessions(props.instanceId)
      : collectSessionThreadIds(props.threads).flatMap(id => {
        const session = instanceSessions?.get(id)
        return session ? [session] : []
      })
    return projectSessionSearchResults(candidates, {
      sort: sortBy(),
      favoriteIds: favorites(),
      worktreeDirectory: worktreeDirectory(),
      includeSubsessions: true,
      includeMainSessions: true,
      archive: archiveFilter(),
      getWorktreeLabel,
      matchesSession: session => (!favoritesOnly() || favorites().has(session.id))
        && (!query || Boolean(hasSearchResults) || sessionMatchesQuery(session.id, query)),
    })
  })
  const filteredThreads = createMemo(() => {
    if (!props.enableFilterBar) return normalThreads()
    return searchMatches().filter(({ session }) => session.parentId ? includeSubsessions() : includeMainSessions())
  })
  const hiddenMatchCount = createMemo(() =>
    normalizedQuery() ? searchMatches().length - filteredThreads().length : 0)

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
  createEffect(() => {
    view.ids = visibleProjection().ids
    view.projected = true
  })
  const keptMountedIndexes = createMemo(() => {
    const indexes = new Set<number>()
    for (const sessionId of [focusedSessionId(), menuSessionId(), expanderMenuSessionId(), actionFocusSessionId()]) {
      const index = sessionId ? visibleProjection().indexById.get(sessionId) : undefined
      if (index !== undefined) indexes.add(index)
    }
    return indexes.size ? [...indexes] : undefined
  })

  const allMatchingSessionIds = createMemo<string[]>(() => {
    if (!props.enableFilterBar) return []
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

  createEffect(() => {
    const available = new Set(allMatchingSessionIds())
    setSelectedSessionIds((selected) => {
      const next = new Set([...selected].filter((id) => available.has(id)))
      return next.size === selected.size ? selected : next
    })
  })

  const isAllSelected = createMemo(() => {
    const selected = selectedSessionIds()
    if (!selected.size) return false
    const ids = allMatchingSessionIds()
    if (ids.length === 0) return false
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
        showToastNotification({ category: "copy", message: t("sessionList.copyId.success"), variant: "success" })
      } else {
        showToastNotification({ category: "copy", message: t("sessionList.copyId.error"), variant: "error" })
      }
    } catch (error) {
      log.error(`Failed to copy session ID ${sessionId}:`, error)
      showToastNotification({ category: "copy", message: t("sessionList.copyId.error"), variant: "error" })
    }
  }
 
  const handleDeleteSession = async (sessionId: string) => {
    if (isSessionDeleting(sessionId)) return
    const operation = captureBackendOperation(props.instanceId)
    if (!operation.current()) return
    const intent = beginGesture({ instanceId: props.instanceId, sessionId: props.activeSessionId ?? null })
    const confirmed = await showConfirmDialog(
      t("sessionList.delete.confirmMessage", { label: normalizeSessionLabel(sessionId) }),
      {
        title: t("sessionList.delete.title"),
        detail: includesFavorite(sessionId) ? t("sessionList.favorite.deleteWarning") : undefined,
        variant: "warning",
        confirmLabel: t("sessionList.delete.confirmLabel"),
        cancelLabel: t("sessionList.delete.cancelLabel"),
        dismissible: false,
      },
    )
    if (!confirmed || !operation.current()) return

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
      if (!operation.current()) return
      if (fallbackSessionId) {
        setActiveSessionFromList(props.instanceId, fallbackSessionId, intent)
      }
    } catch (error) {
      if (!operation.current()) return
      log.error(`Failed to delete session ${sessionId}:`, error)
      showToastNotification({ category: "sessions", message: t("sessionList.delete.error"), variant: "error" })
    }
  }

  const openRenameDialog = (sessionId: string) => {
    const session = sessionStateSessions().get(props.instanceId)?.get(sessionId)
    if (!session) return
    const label = session.title && session.title.trim() ? session.title : sessionId
    setRenameTarget({ id: sessionId, title: session.title ?? "", label })
  }

  const handleArchiveSession = async (sessionId: string) => {
    const instanceId = props.instanceId
    const session = sessionStateSessions().get(instanceId)?.get(sessionId)
    if (!session || archivingSessionIds().has(sessionId)) return
    const archived = !isSessionArchived(session)
    setArchivingSessionIds(previous => new Set(previous).add(sessionId))
    try {
      await setSessionArchived(instanceId, sessionId, archived)
    } catch (error) {
      log.error("Failed to change native session archive", { instanceId, sessionId, error })
      if (props.instanceId === instanceId) showToastNotification({ category: "sessions", variant: "error",
        message: t(archived ? "sessionList.archive.error" : "sessionList.restore.error") })
    } finally {
      setArchivingSessionIds(previous => { const next = new Set(previous); next.delete(sessionId); return next })
    }
  }

  const isSessionReloading = (sessionId: string) => reloadingSessionIds().has(sessionId)

  const handleReloadSession = async (sessionId: string) => {
    if (isSessionReloading(sessionId)) return
    const operation = captureBackendOperation(props.instanceId)
    if (!operation.current()) return

    setReloadingSessionIds((prev) => {
      const next = new Set(prev)
      next.add(sessionId)
      return next
    })

    try {
      await loadMessages(props.instanceId, sessionId, { force: true, signal: operation.signal })
    } catch (error) {
      if (!operation.current()) return
      log.error(`Failed to reload session ${sessionId}:`, error)
      showToastNotification({ category: "sessions", message: t("sessionList.reload.error"), variant: "error" })
    } finally {
      setReloadingSessionIds((prev) => {
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    }
  }

  // Acknowledges a finished row: its Interrupted and Idle badges hide until a new boundary.
  const clearSessionStatus = (sessionId: string) => {
    const session = sessionStateSessions().get(props.instanceId)?.get(sessionId)
    if (!session) return
    batch(() => {
      markSessionInterruptionSeen(props.instanceId, session)
      markSessionIdleSeen(props.instanceId, sessionId)
      clearSessionIdleFade(props.instanceId, sessionId)
    })
  }

  const closeRenameDialog = () => {
    setRenameTarget(null)
  }

  const handleRenameSubmit = async (nextTitle: string) => {
    const target = renameTarget()
    if (!target) return
    const operation = captureBackendOperation(props.instanceId)
    if (!operation.current()) return
 
    setIsRenaming(true)
    try {
      await renameSession(props.instanceId, target.id, nextTitle)
      if (!operation.current()) return
      setRenameTarget(null)
    } catch (error) {
      if (!operation.current()) return
      log.error(`Failed to rename session ${target.id}:`, error)
      showToastNotification({ category: "sessions", message: t("sessionList.rename.error"), variant: "error" })
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
    const thread = findSessionThread(filteredThreads(), sessionId)
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
    const operation = captureBackendOperation(props.instanceId)
    if (!operation.current()) return
    const selected = Array.from(selectedSessionIds())
    if (selected.length === 0) return
    const intent = beginGesture({ instanceId: props.instanceId, sessionId: props.activeSessionId ?? null })
    const confirmed = await showConfirmDialog(
      t(selected.length === 1 ? "sessionList.bulkDelete.confirmMessage.one" : "sessionList.bulkDelete.confirmMessage.other", { count: selected.length }),
      {
        title: t("sessionList.bulkDelete.title"),
        detail: selected.some(includesFavorite) ? t("sessionList.favorite.deleteWarning") : undefined,
        variant: "warning",
        confirmLabel: t("sessionList.bulkDelete.confirmLabel"),
        cancelLabel: t("sessionList.bulkDelete.cancelLabel"),
        dismissible: false,
      },
    )

    if (!confirmed || !operation.current()) return

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
      if (!operation.current()) return
      try {
        // eslint-disable-next-line no-await-in-loop
        await deleteSession(props.instanceId, sessionId)
      } catch (error) {
        failed += 1
        log.error(`Failed to delete session ${sessionId}:`, error)
      }
    }

    if (!operation.current()) return
    setSelectedSessionIds(new Set<string>())

    if (fallbackSessionId) {
      setActiveSessionFromList(props.instanceId, fallbackSessionId, intent)
    }

    if (failed > 0) {
      showToastNotification({ category: "sessions",
        message: t(failed === 1 ? "sessionList.bulkDelete.error.one" : "sessionList.bulkDelete.error.other", { count: failed }),
        variant: "error",
      })
    }
  }

  function claimActionFocus(sessionId: string): {
    sessionId: string
    release: () => void
    restore: (releaseAfter: boolean, fallback?: HTMLElement) => void
  } | undefined {
    const list = listEl()
    const instanceId = props.instanceId
    const rowSelector = `.session-item-base[data-session-id="${CSS.escape(sessionId)}"]`
    const overflowTrigger = ".action-overflow-trigger"
    const favoriteButton = ".session-item-inline-actions [data-action-key='favorite']"
    const isAction = (target: EventTarget | null) => target instanceof Element
      && !!target.closest(`${overflowTrigger}, ${favoriteButton}`)?.closest(rowSelector)
      && Boolean(list?.contains(target))
    if (!list || !isAction(document.activeElement)) return
    actionFocus?.release()

    const controller = new AbortController()
    let frame = 0
    const release = () => {
      controller.abort()
      cancelAnimationFrame(frame)
      if (actionFocus?.release === release) {
        actionFocus = undefined
        setActionFocusSessionId(undefined)
      }
    }
    const options = { capture: true, signal: controller.signal }
    document.addEventListener("focusin", event => {
      if (event.target !== document.body && !isAction(event.target)) release()
    }, options)
    window.addEventListener("blur", release, { signal: controller.signal })
    document.addEventListener("keydown", event => { if (event.key === "Tab") release() }, options)
    document.addEventListener("pointerdown", event => {
      // A resize drag prevents pointerdown's focus change.
      queueMicrotask(() => {
        if (!controller.signal.aborted && !event.defaultPrevented && !isAction(event.target)) release()
      })
    }, options)

    const restore = (releaseAfter: boolean, fallback?: HTMLElement) => {
      cancelAnimationFrame(frame)
      const done = () => { if (releaseAfter) release() }
      // Keep the row mounted by ID while Virtua applies its new index and geometry.
      let framesLeft = 12
      const settle = () => {
        if (controller.signal.aborted || props.instanceId !== instanceId || listEl() !== list || !list.isConnected
          || !document.hasFocus() || (document.activeElement !== document.body && !isAction(document.activeElement))) {
          release()
          return
        }
        if (!visibleProjection().indexById.has(sessionId)) {
          fallback?.focus({ preventScroll: true })
          done()
          return
        }
        const row = list.querySelector<HTMLElement>(rowSelector)
        const button = row?.querySelector<HTMLButtonElement>(
          row.dataset.compactActions === "true" ? overflowTrigger : favoriteButton,
        )
        if (row && button && !button.closest("[inert]") && button.checkVisibility({ checkVisibilityCSS: true })) {
          const bounds = row.getBoundingClientRect(), top = list.getBoundingClientRect().top + list.clientTop
          const bottom = top + list.clientHeight
          const delta = bounds.top < top - 0.5 ? bounds.top - top
            : bounds.bottom > bottom + 0.5 ? bounds.bottom - bottom : 0
          if (delta) list.scrollTop += delta
          else {
            button.focus({ preventScroll: true })
            if (document.activeElement === button) { done(); return }
          }
        }
        // Bound retries if the panel becomes hidden or its controls disappear.
        if (--framesLeft) frame = requestAnimationFrame(settle)
        else done()
      }
      frame = requestAnimationFrame(settle)
    }
    const claimed = { sessionId, release, restore }
    actionFocus = claimed
    setActionFocusSessionId(sessionId)
    return claimed
  }

  const toggleFavorite = async (sessionId: string) => {
    const instanceId = props.instanceId
    if (!favoriteStore.ready() || favoriteStore.pending().has(sessionId)
      || !isSessionInWorkspaceScope(instanceId, sessionId)) return
    const remove = favorites().has(sessionId)
    const focus = claimActionFocus(sessionId)
    try {
      await favoriteStore.save(sessionId, !remove)
      if (focus && actionFocus === focus) focus.restore(true,
        remove && !favorites().has(sessionId) && props.enableFilterBar && favoritesOnly() ? favoritesFilter : undefined)
    } catch {
      focus?.release()
      showToastNotification({ category: "sessions", variant: "error", message: t("sessionList.favorite.error") })
    }
  }

  const resetFilters = () => batch(() => {
    setFilterQuery("")
    setSortBy("activity")
    setWorktreeDirectory("")
    setIncludeMainSessions(true)
    setIncludeSubsessions(false)
    setArchiveFilter("active")
    setFavoritesOnly(false)
    setSelectedSessionIds(new Set<string>())
  })

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
    const isSubsession = () => Boolean(rowProps.session.parentId)
    const archived = createMemo(() => isSessionArchived(rowProps.session))

    const worktreeSlug = createMemo(() => {
      if (isChild()) return ""
      const slug = getWorktreeSlugForParentSession(props.instanceId, sessionId())
      return slug === "root" ? "" : getWorktrees(props.instanceId).find(entry => entry.slug === slug)?.label ?? slug
    })

    const showWorktreeBadge = createMemo(() => {
      if (isChild()) return false
      if (getGitRepoStatus(props.instanceId) !== true) return false
      return Boolean(worktreeSlug())
    })

    const isActive = () => props.activeSessionId === sessionId()
    // A parent's chevron carries its subsessions' visible status, expanded or not.
    const descendantActivity = createDescendantActivity(
      listedSessions, () => rowProps.hasChildren ? sessionId() : undefined,
      (session, now, wakeAt) => !session.retry && session.generationRecovery !== "interrupted"
        && shouldShowSessionStatusForRow(props.instanceId, session, now, preferences().keepUnseenSubagentIdleStatus, wakeAt),
    )
    const childActivity = () => rowProps.hasChildren ? descendantActivity() : undefined
    // The row and descendants whose Idle or Interrupted badge "Mark as read" clears.
    const readableHierarchy = (now: number, wakeAt?: (deadline: number) => void) => [rowProps.session, ...getDescendantSessions(props.instanceId, sessionId())]
      .filter(session => session.status === "idle" && !session.pendingPermission && !session.pendingForm
        && (isSessionInterruptionUnseen(props.instanceId, session)
          || shouldShowSessionStatusForRow(props.instanceId, session, now, preferences().keepUnseenSubagentIdleStatus, wakeAt)))
      .map(session => session.id)
    const markReadDisabled = createDeadlineMemo((now, wakeAt) =>
      expanderMenuSessionId() !== sessionId() || readableHierarchy(now, wakeAt).length === 0)
    // Observe activity independently of expansion: folding a busy branch is not
    // a new activity transition. Visible descendants follow the same rule.
    const activityKind = createMemo(() => {
      const activity = descendantActivity()
      return activity ? childActivityKind(activity) : undefined
    })
    createEffect(on(activityKind, (kind, previous) => {
      if (kind === previous || !kind || kind === "idle" || rowProps.expanded
        || props.enableFilterBar || !preferences().autoExpandActiveSubsessions) return
      const active = props.activeSessionId
      if (!active || (!isActive() && !getSessionAncestorIds(props.instanceId, sessionId()).includes(active))) return
      const row = rowElement()?.getBoundingClientRect(), viewport = listEl()?.getBoundingClientRect()
      // Virtua also mounts buffered rows beyond the viewport; only visible rows reveal.
      if (!row || !viewport || row.width <= 0 || row.height <= 0
        || row.bottom <= Math.max(0, viewport.top) || row.top >= Math.min(window.innerHeight, viewport.bottom)
        || row.right <= Math.max(0, viewport.left) || row.left >= Math.min(window.innerWidth, viewport.right)) return
      for (const descendant of getDescendantSessions(props.instanceId, sessionId())) {
        if (descendant.pendingPermission || descendant.pendingForm
          || descendant.status === "working" || descendant.status === "compacting") {
          revealSubsession(props.instanceId, descendant.id)
        }
      }
    }, { defer: true }))
    const expanderLabel = (key: string) => {
      const label = t(`sessionList.expand.${key}`)
      const activity = childActivity()
      return activity ? t("sessionList.expand.withChildActivity", { action: label, activity: childActivityLabel(t, activity) }) : label
    }
    const title = () => rowProps.session.title || t("sessionList.session.untitled")
    const status = () => rowProps.session.status
    const interrupted = () => isSessionInterruptionUnseen(props.instanceId, rowProps.session)
    const retry = () => rowProps.session.retry
    const statusLabel = createDeadlineMemo((now, wakeAt) => {
      if (interrupted()) return t("sessionList.status.interrupted")
      if (rowProps.session.pendingPermission || rowProps.session.pendingForm) return ""
      const retryState = retry()
      if (retryState) {
        const seconds = getRetrySeconds(retryState.next, now, wakeAt)
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
    })
    const needsPermission = () => Boolean(rowProps.session.pendingPermission)
    const needsQuestion = () => Boolean(rowProps.session.pendingForm)
    const needsInput = () => needsPermission() || needsQuestion()
    const statusClassName = () => {
      if (needsInput()) return "session-permission"
      if (interrupted()) return "session-interrupted"
      const base = `session-${retry() ? "retrying" : status()}`
      const fadeClass = idleFadeClassForSession(props.instanceId, rowProps.session)
      return fadeClass ? `${base} ${fadeClass}` : base
    }
    const showStatus = createDeadlineMemo((now, wakeAt) =>
      interrupted() ||
      needsInput() ||
      shouldShowSessionStatusForRow(
        props.instanceId,
        rowProps.session,
        now,
        preferences().keepUnseenSubagentIdleStatus,
        wakeAt,
      ))
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
    // Only finished states are acknowledged; work and input requests always stay visible.
    const statusClearable = () => !needsInput() && !retry() && status() === "idle"
    const statusContent = () => (
      <>
        {needsInput() ? <ShieldAlert class="w-3.5 h-3.5" aria-hidden="true" /> : <span class="status-dot" />}
        <span class="session-item-status-label">{statusText()}</span>
      </>
    )
    const selectRow = () => {
      selectSession(sessionId())
      if (needsInput()) focusInterruption(props.instanceId, sessionId())
    }
 
    const isSelected = () => selectedSessionIds().has(sessionId())

    const UNSELECTED_GROUP_STATE = { checked: false, indeterminate: false } as const

    const parentGroupState = createMemo(() => {
      if (!props.enableFilterBar) return UNSELECTED_GROUP_STATE
      const selected = selectedSessionIds()
      if (selected.size === 0) return UNSELECTED_GROUP_STATE
      const ids = rowProps.hasChildren ? getSelectableThreadIds(sessionId()) : [sessionId()]
      const selectedInGroup = ids.reduce((count, id) => (selected.has(id) ? count + 1 : count), 0)
      return {
        checked: selectedInGroup > 0 && selectedInGroup === ids.length,
        indeterminate: selectedInGroup > 0 && selectedInGroup < ids.length,
      }
    })

    let rowCheckboxEl: HTMLInputElement | null = null
    createEffect(() => {
      if (!rowCheckboxEl) return
      rowCheckboxEl.indeterminate = parentGroupState().indeterminate
    })

    const nestedStyle = () => {
      if (!isChild()) return undefined
      return {
        "--session-indent": `calc(var(--session-root-indent) + ${rowProps.depth} * var(--session-tree-step))`,
      }
    }

    const [rowElement, setRowElement] = createSignal<HTMLDivElement>()
    const menuOpen = () => menuSessionId() === sessionId()
    const overflow = useSessionRowOverflow(rowElement)
    const compactActions = () => overflow() || menuOpen()
    const releaseMenu = () => {
      if (!menuOpen()) return
      const resizeHandoff = !overflow()
      const pending = actionFocus?.sessionId === sessionId() ? actionFocus : undefined
      const focus = resizeHandoff ? pending ?? claimActionFocus(sessionId()) : undefined
      setMenuSessionId(undefined)
      focus?.restore(!pending)
    }
    const favorite = () => favorites().has(sessionId())
    const favoriteLabel = () => t(favorite() ? "sessionList.favorite.remove" : "sessionList.favorite.add")
    const actionItems: ActionOverflowMenuItem[] = [
      {
        key: "favorite",
        get label() { return favoriteLabel() },
        get icon() { return <Star class="w-3.5 h-3.5" fill={favorite() ? "currentColor" : "none"} /> },
        get disabled() { return !favoriteStore.ready() || favoriteStore.pending().has(sessionId()) || !isSessionInWorkspaceScope(props.instanceId, sessionId()) },
        onSelect: () => toggleFavorite(sessionId()),
      },
      {
        key: "rename",
        get label() { return t("sessionList.actions.rename.title") },
        get icon() { return <Pencil class="w-3.5 h-3.5" /> },
        onSelect: () => openRenameDialog(sessionId()),
      },
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
        key: "archive",
        get label() { return t(archived() ? "sessionList.actions.restore.title" : "sessionList.actions.archive.title") },
        get icon() { return archived() ? <ArchiveRestore class="w-3.5 h-3.5" /> : <Archive class="w-3.5 h-3.5" /> },
        get disabled() { return archivingSessionIds().has(sessionId()) || isSessionDeleting(sessionId()) },
        onSelect: () => handleArchiveSession(sessionId()),
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
          class={`session-item-base ${isChild() ? "session-item-nested" : ""} ${isChild() && rowProps.isLastChild ? "session-item-child-last" : ""} ${isSubsession() ? "session-item-border-assistant session-item-kind-assistant" : "session-item-border-user session-item-kind-user"} ${isActive() ? "session-item-active" : "session-item-inactive"}`}
          style={nestedStyle()}
          data-session-id={sessionId()}
          ref={setRowElement}
          data-compact-actions={compactActions()}
          data-favorite={favorite() || undefined}
        >
          <Show when={props.enableFilterBar}>
            <input
              ref={(el) => {
                rowCheckboxEl = el
              }}
              type="checkbox"
              checked={parentGroupState().checked}
              data-toggle-sweep={toggleSweepGroup("session-selection")}
              onChange={(event) => {
                const ids = rowProps.hasChildren ? getSelectableThreadIds(sessionId()) : [sessionId()]
                setSelectedMany(ids, event.currentTarget.checked)
              }}
              aria-label={t("sessionList.selection.checkboxAriaLabel")}
            />
          </Show>
          <Show
            when={rowProps.hasChildren}
            fallback={<span class="session-item-expander session-item-expander--spacer" aria-hidden="true" />}
          >
            <SessionExpander
              class={`session-item-expander opacity-80 hover:opacity-100 ${isActive() ? "hover:bg-white/20" : "hover:bg-surface-hover"}`}
              expanded={Boolean(rowProps.expanded)}
              activity={childActivity() ? childActivityKind(childActivity()!) : undefined}
              label={expanderLabel(rowProps.expanded ? "collapseAriaLabel" : "expandAriaLabel")}
              title={expanderLabel(rowProps.expanded ? "collapseTitle" : "expandTitle")}
              markReadLabel={t("sessionList.expand.markRead")}
              markReadDisabled={markReadDisabled()}
              onToggle={() => rowProps.onToggleExpand?.()}
              onMarkRead={() => batch(() => readableHierarchy(Date.now()).forEach(clearSessionStatus))}
              onOpenChange={(open) => setExpanderMenuSessionId(open ? sessionId() : undefined)}
            />
          </Show>
          <button
            type="button"
            class="session-item-select"
            onClick={selectRow}
            title={title()}
            aria-current={isActive() ? "true" : undefined}
            aria-description={favorite() ? t("sessionList.favorite.label") : undefined}
          >
            <Show when={isSubsession()} fallback={<User class="session-item-kind-icon w-4 h-4 flex-shrink-0" aria-hidden="true" />}>
              <Bot class="session-item-kind-icon w-4 h-4 flex-shrink-0" aria-hidden="true" />
            </Show>
            <span class="session-item-title session-item-title--clamp" dir="auto">{title()}</span>
            <Show when={compactActions() && favorite()}>
              <Star class="session-item-favorite" size={12} fill="currentColor" aria-hidden="true" />
            </Show>
          </button>
          {/* Badges sit beside the select button so a clearable one can be its own button;
              the rest of the badge area still selects the row. */}
          <span
            class="session-item-badges"
            onClick={(event) => { if (!(event.target as Element).closest("button")) selectRow() }}
          >
            <Show when={archived()}>
              <span class="status-indicator session-status-list" title={t("sessionList.status.archived")}>
                <Archive class="w-3.5 h-3.5" aria-hidden="true" />
                <span>{t("sessionList.status.archived")}</span>
              </span>
            </Show>
            <Show when={showStatus()}>
              <Show
                when={statusClearable()}
                fallback={
                  <span
                    class={`status-indicator session-status session-status-list ${statusClassName()} notranslate`}
                    title={needsInput() ? statusText() : statusTooltip()}
                    translate="no"
                  >
                    {statusContent()}
                  </span>
                }
              >
                <button
                  type="button"
                  class={`status-indicator session-status session-status-list session-status-clearable ${statusClassName()} notranslate`}
                  title={t("sessionList.status.clear")}
                  aria-label={t("sessionList.status.clearAriaLabel", { status: statusText() })}
                  translate="no"
                  data-toggle-sweep={toggleSweepGroup("session-status-clear")}
                  ref={(element) => toggleSweepClear(element)}
                  onClick={() => clearSessionStatus(sessionId())}
                >
                  {statusContent()}
                </button>
              </Show>
            </Show>
            <Show when={showWorktreeBadge()}>
              <span class="status-indicator session-status-list worktree-indicator" title={t("sessionList.worktree.tooltip", { worktree: worktreeSlug() })}>
                <Split class="w-3.5 h-3.5" aria-hidden="true" />
                <span class="worktree-indicator-label">{worktreeSlug()}</span>
              </span>
            </Show>
          </span>
          <div class="session-item-actions">
            <div class="session-item-inline-actions" inert={compactActions()}>
              <For each={actionItems}>{item => (
                <button
                  type="button"
                  class="session-item-close"
                  title={item.label}
                  aria-label={item.label}
                  aria-disabled={item.disabled || undefined}
                  data-favorite-action={item.key === "favorite" ? favorite() : undefined}
                  data-action-key={item.key}
                  onClick={() => { if (!item.disabled) void item.onSelect() }}
                >
                  {item.icon}
                </button>
              )}</For>
            </div>
            <div class="session-item-overflow-actions">
              <ActionOverflowMenu label={t("messageItem.actions.more")} items={actionItems}
                onOpenChange={open => { if (open) setMenuSessionId(sessionId()) }} onFocusRestored={releaseMenu} />
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
                ref={searchInput}
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

          <div class="mt-2 grid grid-cols-2 gap-2">
            <select
              class="selector-input min-w-0"
              value={sortBy()}
              onChange={(event) => setSortBy(event.currentTarget.value as SessionFamilySort)}
              aria-label={t("sessionList.sort.ariaLabel")}
            >
              <option value="activity">{t("sessionList.sort.activity")}</option>
              <option value="name">{t("sessionList.sort.name")}</option>
              <option value="worktree">{t("sessionList.sort.worktree")}</option>
            </select>
            <select
              class="selector-input min-w-0"
              value={worktreeDirectory()}
              onChange={(event) => setWorktreeDirectory(event.currentTarget.value)}
              aria-label={t("sessionList.worktreeFilter.ariaLabel")}
            >
              <option value="">{t("sessionList.worktreeFilter.all")}</option>
              {getWorktrees(props.instanceId).map((worktree) => (
                <option value={worktree.serviceDirectory ?? worktree.directory}>{worktree.kind === "root" ? t("sessionList.worktree.workspace") : worktree.label ?? worktree.slug}</option>
              ))}
            </select>
          </div>

          <select class="selector-input mt-2 w-full min-w-0" value={archiveFilter()}
            onChange={event => setArchiveFilter(event.currentTarget.value as SessionArchiveFilter)}
            aria-label={t("sessionList.archiveFilter.ariaLabel")}>
            <option value="active">{t("sessionList.archiveFilter.active")}</option>
            <option value="archived">{t("sessionList.archiveFilter.archived")}</option>
            <option value="all">{t("sessionList.archiveFilter.all")}</option>
          </select>

          <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-secondary">
            <label class="flex items-center gap-2">
              <input
                type="checkbox"
                role="switch"
                checked={includeMainSessions()}
                onChange={(event) => setIncludeMainSessions(event.currentTarget.checked)}
              />
              {t("sessionList.filter.includeMainSessions")}
            </label>
            <label class="flex items-center gap-2">
              <input
                type="checkbox"
                role="switch"
                checked={includeSubsessions()}
                onChange={(event) => setIncludeSubsessions(event.currentTarget.checked)}
              />
              {t("sessionList.filter.includeSubsessions")}
            </label>
          </div>
          <div class="mt-2 flex items-center justify-between gap-2">
            <button type="button" class="icon-toggle button-tertiary inline-flex items-center gap-2"
              ref={favoritesFilter} aria-pressed={favoritesOnly()} onClick={() => batch(() => {
                if (!favoritesOnly()) setIncludeSubsessions(true)
                setFavoritesOnly(value => !value)
              })}>
              <Star size={14} aria-hidden="true" />{t("sessionList.favorite.only")}
            </button>
            <button type="button" class="button-tertiary" onClick={resetFilters}>{t("sessionList.filter.reset")}</button>
          </div>

          <Show when={hiddenMatchCount() > 0}>
            <button type="button" class="button-tertiary mt-2 w-full" onClick={() => {
              searchInput?.focus({ preventScroll: true })
              batch(() => { setIncludeMainSessions(true); setIncludeSubsessions(true) })
            }}>
              {t(hiddenMatchCount() === 1 ? "sessionList.filter.showHidden.one" : "sessionList.filter.showHidden.other",
                { count: hiddenMatchCount() })}
            </button>
          </Show>

          <Show when={selectedCount() > 0}>
            <div class="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                class="button-tertiary"
                onClick={handleBulkDelete}
                aria-label={t(selectedCount() === 1 ? "sessionList.bulkDelete.ariaLabel.one" : "sessionList.bulkDelete.ariaLabel.other", { count: selectedCount() })}
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

          <Show when={props.enableFilterBar && favoritesOnly() && !sessionListError() && !hasMore()
            && !isFetchingSessions() && !isSessionSearchLoading(props.instanceId) && visibleProjection().ids.length === 0}>
            <div class="p-3 text-xs text-muted" role="status">{t("sessionList.favorite.empty")}</div>
          </Show>

          <Show when={!sessionListError() && (hasMore() || isFetchingSessions()) && visibleProjection().ids.length === 0}>
            <div class="flex items-center justify-center p-4 text-xs text-muted" role="status">
              <span class="animate-pulse">{t("sessionList.loading.initial")}</span>
            </div>
          </Show>

          <Show when={shouldRenderSessionRows(
            Boolean(sessionListError()),
            listViewportAttached() && (visibleProjection().ids.length > 0 || hasMore() || isFetchingSessions()),
            visibleProjection().ids.length > 0,
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
                   const row = createMemo(() => visibleProjection().rowsById.get(sessionId), undefined, {
                     equals: (a, b) => a === b || Boolean(a && b && a.thread === b.thread
                       && a.depth === b.depth && a.isLastChild === b.isLastChild
                       && a.hasChildren === b.hasChildren && a.expanded === b.expanded),
                   })
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
