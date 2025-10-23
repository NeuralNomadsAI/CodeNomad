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
}

const FilePicker: Component<FilePickerProps> = (props) => {
  const [files, setFiles] = createSignal<FileItem[]>([])
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  const [cachedGitFiles, setCachedGitFiles] = createSignal<FileItem[]>([])

  let containerRef: HTMLDivElement | undefined

  async function fetchGitFiles() {
    if (!props.instanceClient || cachedGitFiles().length > 0) return

    try {
      const gitResponse = await props.instanceClient.file.status()
      if (gitResponse?.data) {
        const gitFiles: FileItem[] = gitResponse.data.map((file: any) => ({
          path: file.path,
          added: file.added,
          removed: file.removed,
          isGitFile: true,
        }))
        setCachedGitFiles(gitFiles)
      }
    } catch (error) {
      console.warn("Git files not available:", error)
      setCachedGitFiles([])
    }
  }

  async function fetchFiles(searchQuery: string) {
    if (!props.instanceClient) return

    setLoading(true)
    try {
      const gitFiles = cachedGitFiles()

      if (!searchQuery) {
        setFiles(gitFiles)
        setSelectedIndex(0)
        setLoading(false)
        return
      }

      const searchResponse = await props.instanceClient.find.files({ query: { query: searchQuery } })

      const searchFiles: FileItem[] = (searchResponse?.data || [])
        .filter((path: string) => !gitFiles.some((gf) => gf.path === path))
        .map((path: string) => ({
          path,
          isGitFile: false,
        }))

      const filteredGitFiles = gitFiles.filter((f) => f.path.toLowerCase().includes(searchQuery.toLowerCase()))
      const allFiles = [...filteredGitFiles, ...searchFiles]

      setFiles(allFiles)
      setSelectedIndex(0)
    } catch (error) {
      console.error("Failed to search files:", error)
      setFiles([])
    } finally {
      setLoading(false)
    }
  }

  let lastQuery = ""

  createEffect(() => {
    if (props.open) {
      if (cachedGitFiles().length === 0) {
        fetchGitFiles()
      }
      if (props.searchQuery !== lastQuery) {
        lastQuery = props.searchQuery
        fetchFiles(props.searchQuery)
      }
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
      if (fileList.length === 0) return

      if (e.key === "ArrowDown") {
        e.preventDefault()
        handleNavigateDown()
        props.onNavigate("down")
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        handleNavigateUp()
        props.onNavigate("up")
      } else if (e.key === "Enter") {
        e.preventDefault()
        if (fileList[selectedIndex()]) {
          handleSelect(fileList[selectedIndex()].path)
        }
      } else if (e.key === "Escape") {
        e.preventDefault()
        props.onClose()
      }
    }

    document.addEventListener("keydown", listener)
    onCleanup(() => document.removeEventListener("keydown", listener))
  })

  return (
    <Show when={props.open}>
      <div
        ref={containerRef}
        class="absolute bottom-full left-0 mb-2 w-full max-w-2xl rounded-lg border border-gray-300 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
        style={{ "z-index": 100 }}
      >
        <div class="max-h-96 overflow-y-auto">
          <Show
            when={!loading()}
            fallback={
              <div class="p-4 text-center text-sm text-gray-500">
                <div class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600"></div>
                <span class="ml-2">Loading files...</span>
              </div>
            }
          >
            <Show
              when={files().length > 0}
              fallback={<div class="p-4 text-center text-sm text-gray-500">No matching files</div>}
            >
              <For each={files()}>
                {(file, index) => (
                  <div
                    data-file-selected={index() === selectedIndex()}
                    class={`cursor-pointer border-b border-gray-100 px-4 py-2 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800 ${
                      index() === selectedIndex() ? "bg-blue-50 dark:bg-blue-900/20" : ""
                    }`}
                    onClick={() => handleSelect(file.path)}
                    onMouseEnter={() => setSelectedIndex(index())}
                  >
                    <div class="flex items-center justify-between">
                      <span class="font-mono text-sm text-gray-900 dark:text-gray-100">{file.path}</span>
                      <Show when={file.isGitFile && (file.added || file.removed)}>
                        <div class="flex gap-2 text-xs">
                          <Show when={file.added}>
                            <span class="text-green-600 dark:text-green-400">+{file.added}</span>
                          </Show>
                          <Show when={file.removed}>
                            <span class="text-red-600 dark:text-red-400">-{file.removed}</span>
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

        <div class="border-t border-gray-200 p-2 text-xs text-gray-500 dark:border-gray-700">
          <div class="flex items-center justify-between px-2">
            <span>↑↓ Navigate • Enter Select • Esc Close</span>
          </div>
        </div>
      </div>
    </Show>
  )
}

export default FilePicker
