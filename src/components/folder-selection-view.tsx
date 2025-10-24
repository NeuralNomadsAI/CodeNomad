import { Component, createSignal, Show, For, onMount, onCleanup } from "solid-js"
import { Folder, Clock, Trash2, FolderPlus } from "lucide-solid"
import { recentFolders, removeRecentFolder } from "../stores/preferences"

interface FolderSelectionViewProps {
  onSelectFolder: (folder?: string) => void
  isLoading?: boolean
}

const FolderSelectionView: Component<FolderSelectionViewProps> = (props) => {
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [focusMode, setFocusMode] = createSignal<"recent" | "new" | null>("recent")

  const folders = () => recentFolders()

  function scrollToIndex(index: number) {
    const element = document.querySelector(`[data-folder-index="${index}"]`)
    if (element) {
      element.scrollIntoView({ block: "nearest", behavior: "auto" })
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    const folderList = folders()

    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleBrowse()
      return
    }

    if (folderList.length === 0) return

    if (e.key === "ArrowDown") {
      e.preventDefault()
      const newIndex = Math.min(selectedIndex() + 1, folderList.length - 1)
      setSelectedIndex(newIndex)
      setFocusMode("recent")
      scrollToIndex(newIndex)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      const newIndex = Math.max(selectedIndex() - 1, 0)
      setSelectedIndex(newIndex)
      setFocusMode("recent")
      scrollToIndex(newIndex)
    } else if (e.key === "PageDown") {
      e.preventDefault()
      const pageSize = 5
      const newIndex = Math.min(selectedIndex() + pageSize, folderList.length - 1)
      setSelectedIndex(newIndex)
      setFocusMode("recent")
      scrollToIndex(newIndex)
    } else if (e.key === "PageUp") {
      e.preventDefault()
      const pageSize = 5
      const newIndex = Math.max(selectedIndex() - pageSize, 0)
      setSelectedIndex(newIndex)
      setFocusMode("recent")
      scrollToIndex(newIndex)
    } else if (e.key === "Home") {
      e.preventDefault()
      setSelectedIndex(0)
      setFocusMode("recent")
      scrollToIndex(0)
    } else if (e.key === "End") {
      e.preventDefault()
      const newIndex = folderList.length - 1
      setSelectedIndex(newIndex)
      setFocusMode("recent")
      scrollToIndex(newIndex)
    } else if (e.key === "Enter") {
      e.preventDefault()
      handleEnterKey()
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault()
      if (folderList.length > 0 && focusMode() === "recent") {
        const folder = folderList[selectedIndex()]
        if (folder) {
          handleRemove(folder.path)
        }
      }
    }
  }

  function handleEnterKey() {
    const folderList = folders()
    const index = selectedIndex()

    if (index < folderList.length) {
      props.onSelectFolder(folderList[index].path)
    }
  }

  onMount(() => {
    window.addEventListener("keydown", handleKeyDown)
    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown)
    })
  })

  function formatRelativeTime(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) return `${days}d ago`
    if (hours > 0) return `${hours}h ago`
    if (minutes > 0) return `${minutes}m ago`
    return "just now"
  }

  function handleFolderSelect(path: string) {
    props.onSelectFolder(path)
  }

  function handleBrowse() {
    props.onSelectFolder()
  }

  function handleRemove(path: string, e?: Event) {
    e?.stopPropagation()
    removeRecentFolder(path)

    const folderList = folders()
    if (selectedIndex() >= folderList.length && folderList.length > 0) {
      setSelectedIndex(folderList.length - 1)
    }
  }

  function getDisplayPath(path: string): string {
    if (path.startsWith("/Users/")) {
      return path.replace(/^\/Users\/[^/]+/, "~")
    }
    return path
  }

  return (
    <div class="flex h-full w-full items-center justify-center bg-gray-50 dark:bg-gray-900">
      <div class="w-full max-w-3xl px-8 py-12">
        <div class="mb-8 text-center">
          <div class="mb-4 flex justify-center">
            <Folder class="h-16 w-16 text-gray-400 dark:text-gray-600" />
          </div>
          <h1 class="mb-2 text-2xl font-semibold text-gray-900 dark:text-gray-100">Welcome to OpenCode</h1>
          <p class="text-base text-gray-600 dark:text-gray-400">Select a folder to start coding with AI</p>
        </div>

        <div class="space-y-4">
          <Show
            when={folders().length > 0}
            fallback={
              <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6 text-center">
                <div class="text-gray-400 dark:text-gray-600 mb-2">
                  <Clock class="w-12 h-12 mx-auto" />
                </div>
                <p class="text-gray-600 dark:text-gray-400 font-medium text-sm mb-1">No Recent Folders</p>
                <p class="text-xs text-gray-500 dark:text-gray-500">Browse for a folder to get started</p>
              </div>
            }
          >
            <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
              <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
                <h2 class="text-base font-semibold text-gray-900 dark:text-gray-100">Recent Folders</h2>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {folders().length} {folders().length === 1 ? "folder" : "folders"} available
                </p>
              </div>
              <div class="max-h-[400px] overflow-y-auto">
                <For each={folders()}>
                  {(folder, index) => (
                    <div
                      data-folder-index={index()}
                      class="group relative border-b border-gray-100 dark:border-gray-700 last:border-b-0"
                    >
                      <button
                        class="w-full text-left px-4 py-3 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all focus:outline-none flex items-center justify-between gap-3"
                        classList={{
                          "bg-blue-100 dark:bg-blue-900/30 ring-2 ring-blue-500 ring-inset":
                            focusMode() === "recent" && selectedIndex() === index(),
                        }}
                        onClick={() => handleFolderSelect(folder.path)}
                        onMouseEnter={() => {
                          setFocusMode("recent")
                          setSelectedIndex(index())
                        }}
                      >
                        <div class="flex-1 min-w-0">
                          <div class="flex items-center gap-2 mb-1">
                            <Folder class="w-4 h-4 text-gray-400 dark:text-gray-500 flex-shrink-0" />
                            <span class="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                              {folder.path.split("/").pop()}
                            </span>
                          </div>
                          <div class="text-xs text-gray-500 dark:text-gray-400 font-mono truncate pl-6">
                            {getDisplayPath(folder.path)}
                          </div>
                          <div class="text-xs text-gray-400 dark:text-gray-500 mt-1 pl-6">
                            {formatRelativeTime(folder.lastAccessed)}
                          </div>
                        </div>
                        <div class="flex items-center gap-2 flex-shrink-0">
                          <Show when={focusMode() === "recent" && selectedIndex() === index()}>
                            <kbd class="px-1.5 py-0.5 text-xs font-semibold text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded">
                              ↵
                            </kbd>
                          </Show>
                          <button
                            onClick={(e) => handleRemove(folder.path, e)}
                            class="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-100 dark:hover:bg-red-900/30 rounded transition-all"
                            title="Remove from recent"
                          >
                            <Trash2 class="w-3.5 h-3.5 text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400" />
                          </button>
                        </div>
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
              <h2 class="text-base font-semibold text-gray-900 dark:text-gray-100">Browse for Folder</h2>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Select any folder on your computer</p>
            </div>
            <div class="p-4">
              <button
                onClick={handleBrowse}
                disabled={props.isLoading}
                class="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-600 disabled:cursor-not-allowed transition-all font-medium flex items-center justify-between text-sm"
                onMouseEnter={() => setFocusMode("new")}
              >
                <div class="flex items-center gap-2 flex-1 justify-center">
                  <FolderPlus class="w-4 h-4" />
                  <span>{props.isLoading ? "Opening..." : "Browse Folders"}</span>
                </div>
                <kbd class="px-1.5 py-0.5 text-xs font-semibold bg-blue-700 border border-blue-500 rounded">
                  Cmd+Enter
                </kbd>
              </button>
            </div>
          </div>
        </div>

        <div class="mt-6 px-4 py-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
          <div class="flex items-center justify-center flex-wrap gap-3 text-xs text-gray-500 dark:text-gray-400">
            <Show when={folders().length > 0}>
              <div class="flex items-center gap-1.5">
                <kbd class="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded font-mono">
                  ↑
                </kbd>
                <kbd class="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded font-mono">
                  ↓
                </kbd>
                <span>Navigate</span>
              </div>
              <div class="flex items-center gap-1.5">
                <kbd class="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded font-mono">
                  Enter
                </kbd>
                <span>Select</span>
              </div>
              <div class="flex items-center gap-1.5">
                <kbd class="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded font-mono">
                  Del
                </kbd>
                <span>Remove</span>
              </div>
            </Show>
            <div class="flex items-center gap-1.5">
              <kbd class="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded">
                Cmd+Enter
              </kbd>
              <span>Browse</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default FolderSelectionView
