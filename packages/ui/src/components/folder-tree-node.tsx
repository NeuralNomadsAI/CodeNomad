import { Component, createSignal, Show, For } from "solid-js"
import { ChevronRight, ChevronDown, File, Folder, FolderOpen } from "lucide-solid"
import type { FileSystemEntry } from "../../../server/src/api-types"

/**
 * Props for FolderTreeNode component
 */
interface FolderTreeNodeProps {
  /** File system entry (file or directory) */
  entry: FileSystemEntry

  /** Workspace ID for API calls */
  workspaceId: string

  /** Current indentation level (0 = root) */
  level: number

  /** Callback when a file is double-clicked */
  onFileDoubleClick: (entry: FileSystemEntry) => void

  /** Function to fetch child entries for a directory */
  fetchChildren: (workspaceId: string, path: string) => Promise<FileSystemEntry[]>
}

/**
 * Recursive tree node component for displaying files and folders
 * 
 * Features:
 * - Collapsible folders with chevron indicator
 * - File/folder icons
 * - Double-click to open files
 * - Lazy loading of folder contents
 * - Keyboard accessible
 */
const FolderTreeNode: Component<FolderTreeNodeProps> = (props) => {
  const [isExpanded, setIsExpanded] = createSignal(false)
  const [children, setChildren] = createSignal<FileSystemEntry[]>([])
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const isDirectory = () => props.entry.type === "directory"
  const isMarkdownFile = () => {
    return props.entry.type === "file" && props.entry.name.toLowerCase().endsWith(".md")
  }

  /**
   * Toggle folder expand/collapse
   */
  async function handleToggle() {
    if (!isDirectory()) return

    if (!isExpanded()) {
      // Expanding - fetch children if not already loaded
      if (children().length === 0 && !isLoading() && !error()) {
        setIsLoading(true)
        setError(null)
        try {
          const entries = await props.fetchChildren(props.workspaceId, props.entry.path)
          // Sort: directories first, then files, both alphabetically
          const sorted = entries.sort((a, b) => {
            if (a.type === b.type) {
              return a.name.localeCompare(b.name)
            }
            return a.type === "directory" ? -1 : 1
          })
          setChildren(sorted)
        } catch (err) {
          const message = err instanceof Error ? err.message : "Failed to load folder contents"
          setError(message)
        } finally {
          setIsLoading(false)
        }
      }
      setIsExpanded(true)
    } else {
      // Collapsing
      setIsExpanded(false)
    }
  }

  /**
   * Handle double-click on files
   */
  function handleDoubleClick(e: MouseEvent) {
    if (isDirectory()) {
      // For directories, just toggle
      void handleToggle()
    } else {
      // For files, trigger callback
      e.stopPropagation()
      props.onFileDoubleClick(props.entry)
    }
  }

  /**
   * Handle single click for directories (toggle expand/collapse)
   */
  function handleClick(e: MouseEvent) {
    if (isDirectory()) {
      e.stopPropagation()
      void handleToggle()
    }
  }

  /**
   * Handle keyboard navigation
   */
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      if (isDirectory()) {
        void handleToggle()
      } else {
        props.onFileDoubleClick(props.entry)
      }
    } else if (e.key === "ArrowRight" && isDirectory() && !isExpanded()) {
      e.preventDefault()
      void handleToggle()
    } else if (e.key === "ArrowLeft" && isDirectory() && isExpanded()) {
      e.preventDefault()
      setIsExpanded(false)
    }
  }

  return (
    <div class="folder-tree-node" data-level={props.level}>
      {/* Node row */}
      <div
        class="folder-tree-node-row"
        classList={{
          "folder-tree-node-directory": isDirectory(),
          "folder-tree-node-file": !isDirectory(),
          "folder-tree-node-markdown": isMarkdownFile(),
          "folder-tree-node-expanded": isExpanded(),
        }}
        style={{ "padding-left": `${props.level * 16 + 8}px` }}
        onClick={handleClick}
        onDblClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role={isDirectory() ? "button" : "treeitem"}
        aria-expanded={isDirectory() ? isExpanded() : undefined}
        title={props.entry.path}
      >
        {/* Chevron icon for directories */}
        <Show when={isDirectory()}>
          <span class="folder-tree-node-chevron">
            <Show when={isExpanded()} fallback={<ChevronRight size={16} />}>
              <ChevronDown size={16} />
            </Show>
          </span>
        </Show>

        {/* File/Folder icon */}
        <span class="folder-tree-node-icon">
          <Show when={isDirectory()} fallback={<File size={16} />}>
            <Show when={isExpanded()} fallback={<Folder size={16} />}>
              <FolderOpen size={16} />
            </Show>
          </Show>
        </span>

        {/* Name */}
        <span class="folder-tree-node-name">{props.entry.name}</span>
      </div>

      {/* Children (for expanded directories) */}
      <Show when={isDirectory() && isExpanded()}>
        <div class="folder-tree-node-children" role="group">
          {/* Loading state */}
          <Show when={isLoading()}>
            <div class="folder-tree-node-loading" style={{ "padding-left": `${(props.level + 1) * 16 + 8}px` }}>
              <span class="spinner-small"></span>
              <span>Loading...</span>
            </div>
          </Show>

          {/* Error state */}
          <Show when={error()}>
            <div class="folder-tree-node-error" style={{ "padding-left": `${(props.level + 1) * 16 + 8}px` }}>
              <span>⚠ {error()}</span>
            </div>
          </Show>

          {/* Child nodes */}
          <Show when={!isLoading() && !error()}>
            <For each={children()}>
              {(childEntry) => (
                <FolderTreeNode
                  entry={childEntry}
                  workspaceId={props.workspaceId}
                  level={props.level + 1}
                  onFileDoubleClick={props.onFileDoubleClick}
                  fetchChildren={props.fetchChildren}
                />
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  )
}

export default FolderTreeNode
