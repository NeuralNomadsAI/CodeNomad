import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import type { PromptInputApi } from "../../../prompt-input/types"
import type { GitChangeEntry, GitChangeListItem, GitSelectionDescriptor, RightPanelTab } from "./types"

import { getRootClient } from "../../../../stores/opencode-client"
import { instances } from "../../../../stores/instances"
import { getWorktrees } from "../../../../stores/worktrees"
import { serverApi } from "../../../../lib/api-client"
import { showToastNotification } from "../../../../lib/notifications"
import { adaptSdkGitStatusEntries, buildGitChangeListItems } from "./git-changes-model"
import { createDebouncedRefresh, filesystemInvalidationVersion, invalidateFilesystemCaches } from "../../../../lib/filesystem-events"
import { backgroundReads } from "../../../../lib/background-read-queue"

type UseGitChangesOptions = {
  isActive: Accessor<boolean>
  t: (key: string, vars?: Record<string, any>) => string
  instanceId: string
  rightPanelTab: Accessor<RightPanelTab>
  worktreeSlug: Accessor<string>
  isPhoneLayout: Accessor<boolean>
  promptInputApi: Accessor<PromptInputApi | null>
  closeGitList: () => void
  externalDiff?: boolean
}

export function useGitChanges(options: UseGitChangesOptions) {
  const [gitStatusEntries, setGitStatusEntries] = createSignal<GitChangeEntry[] | null>(null)
  const [gitStatusLoading, setGitStatusLoading] = createSignal(false)
  const [gitStatusError, setGitStatusError] = createSignal<string | null>(null)
  const [gitSelectedItemId, setGitSelectedItemId] = createSignal<string | null>(null)
  const [gitBulkSelectedItemIds, setGitBulkSelectedItemIds] = createSignal<Set<string>>(new Set())
  const [gitBulkSelectionAnchorId, setGitBulkSelectionAnchorId] = createSignal<string | null>(null)
  const [gitSelectedLoading, setGitSelectedLoading] = createSignal(false)
  const [gitSelectedError, setGitSelectedError] = createSignal<string | null>(null)
  const [gitSelectedBefore, setGitSelectedBefore] = createSignal<string | null>(null)
  const [gitSelectedAfter, setGitSelectedAfter] = createSignal<string | null>(null)
  const [gitCommitMessage, setGitCommitMessage] = createSignal("")
  const [gitCommitSubmitting, setGitCommitSubmitting] = createSignal(false)
  let gitStatusRequestVersion = 0
  let gitDiffRequestVersion = 0
  let passiveGitRefresh: object | null = null
  let statusController: AbortController | undefined
  let diffController: AbortController | undefined
  let lifecycle = 0
  let disposed = false
  let commitOperation: object | null = null
  let pendingGitPassiveRefreshOptions: { forceReloadSelectedDiff?: boolean } | null = null
  let previousGitChangesActivationKey: string | null = null
  let seenFilesystemInvalidation = filesystemInvalidationVersion(options.instanceId)

  const gitListItems = createMemo(() => buildGitChangeListItems(gitStatusEntries()))
  const gitActive = createMemo(() => options.isActive() && options.rightPanelTab() === "git-changes")
  const cancelGitReads = () => {
    lifecycle += 1
    gitStatusRequestVersion += 1
    gitDiffRequestVersion += 1
    statusController?.abort()
    diffController?.abort()
    passiveGitRefresh = null
    pendingGitPassiveRefreshOptions = null
  }
  onCleanup(() => { disposed = true; cancelGitReads() })
  const captureGitContext = () => {
    const generation = lifecycle, slug = options.worktreeSlug()
    return { slug, current: () => !disposed && gitActive() && generation === lifecycle && slug === options.worktreeSlug() }
  }

  const gitLocation = (slug: string) => {
    const directory = getWorktrees(options.instanceId).find((worktree) => worktree.slug === slug)?.directory
      ?? (slug === "root" ? instances().get(options.instanceId)?.folder : undefined)
    if (!directory) throw new Error(`Missing directory for worktree ${slug}`)
    return { directory }
  }

  const clearGitBulkSelection = () => {
    setGitBulkSelectedItemIds((current) => (current.size === 0 ? current : new Set<string>()))
    setGitBulkSelectionAnchorId(null)
  }

  const toggleGitBulkSelection = (itemId: string) => {
    setGitBulkSelectedItemIds((current) => {
      const next = new Set(current)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  const addGitBulkRange = (anchorId: string, itemId: string) => {
    const items = gitListItems()
    const anchorIndex = items.findIndex((entry) => entry.id === anchorId)
    const itemIndex = items.findIndex((entry) => entry.id === itemId)
    if (anchorIndex < 0 || itemIndex < 0) {
      setGitBulkSelectedItemIds((current) => {
        const next = new Set(current)
        next.add(itemId)
        return next
      })
      return
    }

    const start = Math.min(anchorIndex, itemIndex)
    const end = Math.max(anchorIndex, itemIndex)
    const rangeIds = items.slice(start, end + 1).map((entry) => entry.id)
    setGitBulkSelectedItemIds((current) => {
      const next = new Set(current)
      for (const rangeId of rangeIds) {
        next.add(rangeId)
      }
      return next
    })
  }

  const describeGitSelection = (itemId: string | null): GitSelectionDescriptor => {
    if (!itemId) {
      return { itemId: null, path: null, section: null }
    }
    const match = gitListItems().find((item) => item.id === itemId) ?? null
    return {
      itemId,
      path: match?.path ?? null,
      section: match?.section ?? null,
    }
  }

  const gitMostChangedItemId = createMemo<string | null>(() => {
    const items = gitListItems()
    if (items.length === 0) return null
    const candidates = items.filter((item) => item.status !== "deleted")
    if (candidates.length === 0) return null
    const best = candidates.reduce((currentBest, item) => {
      const bestScore = (currentBest?.additions ?? 0) + (currentBest?.deletions ?? 0)
      const score = (item.additions ?? 0) + (item.deletions ?? 0)
      if (score > bestScore) return item
      if (score < bestScore) return currentBest
      return String(item.id || "").localeCompare(String(currentBest?.id || "")) < 0 ? item : currentBest
    }, candidates[0])
    return typeof best?.id === "string" ? best.id : null
  })

  const resolveValidGitSelection = (selection: GitSelectionDescriptor): string | null => {
    const items = gitListItems()
    if (items.length === 0) return null
    if (selection.itemId && items.some((item) => item.id === selection.itemId)) return selection.itemId
    if (selection.path && selection.section) {
      const oppositeSection = selection.section === "staged" ? "unstaged" : "staged"
      const moved = items.find((item) => item.path === selection.path && item.section === oppositeSection)
      if (moved) return moved.id
      const samePath = items.find((item) => item.path === selection.path)
      if (samePath) return samePath.id
    }
    return gitMostChangedItemId()
  }

  const describeGitSelectionFingerprint = (itemId: string | null) => {
    if (!itemId) return null
    const item = gitListItems().find((entry) => entry.id === itemId) ?? null
    if (!item) return null
    return `${item.path}::${item.originalPath ?? ""}::${item.section}::${item.status}::${item.additions}::${item.deletions}`
  }

  const clearSelectedGitDiff = () => {
    setGitSelectedError(null)
    setGitSelectedBefore(null)
    setGitSelectedAfter(null)
  }

  const clearSelectedGitDiffAndSelection = () => {
    setGitSelectedItemId(null)
    clearGitBulkSelection()
    setGitSelectedLoading(false)
    clearSelectedGitDiff()
  }

  const pruneGitBulkSelection = () => {
    const validIds = new Set(gitListItems().map((item) => item.id))
    setGitBulkSelectedItemIds((current) => {
      if (current.size === 0) return current
      const next = new Set<string>()
      for (const itemId of current) {
        if (validIds.has(itemId)) next.add(itemId)
      }
      return next.size === current.size ? current : next
    })

    const anchorId = gitBulkSelectionAnchorId()
    if (anchorId && !validIds.has(anchorId)) {
      setGitBulkSelectionAnchorId(null)
    }
  }

  createEffect(() => {
    gitListItems()
    pruneGitBulkSelection()
  })

  const loadGitStatus = async (force = false) => {
    if (disposed || !gitActive()) return false
    if (!force && gitStatusEntries() !== null) return true
    const slug = options.worktreeSlug()
    const client = getRootClient(options.instanceId)
    const requestVersion = ++gitStatusRequestVersion
    statusController?.abort()
    const controller = statusController = new AbortController()
    const sdkController = new AbortController()
    const abortSdk = () => sdkController.abort()
    controller.signal.addEventListener("abort", abortSdk, { once: true })
    setGitStatusLoading(true)
    setGitStatusError(null)
    try {
      const location = gitLocation(slug)
      const sdkStatusPromise = backgroundReads.run(sdkController.signal, async () => {
        const timeout = setTimeout(abortSdk, 1500)
        try { return (await client.vcs.status({ location }, { signal: sdkController.signal })).data }
        finally { clearTimeout(timeout) }
      }, "visible").catch(() => null)
      const detailList = await backgroundReads.run(controller.signal, () =>
        serverApi.fetchWorktreeGitStatus(options.instanceId, slug, controller.signal),
        "visible",
      )
      if (requestVersion !== gitStatusRequestVersion || slug !== options.worktreeSlug()) return false
      const sdkList = await sdkStatusPromise
      if (requestVersion !== gitStatusRequestVersion || slug !== options.worktreeSlug()) return false
      setGitStatusEntries(adaptSdkGitStatusEntries(sdkList, detailList))
      return true
    } catch (error) {
      if (requestVersion !== gitStatusRequestVersion || slug !== options.worktreeSlug()) return false
      setGitStatusError(error instanceof Error ? error.message : "Failed to load git status")
      return false
    } finally {
      abortSdk()
      controller.signal.removeEventListener("abort", abortSdk)
      if (requestVersion === gitStatusRequestVersion && slug === options.worktreeSlug()) setGitStatusLoading(false)
    }
  }

  async function openGitFile(itemId: string) {
    if (disposed || !gitActive()) return
    const requestVersion = ++gitDiffRequestVersion
    diffController?.abort()
    const controller = diffController = new AbortController()
    setGitSelectedItemId(itemId)
    if (options.externalDiff) return
    setGitSelectedLoading(true)
    clearSelectedGitDiff()

    const item = gitListItems().find((entry) => entry.id === itemId) || null
    if (!item) {
      if (requestVersion !== gitDiffRequestVersion) return
      clearSelectedGitDiffAndSelection()
      return
    }

    if (options.isPhoneLayout()) {
      options.closeGitList()
    }

    try {
      const slug = options.worktreeSlug()
      const diff = await backgroundReads.run(controller.signal, () => serverApi.fetchWorktreeGitDiff(options.instanceId, slug, {
        path: item.path,
        originalPath: item.originalPath ?? null,
        scope: item.section,
      }, controller.signal), "visible")
      if (requestVersion !== gitDiffRequestVersion || gitSelectedItemId() !== itemId) return
      if (diff.isBinary) {
        setGitSelectedError(options.t("instanceShell.gitChanges.binaryViewer"))
        return
      }
      setGitSelectedBefore(diff.before)
      setGitSelectedAfter(diff.after)
    } catch (error) {
      if (requestVersion !== gitDiffRequestVersion || gitSelectedItemId() !== itemId) return
      setGitSelectedError(error instanceof Error ? error.message : "Failed to load file changes")
    } finally {
      if (requestVersion !== gitDiffRequestVersion || gitSelectedItemId() !== itemId) return
      setGitSelectedLoading(false)
    }
  }

  const passiveRefreshGitStatus = async (optionsArg?: { forceReloadSelectedDiff?: boolean }) => {
    if (!gitActive()) return
    if (passiveGitRefresh) {
      pendingGitPassiveRefreshOptions = {
        forceReloadSelectedDiff:
          pendingGitPassiveRefreshOptions?.forceReloadSelectedDiff || optionsArg?.forceReloadSelectedDiff || false,
      }
      return
    }
    if (gitCommitSubmitting()) return

    const refresh = passiveGitRefresh = {}
    const refreshSelectionId = gitSelectedItemId()
    const previousSelection = describeGitSelection(gitSelectedItemId())
    const previousFingerprint = describeGitSelectionFingerprint(previousSelection.itemId)
    const hadSelectedDiff =
      previousSelection.itemId !== null &&
      (gitSelectedBefore() !== null || gitSelectedAfter() !== null || gitSelectedError() !== null)

    try {
      if (!await loadGitStatus(true)) return
      if (passiveGitRefresh !== refresh || !gitActive()) return
      if (gitSelectedItemId() !== refreshSelectionId) return
      const nextSelection = resolveValidGitSelection(previousSelection)
      setGitSelectedItemId(nextSelection)

      if (!nextSelection) {
        clearSelectedGitDiff()
        return
      }

      const nextFingerprint = describeGitSelectionFingerprint(nextSelection)
      const shouldReloadSelectedDiff =
        optionsArg?.forceReloadSelectedDiff ||
        !hadSelectedDiff ||
        previousFingerprint !== nextFingerprint ||
        previousSelection.itemId === nextSelection

      if (shouldReloadSelectedDiff) {
        await openGitFile(nextSelection)
      }
    } finally {
      if (passiveGitRefresh !== refresh) return
      passiveGitRefresh = null
      if (pendingGitPassiveRefreshOptions) {
        const nextOptions = pendingGitPassiveRefreshOptions
        pendingGitPassiveRefreshOptions = null
        void passiveRefreshGitStatus(nextOptions)
      }
    }
  }

  const mutateGitFile = async (item: GitChangeListItem, action: "stage" | "unstage") => {
    const context = captureGitContext()
    if (!context.current()) return
    const currentSelection = describeGitSelection(gitSelectedItemId())
    const fallbackSelection = currentSelection.path === item.path ? currentSelection : describeGitSelection(item.id)
    const selectedIds = gitBulkSelectedItemIds()
    const selectedItems = gitListItems().filter((candidate) => selectedIds.has(candidate.id))
    const bulkTargets = selectedItems.filter((candidate) => candidate.section === item.section)
    const targetItems = bulkTargets.some((candidate) => candidate.id === item.id) ? bulkTargets : [item]
    const targetPaths = Array.from(new Set(targetItems.map((candidate) => candidate.path)))
    try {
      if (action === "stage") {
        await serverApi.stageWorktreeGitPaths(options.instanceId, context.slug, { paths: targetPaths })
      } else {
        await serverApi.unstageWorktreeGitPaths(options.instanceId, context.slug, { paths: targetPaths })
      }

      invalidateFilesystemCaches(options.instanceId)
      if (!context.current()) return
      if (!await loadGitStatus(true) || !context.current()) return
      clearGitBulkSelection()
      const nextSelection = resolveValidGitSelection(fallbackSelection)
      setGitSelectedItemId(nextSelection)
      if (nextSelection) {
        await openGitFile(nextSelection)
      } else {
        clearSelectedGitDiff()
      }
    } catch (error) {
      if (!context.current()) return
      showToastNotification({
        message: error instanceof Error ? error.message : `Failed to ${action} file`,
        variant: "error",
      })
    }
  }

  const handleGitRowClick = (item: GitChangeListItem, event: MouseEvent) => {
    if (event.shiftKey) {
      event.preventDefault()
      const anchorId = gitBulkSelectionAnchorId() ?? item.id
      addGitBulkRange(anchorId, item.id)
      return
    }

    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      toggleGitBulkSelection(item.id)
      setGitBulkSelectionAnchorId(item.id)
      return
    }

    clearGitBulkSelection()
    setGitBulkSelectionAnchorId(item.id)
    void openGitFile(item.id)
  }

  const submitGitCommit = async () => {
    const context = captureGitContext()
    if (!context.current()) return
    const message = gitCommitMessage().trim()
    if (!message || gitCommitSubmitting()) return

    setGitCommitSubmitting(true)
    const operation = commitOperation = {}
    const draft = gitCommitMessage()
    try {
      await serverApi.commitWorktreeGitChanges(options.instanceId, context.slug, { message })
      invalidateFilesystemCaches(options.instanceId)
      if (!context.current()) return
      if (gitCommitMessage() === draft) setGitCommitMessage("")
      if (!await loadGitStatus(true) || !context.current()) return
      const nextSelection = resolveValidGitSelection(describeGitSelection(gitSelectedItemId()))
      setGitSelectedItemId(nextSelection)
      if (nextSelection) {
        await openGitFile(nextSelection)
      } else {
        clearSelectedGitDiff()
      }
      if (!context.current()) return
      showToastNotification({
        message: options.t("instanceShell.gitChanges.commit.success"),
        variant: "success",
      })
    } catch (error) {
      if (!context.current()) return
      showToastNotification({
        message: error instanceof Error ? error.message : options.t("instanceShell.gitChanges.commit.error"),
        variant: "error",
      })
    } finally {
      if (!disposed && commitOperation === operation) { commitOperation = null; setGitCommitSubmitting(false) }
    }
  }

  const refreshGitStatus = async () => {
    const context = captureGitContext()
    if (!await loadGitStatus(true) || !context.current()) return
    const selected = resolveValidGitSelection(describeGitSelection(gitSelectedItemId()))
    setGitSelectedItemId(selected)
    if (selected) {
      void openGitFile(selected)
    } else {
      clearSelectedGitDiff()
    }
  }

  const insertGitChangeContext = (item: GitChangeListItem, selection: { startLine: number; endLine: number } | null) => {
    const startLine = selection?.startLine ?? 1
    const endLine = selection?.endLine ?? startLine
    options.promptInputApi()?.insertComment(`Git Diff: File: ${item.path} : ${startLine}-${endLine}`)
  }

  createEffect(on(options.worktreeSlug, () => {
    cancelGitReads()
    setGitStatusEntries(null)
    setGitStatusError(null)
    setGitStatusLoading(false)
    setGitSelectedItemId(null)
    clearGitBulkSelection()
    setGitSelectedLoading(false)
    clearSelectedGitDiff()
    setGitCommitMessage("")
    commitOperation = null
    setGitCommitSubmitting(false)
  }))

  createEffect(() => {
    if (!gitActive()) return
    const items = gitListItems()
    if (gitStatusEntries() === null) return
    if (items.length === 0) return
    if (gitSelectedItemId()) return
    const next = gitMostChangedItemId()
    if (!next) return
    void openGitFile(next)
  })

  createEffect(on(() => gitActive() ? `${options.instanceId}:${options.worktreeSlug()}` : null, (activationKey) => {
    if (!activationKey) {
      previousGitChangesActivationKey = null
      cancelGitReads()
      setGitStatusLoading(false)
      setGitSelectedLoading(false)
      return
    }
    if (previousGitChangesActivationKey === activationKey) return
    previousGitChangesActivationKey = activationKey
    void passiveRefreshGitStatus()
  }))

  const filesystemRefresh = createDebouncedRefresh(() => void passiveRefreshGitStatus({ forceReloadSelectedDiff: true }))
  createEffect(() => {
    const version = filesystemInvalidationVersion(options.instanceId)
    if (version === seenFilesystemInvalidation) return
    seenFilesystemInvalidation = version
    if (gitActive()) filesystemRefresh.trigger()
    else setGitStatusEntries(null)
  })
  onCleanup(() => filesystemRefresh.cancel())

  createEffect(() => {
    if (options.rightPanelTab() === "git-changes") return
    setGitSelectedBefore(null)
    setGitSelectedAfter(null)
    setGitSelectedLoading(false)
    setGitSelectedError(null)
  })

  return {
    gitStatusEntries,
    gitStatusLoading,
    gitStatusError,
    gitSelectedItemId,
    gitBulkSelectedItemIds,
    gitSelectedLoading,
    gitSelectedError,
    gitSelectedBefore,
    gitSelectedAfter,
    gitCommitMessage,
    gitCommitSubmitting,
    gitMostChangedItemId,
    setGitCommitMessage,
    handleGitRowClick,
    refreshGitStatus,
    insertGitChangeContext,
    submitGitCommit,
    stageGitFile: (item: GitChangeListItem) => void mutateGitFile(item, "stage"),
    unstageGitFile: (item: GitChangeListItem) => void mutateGitFile(item, "unstage"),
  }
}
