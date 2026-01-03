import { Component, createSignal, Show, onMount } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { X, FolderTree } from "lucide-solid"
import { serverApi } from "../lib/api-client"
import { useMarkdownPreview } from "../lib/hooks/use-markdown-preview"
import FolderTreeNode from "./folder-tree-node"
import MarkdownPreviewModal from "./markdown-preview-modal"
import type { FileSystemEntry } from "../../../server/src/api-types"
import { getLogger } from "../lib/logger"

const log = getLogger("api")

/**
 * Props for FolderTreeBrowser component
 */
interface FolderTreeBrowserProps {
  /** Whether the browser modal is open */
  isOpen: boolean

  /** Workspace ID to browse files from */
  workspaceId: string

  /** Workspace display name (optional) */
  workspaceName?: string

  /** Callback when modal closes */
  onClose: () => void
}

/**
 * Folder Tree Browser Modal Component
 * 
 * VSCode-style file tree browser that displays workspace files and folders.
 * 
 * Features:
 * - Collapsible folder tree structure
 * - Double-click markdown files to preview
 * - Read-only for non-markdown files
 * - Lazy loading of folder contents
 * - Keyboard navigation support
 * 
 * @example
 * <FolderTreeBrowser
 *   isOpen={browserOpen()}
 *   workspaceId={instance.id}
 *   workspaceName={instance.name}
 *   onClose={() => setBrowserOpen(false)}
 * />
 */
const FolderTreeBrowser: Component<FolderTreeBrowserProps> = (props) => {
  const [rootEntries, setRootEntries] = createSignal<FileSystemEntry[]>([])
  const [isLoadingRoot, setIsLoadingRoot] = createSignal(false)
  const [rootError, setRootError] = createSignal<string | null>(null)
  const [previewFile, setPreviewFile] = createSignal<FileSystemEntry | null>(null)

  const preview = useMarkdownPreview()

  /**
   * Fetch root directory entries when modal opens
   */
  onMount(() => {
    if (props.isOpen) {
      void loadRootDirectory()
    }
  })

  /**
   * Load root directory contents
   */
  async function loadRootDirectory() {
    setIsLoadingRoot(true)
    setRootError(null)
    try {
      log.info("Loading root directory for workspace:", props.workspaceId)
      const entries = await serverApi.listWorkspaceFiles(props.workspaceId, ".")
      
      // Sort: directories first, then files, both alphabetically
      const sorted = entries.sort((a, b) => {
        if (a.type === b.type) {
          return a.name.localeCompare(b.name)
        }
        return a.type === "directory" ? -1 : 1
      })
      
      setRootEntries(sorted)
      log.info("Loaded root directory:", sorted.length, "entries")
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load workspace files"
      log.error("Failed to load root directory:", err)
      setRootError(message)
    } finally {
      setIsLoadingRoot(false)
    }
  }

  /**
   * Fetch children for a directory (used by FolderTreeNode)
   */
  async function fetchChildren(_workspaceId: string, path: string): Promise<FileSystemEntry[]> {
    log.info("Fetching children for path:", path)
    return await serverApi.listWorkspaceFiles(props.workspaceId, path)
  }

  /**
   * Handle double-click on a file
   * - Markdown files: open preview modal
   * - Other files: no action (read-only)
   */
  function handleFileDoubleClick(entry: FileSystemEntry) {
    log.info("File double-clicked:", entry.name, "type:", entry.type)
    
    if (entry.type !== "file") {
      return
    }

    const isMarkdown = entry.name.toLowerCase().endsWith(".md")
    
    if (isMarkdown) {
      log.info("Opening markdown preview for:", entry.path)
      setPreviewFile(entry)
      void preview.fetch(entry.path)
    } else {
      log.info("Non-markdown file clicked - no action:", entry.name)
      // Could show a toast/notification here if desired
    }
  }

  /**
   * Close markdown preview modal
   */
  function handleClosePreview() {
    setPreviewFile(null)
    preview.clear()
  }

  /**
   * Get display title for the browser
   */
  const getTitle = () => {
    return props.workspaceName 
      ? `Files - ${props.workspaceName}` 
      : "Workspace Files"
  }

  return (
    <>
      {/* Folder Tree Browser Modal */}
      <Dialog open={props.isOpen} onOpenChange={(open) => !open && props.onClose()}>
        <Dialog.Portal>
          <Dialog.Overlay class="modal-overlay" />

          <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
            <Dialog.Content class="folder-tree-browser-content">
              {/* Header */}
              <header class="folder-tree-browser-header">
                <div class="folder-tree-browser-title-container">
                  <FolderTree size={20} />
                  <Dialog.Title class="folder-tree-browser-title">
                    {getTitle()}
                  </Dialog.Title>
                </div>

                <button
                  type="button"
                  class="folder-tree-browser-close-btn"
                  onClick={props.onClose}
                  aria-label="Close browser"
                  title="Close (ESC)"
                >
                  <X size={20} />
                </button>
              </header>

              {/* Content area */}
              <div class="folder-tree-browser-body">
                {/* Loading state */}
                <Show when={isLoadingRoot()}>
                  <div class="folder-tree-browser-loading">
                    <div class="spinner-small"></div>
                    <p>Loading workspace files...</p>
                  </div>
                </Show>

                {/* Error state */}
                <Show when={rootError() && !isLoadingRoot()}>
                  <div class="folder-tree-browser-error">
                    <div class="folder-tree-browser-error-icon">⚠</div>
                    <div class="folder-tree-browser-error-content">
                      <h3>Could not load files</h3>
                      <p>{rootError()}</p>
                      <button
                        type="button"
                        class="folder-tree-browser-retry-btn"
                        onClick={() => void loadRootDirectory()}
                      >
                        Retry
                      </button>
                    </div>
                  </div>
                </Show>

                {/* Tree view */}
                <Show when={!isLoadingRoot() && !rootError()}>
                  <div class="folder-tree-browser-tree" role="tree">
                    <Show when={rootEntries().length === 0}>
                      <div class="folder-tree-browser-empty">
                        <p>No files found in workspace</p>
                      </div>
                    </Show>

                    <Show when={rootEntries().length > 0}>
                      {rootEntries().map((entry) => (
                        <FolderTreeNode
                          entry={entry}
                          workspaceId={props.workspaceId}
                          level={0}
                          onFileDoubleClick={handleFileDoubleClick}
                          fetchChildren={fetchChildren}
                        />
                      ))}
                    </Show>
                  </div>
                </Show>
              </div>

              {/* Footer */}
              <footer class="folder-tree-browser-footer">
                <p class="folder-tree-browser-hint">
                  💡 Double-click markdown files to preview
                </p>
              </footer>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog>

      {/* Markdown Preview Modal (nested) */}
      <Show when={previewFile()}>
        <MarkdownPreviewModal
          isOpen={Boolean(previewFile())}
          filePath={previewFile()!.path}
          content={preview.content()}
          isLoading={preview.isLoading()}
          error={preview.error()}
          onClose={handleClosePreview}
        />
      </Show>
    </>
  )
}

export default FolderTreeBrowser
