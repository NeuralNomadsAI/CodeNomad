import { createSignal, createEffect, createMemo, type Accessor } from "solid-js"
import type { FileContent, File as GitFileStatus } from "@opencode-ai/sdk/v2/client"
import { requestData } from "../../../../../lib/opencode-api"
import { buildUnifiedDiffFromSdkPatch, tryReverseApplyUnifiedDiff } from "../../../../../lib/unified-diff-reverse"
import type { RightPanelTab } from "../types"
import type { DiffItem } from "../tabs/ChangesTab"

type BrowserFileContent = FileContent & {
  encoding?: string
  content?: string
  diff?: string
  patch?: any
}

export function useRightPanelGit({
  browserClient,
  rightPanelTab,
  isPhoneLayout,
  activeSessionDiffs,
  setGitChangesListOpen,
  setChangesListOpen,
  selectedFile,
  setSelectedFile,
}: {
  browserClient: Accessor<any>
  rightPanelTab: Accessor<RightPanelTab>
  isPhoneLayout: Accessor<boolean>
  activeSessionDiffs: Accessor<any[] | undefined>
  setGitChangesListOpen: (open: boolean) => void
  setChangesListOpen: (open: boolean) => void
  selectedFile: Accessor<string | null>
  setSelectedFile: (file: string | null) => void
}) {
  const [gitStatusEntries, setGitStatusEntries] = createSignal<GitFileStatus[] | null>(null)
  const [gitStatusLoading, setGitStatusLoading] = createSignal(false)
  const [gitStatusError, setGitStatusError] = createSignal<string | null>(null)
  const [gitSelectedPath, setGitSelectedPath] = createSignal<string | null>(null)
  const [gitSelectedLoading, setGitSelectedLoading] = createSignal(false)
  const [gitSelectedError, setGitSelectedError] = createSignal<string | null>(null)
  const [gitSelectedBefore, setGitSelectedBefore] = createSignal<string | null>(null)
  const [gitSelectedAfter, setGitSelectedAfter] = createSignal<string | null>(null)

  const gitMostChangedPath = createMemo<string | null>(() => {
    const entries = gitStatusEntries()
    if (!Array.isArray(entries) || entries.length === 0) return null
    const candidates = entries.filter((item) => item && item.status !== "deleted")
    if (candidates.length === 0) return null
    const best = candidates.reduce((currentBest, item) => {
      const bestScore = (currentBest?.added ?? 0) + (currentBest?.removed ?? 0)
      const score = (item?.added ?? 0) + (item?.removed ?? 0)
      if (score > bestScore) return item
      if (score < bestScore) return currentBest
      return String(item.path || "").localeCompare(String(currentBest?.path || "")) < 0 ? item : currentBest
    }, candidates[0])
    return typeof best?.path === "string" ? best.path : null
  })

  const loadGitStatus = async (force = false) => {
    if (!force && gitStatusEntries() !== null) return
    setGitStatusLoading(true)
    setGitStatusError(null)
    try {
      const list = await requestData<GitFileStatus[]>(browserClient().file.status(), "file.status")
      if (Array.isArray(list)) {
        const normalized = list.map(item => ({
          ...item,
          path: typeof item.path === "string" ? item.path.replace(/\\/g, "/") : item.path
        }))
        setGitStatusEntries(normalized)
      } else {
        setGitStatusEntries([])
      }
    } catch (error) {
      setGitStatusError(error instanceof Error ? error.message : "Failed to load git status")
      setGitStatusEntries([])
    } finally {
      setGitStatusLoading(false)
    }
  }

  async function openGitFile(path: string) {
    setGitSelectedPath(path)
    setGitSelectedLoading(true)
    setGitSelectedError(null)
    setGitSelectedBefore(null)
    setGitSelectedAfter(null)

    const list = gitStatusEntries() || []
    const entry = list.find((item) => item.path === path) || null
    if (entry?.status === "deleted") {
      setGitSelectedError("Deleted file diff is not available yet")
      setGitSelectedLoading(false)
      return
    }

    if (isPhoneLayout()) {
      setGitChangesListOpen(false)
    }

    try {
      const content = await requestData<BrowserFileContent>(browserClient().file.read({ path }), "file.read")
      if (content?.type && content.type !== "text") {
        throw new Error("Binary file cannot be displayed")
      }
      if (content?.encoding === "base64") {
        throw new Error("Binary file cannot be displayed")
      }
      const afterText = typeof content?.content === "string" ? content.content : null
      if (afterText === null) {
        throw new Error("Unsupported file type")
      }

      setGitSelectedAfter(afterText)

      if (entry?.status === "added") {
        setGitSelectedBefore("")
        return
      }

      const diffText =
        typeof content?.diff === "string" && String(content.diff).trim().length > 0
          ? String(content.diff)
          : content?.patch
            ? buildUnifiedDiffFromSdkPatch(content.patch)
            : ""

      const beforeText = tryReverseApplyUnifiedDiff(afterText, diffText)
      if (beforeText === null) {
        throw new Error("Unable to calculate diff for this file")
      }
      setGitSelectedBefore(beforeText)
    } catch (error) {
      setGitSelectedError(error instanceof Error ? error.message : "Failed to load file changes")
    } finally {
      setGitSelectedLoading(false)
    }
  }

  createEffect(() => {
    if (rightPanelTab() !== "git-changes") return
    const entries = gitStatusEntries()
    if (entries === null) return
    if (gitSelectedPath()) return
    const next = gitMostChangedPath()
    if (!next) return
    void openGitFile(next)
  })

  const refreshGitStatus = async () => {
    await loadGitStatus(true)
    const selected = gitSelectedPath()
    if (selected) {
      void openGitFile(selected)
    }
  }

  const bestDiffFile = createMemo<string | null>(() => {
    const diffs = activeSessionDiffs() as DiffItem[] | undefined
    if (!Array.isArray(diffs) || diffs.length === 0) return null
    const best = diffs.reduce((currentBest, item) => {
      const bestAdd = typeof currentBest?.additions === "number" ? currentBest.additions : 0
      const bestDel = typeof currentBest?.deletions === "number" ? currentBest.deletions : 0
      const bestScore = bestAdd + bestDel

      const add = typeof item?.additions === "number" ? item.additions : 0
      const del = typeof item?.deletions === "number" ? item.deletions : 0
      const score = add + del

      if (score > bestScore) return item
      if (score < bestScore) return currentBest
      return String(item.file || "").localeCompare(String(currentBest?.file || "")) < 0 ? item : currentBest
    }, diffs[0])
    return typeof best?.file === "string" ? best.file : null
  })

  createEffect(() => {
    const next = bestDiffFile()
    if (!next) return
    const diffs = activeSessionDiffs()
    if (!Array.isArray(diffs) || diffs.length === 0) return

    const current = selectedFile()
    if (current && diffs.some((d) => d.file === current)) return
    setSelectedFile(next)
  })

  createEffect(() => {
    if (rightPanelTab() !== "git-changes") return
    if (gitStatusLoading()) return
    if (gitStatusEntries() !== null) return
    void loadGitStatus()
  })

  createEffect(() => {
    if (rightPanelTab() === "git-changes") return
    setGitSelectedBefore(null)
    setGitSelectedAfter(null)
    setGitSelectedLoading(false)
    setGitSelectedError(null)
  })

  const handleSelectChangesFile = (file: string, closeList: boolean) => {
    setSelectedFile(file)
    if (closeList) {
      setChangesListOpen(false)
    }
  }

  return {
    gitStatusEntries,
    setGitStatusEntries,
    gitStatusLoading,
    setGitStatusLoading,
    gitStatusError,
    setGitStatusError,
    gitSelectedPath,
    setGitSelectedPath,
    gitSelectedLoading,
    setGitSelectedLoading,
    gitSelectedError,
    setGitSelectedError,
    gitSelectedBefore,
    setGitSelectedBefore,
    gitSelectedAfter,
    setGitSelectedAfter,
    gitMostChangedPath,
    openGitFile,
    refreshGitStatus,
    handleSelectChangesFile,
  }
}
