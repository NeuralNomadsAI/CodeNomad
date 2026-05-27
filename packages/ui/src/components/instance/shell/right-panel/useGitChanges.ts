import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import type { File as GitFileStatus } from "@opencode-ai/sdk/v2/client"
import type { PromptInputApi } from "../../../prompt-input/types"
import type { GitChangeEntry, GitChangeListItem, GitSelectionDescriptor, RightPanelTab } from "./types"

import { getOrCreateWorktreeClient } from "../../../../stores/worktrees"
import { requestData } from "../../../../lib/opencode-api"
import { serverApi } from "../../../../lib/api-client"
import { serverEvents } from "../../../../lib/server-events"
import { showToastNotification } from "../../../../lib/notifications"
import { adaptSdkGitStatusEntries, buildGitChangeListItems } from "./git-changes-model"

type UseGitChangesOptions = {
  t: (key: string, vars?: Record<string, any>) => string
  instanceId: string
  rightPanelTab: Accessor<RightPanelTab>
  worktreeSlug: Accessor<string>
  isPhoneLayout: Accessor<boolean>
  promptInputApi: Accessor<PromptInputApi | null>
  closeGitList: () => void
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
  let passiveGitRefreshInFlight = false
  let pendingGitPassiveRefreshOptions: { forceReloadSelectedDiff?: boolean } | null = null
  let previousGitChangesActivationKey: string | null = null

  const gitListItems = createMemo(() => buildGitChangeListItems(gitStatusEntries()))

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
    if (!force && gitStatusEntries() !== null) return
    const slug = options.worktreeSlug()
    const client = getOrCreateWorktreeClient(options.instanceId, slug)
    const requestVersion = ++gitStatusRequestVersion
    setGitStatusLoading(true)
    setGitStatusError(null)
    try {
      const sdkStatusPromise = requestData<GitFileStatus[]>(client.file.status(), "file.status")
      const detailList = await serverApi.fetchWorktreeGitStatus(options.instanceId, slug)
      if (requestVersion !== gitStatusRequestVersion) return
      if (slug !== options.worktreeSlug()) return

      const sdkResult = await Promise.race([
        sdkStatusPromise.then((value) => ({ kind: "fulfilled" as const, value })),
        new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 1500)),
      ]).catch(() => null)

      const sdkList = sdkResult && sdkResult.kind === "fulfilled" ? sdkResult.value : null
      setGitStatusEntries(adaptSdkGitStatusEntries(sdkList, detailList))
    } catch (error) {
      if (requestVersion !== gitStatusRequestVersion) return
      if (slug !== options.worktreeSlug()) return
      setGitStatusError(error instanceof Error ? error.message : "Failed to load git status")
      setGitStatusEntries([])
    } finally {
      if (requestVersion !== gitStatusRequestVersion) return
      if (slug !== options.worktreeSlug()) return
      setGitStatusLoading(false)
    }
  }

  async function openGitFile(itemId: string) {
    const requestVersion = ++gitDiffRequestVersion
    setGitSelectedItemId(itemId)
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
      const diff = await serverApi.fetchWorktreeGitDiff(options.instanceId, options.worktreeSlug(), {
        path: item.path,
        originalPath: item.originalPath ?? null,
        scope: item.section,
      })
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
    if (options.rightPanelTab() !== "git-changes") return
    if (passiveGitRefreshInFlight) {
      pendingGitPassiveRefreshOptions = {
        forceReloadSelectedDiff:
          pendingGitPassiveRefreshOptions?.forceReloadSelectedDiff || optionsArg?.forceReloadSelectedDiff || false,
      }
      return
    }
    if (gitCommitSubmitting()) return

    passiveGitRefreshInFlight = true
    const refreshSelectionId = gitSelectedItemId()
    const previousSelection = describeGitSelection(gitSelectedItemId())
    const previousFingerprint = describeGitSelectionFingerprint(previousSelection.itemId)
    const hadSelectedDiff =
      previousSelection.itemId !== null &&
      (gitSelectedBefore() !== null || gitSelectedAfter() !== null || gitSelectedError() !== null)

    try {
      await loadGitStatus(true)
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
      passiveGitRefreshInFlight = false
      if (pendingGitPassiveRefreshOptions) {
        const nextOptions = pendingGitPassiveRefreshOptions
        pendingGitPassiveRefreshOptions = null
        void passiveRefreshGitStatus(nextOptions)
      }
    }
  }

  const mutateGitFile = async (item: GitChangeListItem, action: "stage" | "unstage") => {
    const currentSelection = describeGitSelection(gitSelectedItemId())
    const fallbackSelection = currentSelection.path === item.path ? currentSelection : describeGitSelection(item.id)
    const selectedIds = gitBulkSelectedItemIds()
    const selectedItems = gitListItems().filter((candidate) => selectedIds.has(candidate.id))
    const bulkTargets = selectedItems.filter((candidate) => candidate.section === item.section)
    const targetItems = bulkTargets.some((candidate) => candidate.id === item.id) ? bulkTargets : [item]
    const targetPaths = Array.from(new Set(targetItems.map((candidate) => candidate.path)))
    try {
      if (action === "stage") {
        await serverApi.stageWorktreeGitPaths(options.instanceId, options.worktreeSlug(), { paths: targetPaths })
      } else {
        await serverApi.unstageWorktreeGitPaths(options.instanceId, options.worktreeSlug(), { paths: targetPaths })
      }

      await loadGitStatus(true)
      clearGitBulkSelection()
      const nextSelection = resolveValidGitSelection(fallbackSelection)
      setGitSelectedItemId(nextSelection)
      if (nextSelection) {
        await openGitFile(nextSelection)
      } else {
        clearSelectedGitDiff()
      }
    } catch (error) {
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
    const message = gitCommitMessage().trim()
    if (!message || gitCommitSubmitting()) return

    setGitCommitSubmitting(true)
    try {
      await serverApi.commitWorktreeGitChanges(options.instanceId, options.worktreeSlug(), { message })
      setGitCommitMessage("")
      await loadGitStatus(true)
      const nextSelection = resolveValidGitSelection(describeGitSelection(gitSelectedItemId()))
      setGitSelectedItemId(nextSelection)
      if (nextSelection) {
        await openGitFile(nextSelection)
      } else {
        clearSelectedGitDiff()
      }
      showToastNotification({
        message: options.t("instanceShell.gitChanges.commit.success"),
        variant: "success",
      })
    } catch (error) {
      showToastNotification({
        message: error instanceof Error ? error.message : options.t("instanceShell.gitChanges.commit.error"),
        variant: "error",
      })
    } finally {
      setGitCommitSubmitting(false)
    }
  }

  const refreshGitStatus = async () => {
    await loadGitStatus(true)
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

  createEffect(() => {
    options.worktreeSlug()
    gitStatusRequestVersion += 1
    gitDiffRequestVersion += 1
    passiveGitRefreshInFlight = false
    pendingGitPassiveRefreshOptions = null
    setGitStatusEntries(null)
    setGitStatusError(null)
    setGitStatusLoading(false)
    setGitSelectedItemId(null)
    clearGitBulkSelection()
    setGitSelectedLoading(false)
    clearSelectedGitDiff()
    setGitCommitMessage("")
    setGitCommitSubmitting(false)
  })

  createEffect(() => {
    if (options.rightPanelTab() !== "git-changes") return
    const items = gitListItems()
    if (gitStatusEntries() === null) return
    if (items.length === 0) return
    if (gitSelectedItemId()) return
    const next = gitMostChangedItemId()
    if (!next) return
    void openGitFile(next)
  })

  createEffect(() => {
    const activationKey = options.rightPanelTab() === "git-changes" ? `${options.instanceId}:${options.worktreeSlug()}` : null
    if (!activationKey) {
      previousGitChangesActivationKey = null
      return
    }
    if (previousGitChangesActivationKey === activationKey) return
    previousGitChangesActivationKey = activationKey
    void passiveRefreshGitStatus()
  })

  createEffect(() => {
    if (options.rightPanelTab() !== "git-changes") return

    const unsubscribe = serverEvents.on("instance.event", (event) => {
      if (event.type !== "instance.event") return
      if (event.instanceId !== options.instanceId) return
      const eventType = (event.event as { type?: unknown } | undefined)?.type
      if (eventType !== "session.updated" && eventType !== "session.diff") return
      void passiveRefreshGitStatus({ forceReloadSelectedDiff: true })
    })

    onCleanup(() => {
      unsubscribe()
    })
  })

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
