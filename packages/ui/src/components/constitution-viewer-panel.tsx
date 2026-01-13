import { Component, Show, createSignal, createEffect } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { X, Book, RefreshCw, AlertTriangle, FileQuestion } from "lucide-solid"
import { Markdown } from "./markdown"
import { useTheme } from "../lib/theme"
import { getLogger } from "../lib/logger"
import { ERA_CODE_API_BASE } from "../lib/api-client"

const log = getLogger("constitution-viewer")

function apiUrl(path: string): string {
  return ERA_CODE_API_BASE ? `${ERA_CODE_API_BASE}${path}` : path
}

interface ConstitutionViewerPanelProps {
  open: boolean
  onClose: () => void
  folder?: string
}

const ConstitutionViewerPanel: Component<ConstitutionViewerPanelProps> = (props) => {
  const { isDark } = useTheme()
  const [content, setContent] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [filePath, setFilePath] = createSignal("")
  const [fileExists, setFileExists] = createSignal(false)

  const loadConstitution = async () => {
    if (!props.folder) return

    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams({ folder: props.folder })
      const response = await fetch(apiUrl(`/api/era/constitution?${params}`))
      const data = await response.json()

      if (data.success) {
        setContent(data.content || "")
        setFilePath(data.path || "")
        setFileExists(data.exists || false)
      } else {
        setError(data.error || "Failed to load constitution")
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error"
      log.error("Failed to load constitution", { error: message })
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    if (props.open && props.folder) {
      loadConstitution()
    }
  })

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()} modal>
      <Dialog.Portal>
        <Dialog.Overlay class="settings-panel-overlay" />
        <div class="fixed inset-y-0 right-0 z-50 flex">
          <Dialog.Content class="settings-panel constitution-viewer-panel">
            <div class="settings-panel-header">
              <Dialog.Title class="settings-panel-title">
                <Book class="w-5 h-5" />
                <span>Constitution</span>
              </Dialog.Title>
              <Dialog.CloseButton class="settings-panel-close">
                <X class="w-4 h-4" />
              </Dialog.CloseButton>
            </div>

            <div class="settings-panel-content">
              {/* File Path */}
              <Show when={filePath()}>
                <div class="constitution-viewer-path">
                  <code>{filePath()}</code>
                </div>
              </Show>

              {/* Error State */}
              <Show when={error()}>
                <div class="governance-error">
                  <AlertTriangle class="w-5 h-5" />
                  <span>{error()}</span>
                </div>
              </Show>

              {/* Loading State */}
              <Show when={loading()}>
                <div class="governance-loading">
                  <div class="governance-loading-spinner" />
                  <span>Loading constitution...</span>
                </div>
              </Show>

              {/* No Constitution */}
              <Show when={!loading() && !error() && !fileExists()}>
                <div class="constitution-viewer-empty">
                  <FileQuestion class="w-12 h-12" />
                  <h3>No Constitution Found</h3>
                  <p>
                    This project does not have a constitution defined. Run the Era Code bootstrap command to create one.
                  </p>
                  <code class="constitution-viewer-command">era-code bootstrap</code>
                </div>
              </Show>

              {/* Constitution Content */}
              <Show when={!loading() && !error() && fileExists() && content()}>
                <div class="constitution-viewer-content">
                  <div class="constitution-viewer-notice">
                    <Book class="w-4 h-4" />
                    <span>The constitution is read-only and defines immutable architectural constraints.</span>
                  </div>
                  <div class="constitution-viewer-markdown">
                    <Markdown
                      part={{ type: "text", text: content() }}
                      isDark={isDark()}
                    />
                  </div>
                </div>
              </Show>

              {/* Reload Button */}
              <Show when={!loading()}>
                <div class="constitution-viewer-actions">
                  <button
                    type="button"
                    class="constitution-viewer-btn"
                    onClick={loadConstitution}
                    disabled={loading()}
                  >
                    <RefreshCw class={`w-4 h-4 ${loading() ? "animate-spin" : ""}`} />
                    <span>Reload</span>
                  </button>
                </div>
              </Show>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

export default ConstitutionViewerPanel
