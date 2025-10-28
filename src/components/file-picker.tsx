import { Component, createSignal, createEffect, For, Show, onCleanup } from "solid-js"

interface FileItem {
  path: string
  added?: number
  removed?: number
  isGitFile: boolean
}

interface FilePickerProps {
  open: boolean
  onSelect: (path: string) => void
  onNavigate: (direction: "up" | "down") => void
  onClose: () => void
  instanceClient: any
  searchQuery: string
  textareaRef?: HTMLTextAreaElement
  workspaceFolder: string
}

const FilePicker: Component<FilePickerProps> = (props) => {
  const [files, setFiles] = createSignal<FileItem[]>([])
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  const [allFiles, setAllFiles] = createSignal<FileItem[]>([])
  const [isInitialized, setIsInitialized] = createSignal(false)

  let containerRef: HTMLDivElement | undefined
  let scrollContainerRef: HTMLDivElement | undefined

  async function fetchFiles(searchQuery: string) {
    console.log(`[FilePicker] Fetching files for query: "${searchQuery}"`)
    setLoading(true)

    try {
      if (allFiles().length === 0) {
        console.log(`[FilePicker] Scanning workspace: ${props.workspaceFolder}`)
        const scannedPaths = await window.electronAPI.scanDirectory(props.workspaceFolder)
        const scannedFiles: FileItem[] = scannedPaths.map((path) => ({
          path,
          isGitFile: false,
        }))
        setAllFiles(scannedFiles)
        console.log(`[FilePicker] Found ${scannedFiles.length} files`)
      }

      const filteredFiles = searchQuery.trim()
        ? allFiles().filter((f) => f.path.toLowerCase().includes(searchQuery.toLowerCase()))
        : allFiles()

      console.log(`[FilePicker] Showing ${filteredFiles.length} files`)
      setFiles(filteredFiles)
      setSelectedIndex(0)

      setTimeout(() => {
        if (scrollContainerRef) {
          scrollContainerRef.scrollTop = 0
        }
      }, 0)
    } catch (error) {
      console.error(`[FilePicker] Failed to fetch files:`, error)
      setFiles([])
    } finally {
      setLoading(false)
    }
  }

  let lastQuery = ""

  createEffect(() => {
    console.log(
      `[FilePicker] Effect triggered - open: ${props.open}, query: "${props.searchQuery}", isInitialized: ${isInitialized()}`,
    )

    if (props.open && !isInitialized()) {
      setIsInitialized(true)
      console.log("[FilePicker] First open - fetching files")
      fetchFiles(props.searchQuery)
      lastQuery = props.searchQuery
      return
    }

    if (props.open && props.searchQuery !== lastQuery) {
      console.log(`[FilePicker] Query changed from "${lastQuery}" to "${props.searchQuery}"`)
      lastQuery = props.searchQuery
      fetchFiles(props.searchQuery)
    }
  })

  function scrollToSelected() {
    setTimeout(() => {
      const selectedElement = containerRef?.querySelector('[data-file-selected="true"]')
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: "nearest", behavior: "smooth" })
      }
    }, 0)
  }

  function handleSelect(path: string) {
    props.onSelect(path)
  }

  function handleNavigateUp() {
    setSelectedIndex((prev) => {
      const next = Math.max(prev - 1, 0)
      scrollToSelected()
      return next
    })
  }

  function handleNavigateDown() {
    setSelectedIndex((prev) => {
      const next = Math.min(prev + 1, files().length - 1)
      scrollToSelected()
      return next
    })
  }

  createEffect(() => {
    if (!props.open) return
    const listener = (e: KeyboardEvent) => {
      if (!props.open) return
      const fileList = files()

      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        props.onClose()
        return
      }

      if (fileList.length === 0) return

      if (e.key === "ArrowDown") {
        e.preventDefault()
        e.stopPropagation()
        handleNavigateDown()
        props.onNavigate("down")
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        e.stopPropagation()
        handleNavigateUp()
        props.onNavigate("up")
      } else if (e.key === "Enter") {
        e.preventDefault()
        e.stopPropagation()
        if (fileList[selectedIndex()]) {
          handleSelect(fileList[selectedIndex()].path)
        }
      }
    }

    document.addEventListener("keydown", listener, true)
    onCleanup(() => document.removeEventListener("keydown", listener, true))
  })

  return (
    <Show when={props.open}>
      <div
        ref={containerRef}
        class="dropdown-surface bottom-full left-0 mb-2 max-w-2xl rounded-lg"
        style={{ "z-index": 100 }}
      >
        <div ref={scrollContainerRef} class="dropdown-content max-h-96">
          <Show
            when={!loading() && isInitialized()}
            fallback={
              <div class="dropdown-loading">
                <div class="spinner inline-block h-4 w-4 mr-2"></div>
                <span>Loading files...</span>
              </div>
            }
          >
            <Show
              when={files().length > 0}
              fallback={<div class="dropdown-empty">No matching files</div>}
            >
              <For each={files()}>
                {(file, index) => (
                  <div
                    data-file-selected={index() === selectedIndex()}
                    class={`dropdown-item border-b px-4 py-2 font-mono text-sm ${
                      index() === selectedIndex() ? "dropdown-item-highlight" : ""
                    }`}
                    style="border-color: var(--border-muted)"
                    onClick={() => handleSelect(file.path)}
                    onMouseEnter={() => setSelectedIndex(index())}
                  >
                    <div class="flex items-center justify-between">
                      <span>{file.path}</span>
                      <Show when={file.isGitFile && (file.added || file.removed)}>
                        <div class="flex gap-2">
                          <Show when={file.added}>
                            <span class="dropdown-diff-added">+{file.added}</span>
                          </Show>
                          <Show when={file.removed}>
                            <span class="dropdown-diff-removed">-{file.removed}</span>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>

        <div class="dropdown-footer p-2">
          <div class="flex items-center justify-between px-2">
            <span>↑↓ Navigate • Enter Select • Esc Close</span>
          </div>
        </div>
      </div>
    </Show>
  )
}

export default FilePicker
