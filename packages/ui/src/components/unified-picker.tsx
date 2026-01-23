import { Component, createSignal, createEffect, For, Show, onCleanup } from "solid-js"
import type { Agent } from "../types/session"
import type { OpencodeClient } from "@opencode-ai/sdk/client"
import { serverApi } from "../lib/api-client"
import { getLogger } from "../lib/logger"
const log = getLogger("actions")


const SEARCH_RESULT_LIMIT = 100
const SEARCH_DEBOUNCE_MS = 200

type LoadingState = "idle" | "listing" | "search"

interface FileItem {
  path: string
  relativePath: string
  added?: number
  removed?: number
  isGitFile: boolean
  isDirectory: boolean
}

function formatDisplayPath(basePath: string, isDirectory: boolean) {
  if (!isDirectory) {
    return basePath
  }
  const trimmed = basePath.replace(/\/+$/, "")
  return trimmed.length > 0 ? `${trimmed}/` : "./"
}

function isRootPath(value: string) {
  return value === "." || value === "./" || value === "/"
}

function normalizeRelativePath(basePath: string, isDirectory: boolean) {
  if (isRootPath(basePath)) {
    return "."
  }
  const withoutPrefix = basePath.replace(/^\.\/+/, "")
  if (isDirectory) {
    const trimmed = withoutPrefix.replace(/\/+$/, "")
    return trimmed || "."
  }
  return withoutPrefix
}

function normalizeQuery(rawQuery: string) {
  const trimmed = rawQuery.trim()
  if (!trimmed) {
    return ""
  }
  if (trimmed === "." || trimmed === "./") {
    return ""
  }
  return trimmed.replace(/^(\.\/)+/, "").replace(/^\/+/, "")
}

function mapEntriesToFileItems(entries: { path: string; type: "file" | "directory" }[]): FileItem[] {
  return entries.map((entry) => {
    const isDirectory = entry.type === "directory"
    return {
      path: formatDisplayPath(entry.path, isDirectory),
      relativePath: normalizeRelativePath(entry.path, isDirectory),
      isDirectory,
      isGitFile: false,
    }
  })
}

type PickerItem = { type: "agent"; agent: Agent } | { type: "file"; file: FileItem }

interface UnifiedPickerProps {
  open: boolean
  onSelect: (item: PickerItem) => void
  onClose: () => void
  agents: Agent[]
  instanceClient: OpencodeClient | null
  searchQuery: string
  textareaRef?: HTMLTextAreaElement
  workspaceId: string
}

const UnifiedPicker: Component<UnifiedPickerProps> = (props) => {
  const [files, setFiles] = createSignal<FileItem[]>([])
  const [filteredAgents, setFilteredAgents] = createSignal<Agent[]>([])
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [loadingState, setLoadingState] = createSignal<LoadingState>("idle")
  const [allFiles, setAllFiles] = createSignal<FileItem[]>([])
  const [isInitialized, setIsInitialized] = createSignal(false)
  const [cachedWorkspaceId, setCachedWorkspaceId] = createSignal<string | null>(null)
 
  let containerRef: HTMLDivElement | undefined
  let scrollContainerRef: HTMLDivElement | undefined
  let lastWorkspaceId: string | null = null
  let lastQuery = ""
  let inflightWorkspaceId: string | null = null
  let inflightSnapshotPromise: Promise<FileItem[]> | null = null
  let activeRequestId = 0
  let queryDebounceTimer: ReturnType<typeof setTimeout> | null = null
 
  function resetScrollPosition() {
    setTimeout(() => {
      if (scrollContainerRef) {
        scrollContainerRef.scrollTop = 0
      }
    }, 0)
  }
 
  function applyFileResults(nextFiles: FileItem[]) {
    setFiles(nextFiles)
    setSelectedIndex(0)
    resetScrollPosition()
  }
 
  async function fetchWorkspaceSnapshot(workspaceId: string): Promise<FileItem[]> {
    if (inflightWorkspaceId === workspaceId && inflightSnapshotPromise) {
      return inflightSnapshotPromise
    }
 
    inflightWorkspaceId = workspaceId
    inflightSnapshotPromise = serverApi
      .listWorkspaceFiles(workspaceId)
      .then((entries) => mapEntriesToFileItems(entries))
      .then((snapshot) => {
        setAllFiles(snapshot)
        setCachedWorkspaceId(workspaceId)
        return snapshot
      })
      .catch((error) => {
        log.error(`[UnifiedPicker] Failed to load workspace files:`, error)
        setAllFiles([])
        setCachedWorkspaceId(null)
        throw error
      })
      .finally(() => {
        if (inflightWorkspaceId === workspaceId) {
          inflightWorkspaceId = null
          inflightSnapshotPromise = null
        }
      })
 
    return inflightSnapshotPromise
  }
 
  async function ensureWorkspaceSnapshot(workspaceId: string) {
    if (cachedWorkspaceId() === workspaceId && allFiles().length > 0) {
      return allFiles()
    }
 
    return fetchWorkspaceSnapshot(workspaceId)
  }
 
  async function loadFilesForQuery(rawQuery: string, workspaceId: string) {
    const normalizedQuery = normalizeQuery(rawQuery)
    const requestId = ++activeRequestId
    const hasCachedSnapshot =
      !normalizedQuery && cachedWorkspaceId() === workspaceId && allFiles().length > 0
    const mode: LoadingState = normalizedQuery ? "search" : hasCachedSnapshot ? "idle" : "listing"
    if (mode !== "idle") {
      setLoadingState(mode)
    } else {
      setLoadingState("idle")
    }

    try {
      if (!normalizedQuery) {
        const snapshot = await ensureWorkspaceSnapshot(workspaceId)
        if (!shouldApplyResults(requestId, workspaceId)) {
          return
        }
        applyFileResults(snapshot)
        return
      }

      const results = await serverApi.searchWorkspaceFiles(workspaceId, normalizedQuery, {
        limit: SEARCH_RESULT_LIMIT,
      })
      if (!shouldApplyResults(requestId, workspaceId)) {
        return
      }
      applyFileResults(mapEntriesToFileItems(results))
    } catch (error) {
      if (workspaceId === props.workspaceId) {
        log.error(`[UnifiedPicker] Failed to fetch files:`, error)
        if (shouldApplyResults(requestId, workspaceId)) {
          applyFileResults([])
        }
      }
    } finally {
      if (shouldFinalizeRequest(requestId, workspaceId)) {
        setLoadingState("idle")
      }
    }
  }

  function clearQueryDebounce() {
    if (queryDebounceTimer) {
      clearTimeout(queryDebounceTimer)
      queryDebounceTimer = null
    }
  }

  function scheduleLoadFilesForQuery(rawQuery: string, workspaceId: string, immediate = false) {
    clearQueryDebounce()
    const normalizedQuery = normalizeQuery(rawQuery)
    const shouldDebounce = !immediate && normalizedQuery.length > 0
    if (shouldDebounce) {
      queryDebounceTimer = setTimeout(() => {
        queryDebounceTimer = null
        void loadFilesForQuery(rawQuery, workspaceId)
      }, SEARCH_DEBOUNCE_MS)
      return
    }
    void loadFilesForQuery(rawQuery, workspaceId)
  }

  function shouldApplyResults(requestId: number, workspaceId: string) {
    return props.open && workspaceId === props.workspaceId && requestId === activeRequestId
  }

 
  function shouldFinalizeRequest(requestId: number, workspaceId: string) {
    return workspaceId === props.workspaceId && requestId === activeRequestId
  }
 
  function resetPickerState() {
    clearQueryDebounce()
    setFiles([])
    setAllFiles([])
    setCachedWorkspaceId(null)
    setIsInitialized(false)
    setSelectedIndex(0)
    setLoadingState("idle")
    lastWorkspaceId = null
    lastQuery = ""
    activeRequestId = 0
  }

  onCleanup(() => {
    clearQueryDebounce()
  })

  createEffect(() => {
    if (!props.open) {
      resetPickerState()
      return
    }

    const workspaceChanged = lastWorkspaceId !== props.workspaceId
    const queryChanged = lastQuery !== props.searchQuery

    if (!isInitialized() || workspaceChanged || queryChanged) {
      setIsInitialized(true)
      lastWorkspaceId = props.workspaceId
      lastQuery = props.searchQuery
      const shouldSkipDebounce = workspaceChanged || normalizeQuery(props.searchQuery).length === 0
      scheduleLoadFilesForQuery(props.searchQuery, props.workspaceId, shouldSkipDebounce)
    }
  })



  createEffect(() => {
    if (!props.open) return

    const query = props.searchQuery.toLowerCase()
    const filtered = query
      ? props.agents.filter(
          (agent) =>
            agent.name.toLowerCase().includes(query) ||
            (agent.description && agent.description.toLowerCase().includes(query)),
        )
      : props.agents

    setFilteredAgents(filtered)
  })

  const allItems = (): PickerItem[] => {
    const items: PickerItem[] = []
    filteredAgents().forEach((agent) => items.push({ type: "agent", agent }))
    files().forEach((file) => items.push({ type: "file", file }))
    return items
  }

  function scrollToSelected() {
    setTimeout(() => {
      const selectedElement = containerRef?.querySelector('[data-picker-selected="true"]')
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: "nearest", behavior: "smooth" })
      }
    }, 0)
  }

  function handleSelect(item: PickerItem) {
    props.onSelect(item)
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (!props.open) return

    const items = allItems()

    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelectedIndex((prev) => Math.min(prev + 1, items.length - 1))
      scrollToSelected()
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedIndex((prev) => Math.max(prev - 1, 0))
      scrollToSelected()
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault()
      const selected = items[selectedIndex()]
      if (selected) {
        handleSelect(selected)
      }
    } else if (e.key === "Escape") {
      e.preventDefault()
      props.onClose()
    }
  }

  createEffect(() => {
    if (props.open) {
      document.addEventListener("keydown", handleKeyDown)
      onCleanup(() => {
        document.removeEventListener("keydown", handleKeyDown)
      })
    }
  })

  const agentCount = () => filteredAgents().length
  const fileCount = () => files().length
  const isLoading = () => loadingState() !== "idle"
  const loadingMessage = () => {
    if (loadingState() === "search") {
      return "Searching..."
    }
    if (loadingState() === "listing") {
      return "Loading workspace..."
    }
    return ""
  }
 
  return (

    <Show when={props.open}>
      <div
        ref={containerRef}
        class="dropdown-surface bottom-full left-0 mb-1 max-w-md"
      >
        <div class="dropdown-header">
          <div class="dropdown-header-title">
            Select Agent or File
            <Show when={isLoading()}>
              <span class="ml-2">{loadingMessage()}</span>
            </Show>
          </div>
        </div>

        <div ref={scrollContainerRef} class="dropdown-content max-h-60">
          <Show when={agentCount() === 0 && fileCount() === 0}>
            <div class="dropdown-empty">No results found</div>
          </Show>

          <Show when={agentCount() > 0}>
            <div class="dropdown-section-header">
              AGENTS
            </div>
            <For each={filteredAgents()}>
              {(agent) => {
                const itemIndex = allItems().findIndex(
                  (item) => item.type === "agent" && item.agent.name === agent.name,
                )
                return (
                  <div
                    class={`dropdown-item ${
                      itemIndex === selectedIndex() ? "dropdown-item-highlight" : ""
                    }`}
                    data-picker-selected={itemIndex === selectedIndex()}
                    onClick={() => handleSelect({ type: "agent", agent })}
                  >
                    <div class="flex items-start gap-2">
                      <svg
                        class="dropdown-icon-accent h-4 w-4 mt-0.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                        />
                      </svg>
                      <div class="flex-1">
                        <div class="flex items-center gap-2">
                          <span class="text-sm font-medium">{agent.name}</span>
                          <Show when={agent.mode === "subagent"}>
                            <span class="dropdown-badge">
                              subagent
                            </span>
                          </Show>
                        </div>
                        <Show when={agent.description}>
                          <div class="mt-0.5 text-xs" style="color: var(--text-muted)">
                            {agent.description && agent.description.length > 80
                              ? agent.description.slice(0, 80) + "..."
                              : agent.description}
                          </div>
                        </Show>
                      </div>
                    </div>
                  </div>
                )
              }}
            </For>
          </Show>

          <Show when={fileCount() > 0}>
            <div class="dropdown-section-header">
              FILES
            </div>
            <For each={files()}>
              {(file) => {
                const itemIndex = allItems().findIndex(
                  (item) => item.type === "file" && item.file.relativePath === file.relativePath,
                )
                const isFolder = file.isDirectory
                return (
                  <div
                    class={`dropdown-item py-1.5 ${
                      itemIndex === selectedIndex() ? "dropdown-item-highlight" : ""
                    }`}
                    data-picker-selected={itemIndex === selectedIndex()}
                    onClick={() => handleSelect({ type: "file", file })}
                  >
                    <div class="flex items-center gap-2 text-sm">
                      <Show
                        when={isFolder}
                        fallback={
                          <svg class="dropdown-icon h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              stroke-width="2"
                              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                            />
                          </svg>
                        }
                      >
                        <svg class="dropdown-icon-accent h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                          />
                        </svg>
                      </Show>
                      <span class="truncate">{file.path}</span>
                    </div>
                  </div>
                )
              }}
            </For>
          </Show>
        </div>

        <div class="dropdown-footer">
          <div>
            <span class="font-medium">↑↓</span> navigate • <span class="font-medium">Tab/Enter</span> select •{" "}
            <span class="font-medium">Esc</span> close
          </div>
        </div>
      </div>
    </Show>
  )
}

export default UnifiedPicker
