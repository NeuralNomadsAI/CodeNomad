import { Component, Show } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { X } from "lucide-solid"
import { Markdown } from "./markdown"
import type { TextPart } from "../types/message"

/**
 * Modal dialog that displays markdown file preview with GitHub-style rendering
 */

interface MarkdownPreviewModalProps {
  // Whether modal is open/visible
  isOpen: boolean

  // Path to markdown file being previewed
  filePath: string

  // Markdown content (pre-fetched or null if loading)
  content?: string | null

  // True if content is being fetched
  isLoading?: boolean

  // Error message if fetch failed
  error?: string | null

  // Callback when modal closes (ESC, X button, click outside)
  onClose: () => void

  // Whether to use dark theme (optional, auto-detects if not provided)
  isDarkMode?: boolean
}

/**
 * MarkdownPreviewModal Component
 * 
 * Displays markdown file preview in a modal dialog.
 * Supports:
 * - Loading state with spinner
 * - Error state with friendly message
 * - GitHub markdown styling with syntax highlighting
 * - Dark/light theme support
 * - Keyboard accessible (ESC to close)
 * 
 * @example
 * <MarkdownPreviewModal
 *   isOpen={modalOpen()}
 *   filePath={previewFile()}
 *   content={preview.content()}
 *   isLoading={preview.isLoading()}
 *   error={preview.error()}
 *   onClose={() => setModalOpen(false)}
 * />
 */
const MarkdownPreviewModal: Component<MarkdownPreviewModalProps> = (props) => {
  const getFilename = () => {
    return props.filePath.split("/").pop() || props.filePath
  }

  const isDark = () => {
    if (props.isDarkMode !== undefined) return props.isDarkMode
    if (typeof window !== "undefined") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
    }
    return false
  }

  return (
    <Dialog open={props.isOpen} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        {/* Dark overlay */}
        <Dialog.Overlay class="modal-overlay" />

        {/* Modal container */}
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="markdown-preview-modal-content">
            {/* Header */}
            <header class="markdown-preview-modal-header">
              <div class="markdown-preview-modal-title-container">
                <Dialog.Title class="markdown-preview-modal-title">
                  {getFilename()}
                </Dialog.Title>
                <p class="markdown-preview-modal-path">{props.filePath}</p>
              </div>

              <button
                type="button"
                class="markdown-preview-modal-close-btn"
                onClick={props.onClose}
                aria-label="Close preview"
                title="Close (ESC)"
              >
                <X size={20} />
              </button>
            </header>

            {/* Content area */}
            <div class="markdown-preview-modal-body">
              {/* Loading state */}
              <Show when={props.isLoading && !props.content}>
                <div class="markdown-preview-loading">
                  <div class="markdown-preview-spinner"></div>
                  <p>Loading preview...</p>
                </div>
              </Show>

              {/* Error state */}
              <Show when={props.error && !props.content}>
                <div class="markdown-preview-error">
                  <div class="markdown-preview-error-icon">⚠</div>
                  <div class="markdown-preview-error-content">
                    <h3>Could not load file</h3>
                    <p>{props.error}</p>
                  </div>
                </div>
              </Show>

              {/* Success state - markdown content */}
              <Show when={props.content}>
                <div class="markdown-preview-rendered">
                  <Markdown
                    part={{
                      type: "text",
                      text: props.content!,
                      id: `preview-${props.filePath}`,
                    }}
                    isDark={isDark()}
                  />
                </div>
              </Show>

              {/* Empty state (no error, no loading, no content) */}
              <Show when={!props.isLoading && !props.error && !props.content}>
                <div class="markdown-preview-empty">
                  <p>No content to display</p>
                </div>
              </Show>
            </div>

            {/* Footer */}
            <footer class="markdown-preview-modal-footer">
              <p class="markdown-preview-modal-attribution">
                Powered by{" "}
                <a
                  href="https://github.com/sindresorhus/github-markdown-css"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  GitHub Markdown CSS
                </a>
              </p>
            </footer>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

export default MarkdownPreviewModal
