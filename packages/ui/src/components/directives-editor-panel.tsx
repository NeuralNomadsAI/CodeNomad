import { Component, Show, For, createSignal, createEffect, createMemo } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { X, FileText, Save, RefreshCw, AlertTriangle, Check, Globe, FolderCog, Undo2, Download, Eye, Edit3, FileCode, Sparkles, GitCompare } from "lucide-solid"
import { Markdown } from "./markdown"
import { getLogger } from "../lib/logger"
import { ERA_CODE_API_BASE } from "../lib/api-client"

const log = getLogger("directives-editor")

function apiUrl(path: string): string {
  return ERA_CODE_API_BASE ? `${ERA_CODE_API_BASE}${path}` : path
}

// Directive templates for common use cases
const DIRECTIVE_TEMPLATES = [
  {
    id: "standard",
    name: "Standard Project",
    description: "Code style, testing, and git workflow",
    content: `# Project Directives

## Code Style
- Use TypeScript strict mode
- Follow ESLint and Prettier configurations
- Prefer functional components with clear interfaces

## Testing Requirements
- Write unit tests for utility functions
- Integration tests for API endpoints
- Maintain 80% code coverage minimum

## Git Workflow
- Create feature branches from \`main\`
- Use conventional commits (feat:, fix:, chore:, docs:)
- Keep PRs small and focused (<400 lines)
- Require PR reviews before merging

## Documentation
- Document public APIs with JSDoc comments
- Keep README up to date
- Document breaking changes in CHANGELOG
`,
  },
  {
    id: "security",
    name: "Security-Focused",
    description: "Security constraints and prohibited actions",
    content: `# Security Directives

## Prohibited Actions
- NEVER commit API keys, tokens, or secrets
- NEVER disable security linters or type checking
- NEVER use \`eval()\` or dynamic code execution
- NEVER store sensitive data in localStorage

## Data Handling
- Validate all user input at API boundaries
- Use parameterized queries for database operations
- Sanitize data before rendering to prevent XSS
- Encrypt sensitive data at rest and in transit

## Dependencies
- Review security advisories before updating
- Use lockfiles for deterministic builds
- Audit dependencies monthly with \`npm audit\`

## Access Control
- Use principle of least privilege
- Log all authentication attempts
- Implement rate limiting on auth endpoints
`,
  },
  {
    id: "architecture",
    name: "Architecture Constraints",
    description: "Structural rules and boundaries",
    content: `# Architecture Directives

## Project Structure
- \`/src\` - Source code only
- \`/tests\` - Test files mirror src structure
- \`/docs\` - Documentation and ADRs

## Dependencies
- Prefer established libraries over custom solutions
- Limit direct dependencies to under 50
- No circular dependencies between modules

## Performance
- Lazy load components where possible
- Keep bundle size under 500KB
- Use code splitting for routes

## API Design
- RESTful endpoints for CRUD operations
- Use proper HTTP status codes
- Version APIs via URL path (/v1/, /v2/)
`,
  },
  {
    id: "cicd",
    name: "CI/CD & DevOps",
    description: "Deployment and infrastructure rules",
    content: `# CI/CD Directives

## Pipeline Requirements
- All PRs must pass CI checks before merge
- Deploy to staging before production
- Automated rollback on health check failures

## Infrastructure
- Use Infrastructure as Code (Terraform/Pulumi)
- No manual changes to production
- All config via environment variables

## Monitoring
- All services must export health endpoints
- Log errors with structured JSON
- Set up alerts for error rate > 1%

## Deployment
- Blue-green deployments for zero downtime
- Feature flags for gradual rollouts
- Database migrations run before app deployment
`,
  },
]

interface DirectivesEditorPanelProps {
  open: boolean
  onClose: () => void
  folder?: string
}

type DirectivesType = "project" | "global"
type ViewMode = "edit" | "preview" | "diff"

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
  const [viewMode, setViewMode] = createSignal<ViewMode>("edit")
  const [showTemplates, setShowTemplates] = createSignal(false)
  const [undoHistory, setUndoHistory] = createSignal<string[]>([])
  const [redoHistory, setRedoHistory] = createSignal<string[]>([])

  const hasChanges = () => content() !== originalContent()
  const canUndo = () => undoHistory().length > 0
  const canRedo = () => redoHistory().length > 0

  // Calculate diff between original and current content
  const diffLines = createMemo(() => {
    const original = originalContent().split("\n")
    const current = content().split("\n")
    const lines: Array<{ type: "unchanged" | "added" | "removed"; content: string; lineNum?: number }> = []

    const maxLen = Math.max(original.length, current.length)
    for (let i = 0; i < maxLen; i++) {
      const origLine = original[i]
      const currLine = current[i]

      if (origLine === currLine) {
        lines.push({ type: "unchanged", content: currLine ?? "", lineNum: i + 1 })
      } else {
        if (origLine !== undefined && (currLine === undefined || origLine !== currLine)) {
          lines.push({ type: "removed", content: origLine, lineNum: i + 1 })
        }
        if (currLine !== undefined && (origLine === undefined || origLine !== currLine)) {
          lines.push({ type: "added", content: currLine, lineNum: i + 1 })
        }
      }
    }
    return lines
  })

  // Push current state to undo history before making changes
  const pushToUndoHistory = () => {
    setUndoHistory((prev) => [...prev.slice(-19), content()]) // Keep last 20
    setRedoHistory([]) // Clear redo on new change
  }

  const handleContentChange = (newContent: string) => {
    pushToUndoHistory()
    setContent(newContent)
  }

  const handleUndo = () => {
    const history = undoHistory()
    if (history.length === 0) return
    const prevContent = history[history.length - 1]
    setUndoHistory((prev) => prev.slice(0, -1))
    setRedoHistory((prev) => [...prev, content()])
    setContent(prevContent)
  }

  const handleRedo = () => {
    const history = redoHistory()
    if (history.length === 0) return
    const nextContent = history[history.length - 1]
    setRedoHistory((prev) => prev.slice(0, -1))
    setUndoHistory((prev) => [...prev, content()])
    setContent(nextContent)
  }

  const handleRevert = () => {
    if (!hasChanges()) return
    if (confirm("Revert all changes to the last saved version?")) {
      pushToUndoHistory()
      setContent(originalContent())
    }
  }

  const handleExport = () => {
    const blob = new Blob([content()], { type: "text/markdown" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `directives-${activeType()}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const applyTemplate = (template: (typeof DIRECTIVE_TEMPLATES)[0]) => {
    if (content().trim() && !confirm("Replace current content with template?")) {
      return
    }
    pushToUndoHistory()
    setContent(template.content)
    setShowTemplates(false)
  }

  const loadDirectives = async (type: DirectivesType) => {
    setLoading(true)
    setError(null)
    setUndoHistory([])
    setRedoHistory([])

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

              {/* Toolbar */}
              <Show when={!loading()}>
                <div class="directives-toolbar">
                  {/* View Mode Toggles */}
                  <div class="directives-toolbar-group">
                    <button
                      type="button"
                      class={`directives-toolbar-btn ${viewMode() === "edit" ? "active" : ""}`}
                      onClick={() => setViewMode("edit")}
                      title="Edit mode"
                    >
                      <Edit3 class="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      class={`directives-toolbar-btn ${viewMode() === "preview" ? "active" : ""}`}
                      onClick={() => setViewMode("preview")}
                      title="Preview mode"
                    >
                      <Eye class="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      class={`directives-toolbar-btn ${viewMode() === "diff" ? "active" : ""}`}
                      onClick={() => setViewMode("diff")}
                      disabled={!hasChanges()}
                      title="Diff view (show changes)"
                    >
                      <GitCompare class="w-4 h-4" />
                    </button>
                  </div>

                  <div class="directives-toolbar-divider" />

                  {/* Undo/Redo */}
                  <div class="directives-toolbar-group">
                    <button
                      type="button"
                      class="directives-toolbar-btn"
                      onClick={handleUndo}
                      disabled={!canUndo()}
                      title={`Undo (${undoHistory().length} available)`}
                    >
                      <Undo2 class="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      class="directives-toolbar-btn"
                      onClick={handleRedo}
                      disabled={!canRedo()}
                      title={`Redo (${redoHistory().length} available)`}
                    >
                      <Undo2 class="w-4 h-4" style={{ transform: "scaleX(-1)" }} />
                    </button>
                    <button
                      type="button"
                      class="directives-toolbar-btn"
                      onClick={handleRevert}
                      disabled={!hasChanges()}
                      title="Revert to last saved version"
                    >
                      <RefreshCw class="w-4 h-4" />
                    </button>
                  </div>

                  <div class="directives-toolbar-divider" />

                  {/* Templates & Export */}
                  <div class="directives-toolbar-group">
                    <button
                      type="button"
                      class={`directives-toolbar-btn ${showTemplates() ? "active" : ""}`}
                      onClick={() => setShowTemplates(!showTemplates())}
                      title="Templates"
                    >
                      <Sparkles class="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      class="directives-toolbar-btn"
                      onClick={handleExport}
                      disabled={!content()}
                      title="Export as markdown file"
                    >
                      <Download class="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </Show>

              {/* Templates Panel */}
              <Show when={showTemplates() && !loading()}>
                <div class="directives-templates">
                  <div class="directives-templates-header">
                    <span>Choose a template to get started</span>
                    <button
                      type="button"
                      class="directives-templates-close"
                      onClick={() => setShowTemplates(false)}
                    >
                      <X class="w-4 h-4" />
                    </button>
                  </div>
                  <div class="directives-templates-grid">
                    <For each={DIRECTIVE_TEMPLATES}>
                      {(template) => (
                        <button
                          type="button"
                          class="directives-template-card"
                          onClick={() => applyTemplate(template)}
                        >
                          <div class="directives-template-name">{template.name}</div>
                          <div class="directives-template-description">{template.description}</div>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              {/* Edit Mode */}
              <Show when={!loading() && viewMode() === "edit"}>
                <div class="directives-editor-wrapper">
                  <textarea
                    class="directives-editor-textarea"
                    value={content()}
                    onInput={(e) => handleContentChange(e.currentTarget.value)}
                    placeholder={`# ${activeType() === "project" ? "Project" : "Global"} Directives

Click the sparkles button above to use a template, or start typing...

## Code Style
- Use TypeScript strict mode
- Prefer functional components

## Git Workflow
- Use conventional commits
- Keep PRs small and focused
`}
                    spellcheck={false}
                  />
                </div>
              </Show>

              {/* Preview Mode */}
              <Show when={!loading() && viewMode() === "preview"}>
                <div class="directives-preview">
                  <Show when={content().trim()}>
                    <div class="directives-preview-content">
                      <Markdown part={{ type: "text", text: content() }} />
                    </div>
                  </Show>
                  <Show when={!content().trim()}>
                    <div class="directives-preview-empty">
                      No content to preview. Switch to edit mode to add directives.
                    </div>
                  </Show>
                </div>
              </Show>

              {/* Diff Mode */}
              <Show when={!loading() && viewMode() === "diff"}>
                <div class="directives-diff">
                  <Show when={hasChanges()}>
                    <div class="directives-diff-content">
                      <For each={diffLines()}>
                        {(line) => (
                          <div class={`directives-diff-line directives-diff-line--${line.type}`}>
                            <span class="directives-diff-prefix">
                              {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
                            </span>
                            <span class="directives-diff-text">{line.content || "\u00A0"}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={!hasChanges()}>
                    <div class="directives-diff-empty">
                      No changes to display.
                    </div>
                  </Show>
                </div>
              </Show>

              {/* Actions */}
              <div class="directives-editor-actions">
                <Show when={hasChanges()}>
                  <span class="directives-editor-changes-indicator">Unsaved changes</span>
                </Show>
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
