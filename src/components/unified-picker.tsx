import { Component, createSignal, createEffect, For, Show, onCleanup } from "solid-js"
import type { Agent } from "../types/session"

interface FileItem {
  path: string
  added?: number
  removed?: number
  isGitFile: boolean
}

type PickerItem = { type: "agent"; agent: Agent } | { type: "file"; file: FileItem }

interface UnifiedPickerProps {
  open: boolean
  onSelect: (item: PickerItem) => void
  onClose: () => void
  agents: Agent[]
  instanceClient: any
  searchQuery: string
  textareaRef?: HTMLTextAreaElement
  workspaceFolder: string
}

const UnifiedPicker: Component<UnifiedPickerProps> = (props) => {
  const [files, setFiles] = createSignal<FileItem[]>([])
  const [filteredAgents, setFilteredAgents] = createSignal<Agent[]>([])
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  const [allFiles, setAllFiles] = createSignal<FileItem[]>([])
  const [isInitialized, setIsInitialized] = createSignal(false)

  let containerRef: HTMLDivElement | undefined
  let scrollContainerRef: HTMLDivElement | undefined

  async function fetchFiles(searchQuery: string) {
    setLoading(true)

    try {
      if (allFiles().length === 0) {
        const scannedPaths = await window.electronAPI.scanDirectory(props.workspaceFolder)
        const scannedFiles: FileItem[] = scannedPaths.map((path) => ({
          path,
          isGitFile: false,
        }))
        setAllFiles(scannedFiles)
      }

      const filteredFiles = searchQuery.trim()
        ? allFiles().filter((f) => f.path.toLowerCase().includes(searchQuery.toLowerCase()))
        : allFiles()

      setFiles(filteredFiles)
      setSelectedIndex(0)

      setTimeout(() => {
        if (scrollContainerRef) {
          scrollContainerRef.scrollTop = 0
        }
      }, 0)
    } catch (error) {
      console.error(`[UnifiedPicker] Failed to fetch files:`, error)
      setFiles([])
    } finally {
      setLoading(false)
    }
  }

  let lastQuery = ""

  createEffect(() => {
    if (props.open && !isInitialized()) {
      setIsInitialized(true)
      fetchFiles(props.searchQuery)
      lastQuery = props.searchQuery
      return
    }

    if (props.open && props.searchQuery !== lastQuery) {
      lastQuery = props.searchQuery
      fetchFiles(props.searchQuery)
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
    } else if (e.key === "Enter") {
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

  return (
    <Show when={props.open}>
      <div
        ref={containerRef}
        class="dropdown-surface bottom-full left-0 mb-1 max-w-md"
      >
        <div class="dropdown-header">
          <div class="dropdown-header-title">
            Select Agent or File
            <Show when={loading()}>
              <span class="ml-2">Loading...</span>
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
                const itemIndex = allItems().findIndex((item) => item.type === "file" && item.file.path === file.path)
                const isFolder = file.path.endsWith("/")
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
            <span class="font-medium">↑↓</span> navigate • <span class="font-medium">Enter</span> select •{" "}
            <span class="font-medium">Esc</span> close
          </div>
        </div>
      </div>
    </Show>
  )
}

export default UnifiedPicker
