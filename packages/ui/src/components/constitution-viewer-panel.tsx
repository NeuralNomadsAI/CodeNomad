import { Component, Show, createSignal, createEffect } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { X, Book, RefreshCw, AlertTriangle, FileQuestion } from "lucide-solid"
import { Markdown } from "./markdown"
import { cn } from "../lib/cn"
import { Button } from "./ui"
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
          <Dialog.Content class={cn("settings-panel w-[500px]")}>
            <div class="flex items-center justify-between px-4 py-3 border-b border-border">
              <Dialog.Title class="text-sm font-semibold text-foreground">
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
                <div class={cn("flex items-center gap-2 mb-4 text-xs text-muted-foreground")}>
                  <code class={cn("px-2 py-1 rounded font-mono bg-secondary")}>{filePath()}</code>
                </div>
              </Show>

              {/* Error State */}
              <Show when={error()}>
                <div class={cn("flex items-center gap-2 p-4 rounded-md bg-destructive/10 text-destructive")}>
                  <AlertTriangle class="w-5 h-5" />
                  <span>{error()}</span>
                </div>
              </Show>

              {/* Loading State */}
              <Show when={loading()}>
                <div class={cn("flex items-center justify-center gap-3 py-8 text-muted-foreground")}>
                  <div class={cn("w-5 h-5 animate-spin rounded-full border-2 border-border border-t-info")} />
                  <span>Loading constitution...</span>
                </div>
              </Show>

              {/* No Constitution */}
              <Show when={!loading() && !error() && !fileExists()}>
                <div class={cn("flex flex-col items-center justify-center gap-3 py-12 text-center text-muted-foreground")}>
                  <FileQuestion class="w-12 h-12" />
                  <h3 class={cn("text-lg font-medium text-foreground")}>No Constitution Found</h3>
                  <p class={cn("text-sm max-w-xs")}>
                    This project does not have a constitution defined. Run the Era Code bootstrap command to create one.
                  </p>
                  <code class={cn("mt-4 px-4 py-2 rounded-md text-sm font-mono bg-secondary text-foreground")}>era-code bootstrap</code>
                </div>
              </Show>

              {/* Constitution Content */}
              <Show when={!loading() && !error() && fileExists() && content()}>
                <div class={cn("space-y-4")}>
                  <div class={cn("flex items-center gap-2 p-3 rounded-md text-sm bg-info/10 text-info")}>
                    <Book class="w-4 h-4" />
                    <span>The constitution is read-only and defines immutable architectural constraints.</span>
                  </div>
                  <div class={cn("p-4 rounded-lg overflow-auto max-h-[60vh] bg-secondary border border-border")}>
                    <Markdown
                      part={{ type: "text", text: content() }}
                      isDark={isDark()}
                    />
                  </div>
                </div>
              </Show>

              {/* Reload Button */}
              <Show when={!loading()}>
                <div class={cn("flex items-center justify-end gap-2")}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={loadConstitution}
                    disabled={loading()}
                  >
                    <RefreshCw class={cn("w-4 h-4", loading() && "animate-spin")} />
                    <span>Reload</span>
                  </Button>
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
