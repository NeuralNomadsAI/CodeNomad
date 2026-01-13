import { Component, Show, createSignal, createEffect, onMount } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { X, FileCode, Save, RefreshCw, AlertTriangle, Check, ChevronDown } from "lucide-solid"
import { getLogger } from "../lib/logger"
import { ERA_CODE_API_BASE } from "../lib/api-client"

const log = getLogger("governance-advanced")

function apiUrl(path: string): string {
  return ERA_CODE_API_BASE ? `${ERA_CODE_API_BASE}${path}` : path
}

interface GovernanceAdvancedPanelProps {
  open: boolean
  onClose: () => void
  folder?: string
}

type YamlFileType = "local" | "project"

const GovernanceAdvancedPanel: Component<GovernanceAdvancedPanelProps> = (props) => {
  const [activeFile, setActiveFile] = createSignal<YamlFileType>("local")
  const [content, setContent] = createSignal("")
  const [originalContent, setOriginalContent] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [success, setSuccess] = createSignal(false)
  const [filePath, setFilePath] = createSignal("")
  const [fileExists, setFileExists] = createSignal(false)

  const hasChanges = () => content() !== originalContent()

  const loadFile = async (fileType: YamlFileType) => {
    if (!props.folder) return

    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams({
        folder: props.folder,
        file: fileType,
      })

      const response = await fetch(apiUrl(`/api/era/governance/yaml?${params}`))
      const data = await response.json()

      if (data.success) {
        setContent(data.content || "")
        setOriginalContent(data.content || "")
        setFilePath(data.path || "")
        setFileExists(data.exists || false)
      } else {
        setError(data.error || "Failed to load file")
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error"
      log.error("Failed to load governance YAML", { error: message })
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  const saveFile = async () => {
    if (!props.folder) return

    setSaving(true)
    setError(null)
    setSuccess(false)

    try {
      const response = await fetch(apiUrl("/api/era/governance/yaml"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folder: props.folder,
          file: activeFile(),
          content: content(),
        }),
      })

      const data = await response.json()

      if (data.success) {
        setOriginalContent(content())
        setFileExists(true)
        setSuccess(true)
        setTimeout(() => setSuccess(false), 3000)
        log.info("Governance YAML saved", { file: activeFile() })
      } else {
        setError(data.error || "Failed to save file")
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error"
      log.error("Failed to save governance YAML", { error: message })
      setError(message)
    } finally {
      setSaving(false)
    }
  }

  const handleFileChange = (fileType: YamlFileType) => {
    if (hasChanges()) {
      if (!confirm("You have unsaved changes. Discard them?")) {
        return
      }
    }
    setActiveFile(fileType)
  }

  createEffect(() => {
    if (props.open && props.folder) {
      loadFile(activeFile())
    }
  })

  createEffect(() => {
    if (props.open && props.folder) {
      loadFile(activeFile())
    }
  })

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()} modal>
      <Dialog.Portal>
        <Dialog.Overlay class="settings-panel-overlay" />
        <div class="fixed inset-y-0 right-0 z-50 flex">
          <Dialog.Content class="settings-panel governance-advanced-panel">
            <div class="settings-panel-header">
              <Dialog.Title class="settings-panel-title">
                <FileCode class="w-5 h-5" />
                <span>Advanced Governance</span>
              </Dialog.Title>
              <Dialog.CloseButton class="settings-panel-close">
                <X class="w-4 h-4" />
              </Dialog.CloseButton>
            </div>

            <div class="settings-panel-content">
              {/* File Selector */}
              <div class="governance-advanced-tabs">
                <button
                  type="button"
                  class={`governance-advanced-tab ${activeFile() === "local" ? "active" : ""}`}
                  onClick={() => handleFileChange("local")}
                >
                  Local Overrides
                </button>
                <button
                  type="button"
                  class={`governance-advanced-tab ${activeFile() === "project" ? "active" : ""}`}
                  onClick={() => handleFileChange("project")}
                >
                  Project Config
                </button>
              </div>

              {/* File Path */}
              <Show when={filePath()}>
                <div class="governance-advanced-path">
                  <code>{filePath()}</code>
                  <Show when={!fileExists()}>
                    <span class="governance-advanced-new">(New file)</span>
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
                  <span>File saved successfully</span>
                </div>
              </Show>

              {/* Loading State */}
              <Show when={loading()}>
                <div class="governance-loading">
                  <div class="governance-loading-spinner" />
                  <span>Loading file...</span>
                </div>
              </Show>

              {/* YAML Editor */}
              <Show when={!loading()}>
                <div class="governance-advanced-editor-wrapper">
                  <textarea
                    class="governance-advanced-editor"
                    value={content()}
                    onInput={(e) => setContent(e.currentTarget.value)}
                    placeholder={`# Era Code Governance Configuration
# ${activeFile() === "local" ? "Local overrides" : "Project-level rules"}

schema_version: 1

rules:
  # kubectl-apply:
  #   action: allow
  #   justification: "CI/CD handles deployments"

custom:
  # - pattern: "^npm publish"
  #   action: deny
  #   reason: "Use CI/CD for publishing"
`}
                    spellcheck={false}
                  />
                </div>
              </Show>

              {/* Actions */}
              <div class="governance-advanced-actions">
                <button
                  type="button"
                  class="governance-advanced-btn governance-advanced-btn-secondary"
                  onClick={() => loadFile(activeFile())}
                  disabled={loading() || saving()}
                >
                  <RefreshCw class={`w-4 h-4 ${loading() ? "animate-spin" : ""}`} />
                  <span>Reload</span>
                </button>
                <button
                  type="button"
                  class="governance-advanced-btn governance-advanced-btn-primary"
                  onClick={saveFile}
                  disabled={loading() || saving() || !hasChanges()}
                >
                  <Save class="w-4 h-4" />
                  <span>{saving() ? "Saving..." : "Save"}</span>
                </button>
              </div>

              {/* Help Text */}
              <div class="governance-advanced-help">
                <p>
                  <strong>Local Overrides</strong> (.era/governance.local.yaml) - Personal overrides that apply only to this machine.
                </p>
                <p>
                  <strong>Project Config</strong> (.era/governance.yaml) - Shared configuration committed to the repository.
                </p>
              </div>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

export default GovernanceAdvancedPanel
