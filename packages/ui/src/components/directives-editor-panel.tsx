import { Component, Show, createSignal, createEffect } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { X, FileText, Save, RefreshCw, AlertTriangle, Check, Globe, FolderCog } from "lucide-solid"
import { getLogger } from "../lib/logger"
import { ERA_CODE_API_BASE } from "../lib/api-client"

const log = getLogger("directives-editor")

function apiUrl(path: string): string {
  return ERA_CODE_API_BASE ? `${ERA_CODE_API_BASE}${path}` : path
}

interface DirectivesEditorPanelProps {
  open: boolean
  onClose: () => void
  folder?: string
}

type DirectivesType = "project" | "global"

const DirectivesEditorPanel: Component<DirectivesEditorPanelProps> = (props) => {
  const [activeType, setActiveType] = createSignal<DirectivesType>("project")
  const [content, setContent] = createSignal("")
  const [originalContent, setOriginalContent] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [success, setSuccess] = createSignal(false)
  const [filePath, setFilePath] = createSignal("")
  const [fileExists, setFileExists] = createSignal(false)

  const hasChanges = () => content() !== originalContent()

  const loadDirectives = async (type: DirectivesType) => {
    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams({ type })
      if (props.folder && type === "project") {
        params.set("folder", props.folder)
      }

      const response = await fetch(apiUrl(`/api/era/directives?${params}`))
      const data = await response.json()

      if (data.success) {
        setContent(data.content || "")
        setOriginalContent(data.content || "")
        setFilePath(data.path || "")
        setFileExists(data.exists || false)
      } else {
        setError(data.error || "Failed to load directives")
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error"
      log.error("Failed to load directives", { error: message })
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  const saveDirectives = async () => {
    if (!props.folder && activeType() === "project") return

    setSaving(true)
    setError(null)
    setSuccess(false)

    try {
      const response = await fetch(apiUrl("/api/era/directives"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folder: props.folder || "",
          type: activeType(),
          content: content(),
        }),
      })

      const data = await response.json()

      if (data.success) {
        setOriginalContent(content())
        setFileExists(true)
        setSuccess(true)
        setTimeout(() => setSuccess(false), 3000)
        log.info("Directives saved", { type: activeType() })
      } else {
        setError(data.error || "Failed to save directives")
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error"
      log.error("Failed to save directives", { error: message })
      setError(message)
    } finally {
      setSaving(false)
    }
  }

  const handleTypeChange = (type: DirectivesType) => {
    if (hasChanges()) {
      if (!confirm("You have unsaved changes. Discard them?")) {
        return
      }
    }
    setActiveType(type)
  }

  createEffect(() => {
    if (props.open) {
      loadDirectives(activeType())
    }
  })

  createEffect(() => {
    if (props.open) {
      loadDirectives(activeType())
    }
  })

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()} modal>
      <Dialog.Portal>
        <Dialog.Overlay class="settings-panel-overlay" />
        <div class="fixed inset-y-0 right-0 z-50 flex">
          <Dialog.Content class="settings-panel directives-editor-panel">
            <div class="settings-panel-header">
              <Dialog.Title class="settings-panel-title">
                <FileText class="w-5 h-5" />
                <span>Directives Editor</span>
              </Dialog.Title>
              <Dialog.CloseButton class="settings-panel-close">
                <X class="w-4 h-4" />
              </Dialog.CloseButton>
            </div>

            <div class="settings-panel-content">
              {/* Type Selector */}
              <div class="directives-editor-tabs">
                <button
                  type="button"
                  class={`directives-editor-tab ${activeType() === "project" ? "active" : ""}`}
                  onClick={() => handleTypeChange("project")}
                  disabled={!props.folder}
                >
                  <FolderCog class="w-4 h-4" />
                  <span>Project</span>
                </button>
                <button
                  type="button"
                  class={`directives-editor-tab ${activeType() === "global" ? "active" : ""}`}
                  onClick={() => handleTypeChange("global")}
                >
                  <Globe class="w-4 h-4" />
                  <span>Global</span>
                </button>
              </div>

              {/* File Path */}
              <Show when={filePath()}>
                <div class="directives-editor-path">
                  <code>{filePath()}</code>
                  <Show when={!fileExists()}>
                    <span class="directives-editor-new">(New file)</span>
                  </Show>
                </div>
              </Show>

              {/* Error State */}
              <Show when={error()}>
                <div class="governance-error">
                  <AlertTriangle class="w-5 h-5" />
                  <span>{error()}</span>
                </div>
              </Show>

              {/* Success State */}
              <Show when={success()}>
                <div class="governance-success">
                  <Check class="w-5 h-5" />
                  <span>Directives saved successfully</span>
                </div>
              </Show>

              {/* Loading State */}
              <Show when={loading()}>
                <div class="governance-loading">
                  <div class="governance-loading-spinner" />
                  <span>Loading directives...</span>
                </div>
              </Show>

              {/* Markdown Editor */}
              <Show when={!loading()}>
                <div class="directives-editor-wrapper">
                  <textarea
                    class="directives-editor-textarea"
                    value={content()}
                    onInput={(e) => setContent(e.currentTarget.value)}
                    placeholder={`# ${activeType() === "project" ? "Project" : "Global"} Directives

## Code Style
- Use TypeScript strict mode
- Prefer functional components

## Git Workflow
- Use conventional commits
- Keep PRs small and focused

## Testing
- Write tests for new features
- Maintain 80% coverage
`}
                    spellcheck={false}
                  />
                </div>
              </Show>

              {/* Actions */}
              <div class="directives-editor-actions">
                <button
                  type="button"
                  class="directives-editor-btn directives-editor-btn-secondary"
                  onClick={() => loadDirectives(activeType())}
                  disabled={loading() || saving()}
                >
                  <RefreshCw class={`w-4 h-4 ${loading() ? "animate-spin" : ""}`} />
                  <span>Reload</span>
                </button>
                <button
                  type="button"
                  class="directives-editor-btn directives-editor-btn-primary"
                  onClick={saveDirectives}
                  disabled={loading() || saving() || !hasChanges()}
                >
                  <Save class="w-4 h-4" />
                  <span>{saving() ? "Saving..." : "Save"}</span>
                </button>
              </div>

              {/* Help Text */}
              <div class="directives-editor-help">
                <p>
                  <strong>Project Directives</strong> define coding standards and workflows specific to this project.
                </p>
                <p>
                  <strong>Global Directives</strong> apply across all projects and can be overridden by project-level directives.
                </p>
              </div>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

export default DirectivesEditorPanel
