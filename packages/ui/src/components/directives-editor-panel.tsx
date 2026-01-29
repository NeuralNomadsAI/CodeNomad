import { Component, Show, For, createSignal, createEffect, createMemo } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { X, FileText, Save, RefreshCw, AlertTriangle, Check, Globe, FolderCog, Undo2, Download, Eye, FileCode, Sparkles, GitCompare, ChevronDown, ChevronRight, Plus, Pencil, Trash2, Search, LayoutGrid, CheckCircle2, XCircle } from "lucide-solid"
import { Markdown } from "./markdown"
import { getLogger } from "../lib/logger"
import { ERA_CODE_API_BASE } from "../lib/api-client"
import {
  parseDirectivesMarkdown,
  directivesToMarkdown,
  addDirective,
  removeDirective,
  updateDirective,
  getSectionColor,
  getSectionTitles,
  getDirectiveCount,
} from "../lib/directive-parser"
import type { DirectiveSection } from "../lib/directive-parser"
import {
  formatDirectiveRuleBased,
  validateDirective,
  getSuggestedSections,
} from "../lib/directive-formatter"

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
type ViewMode = "edit" | "preview" | "diff" | "structured"

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
  const [viewMode, setViewMode] = createSignal<ViewMode>("structured")
  const [showTemplates, setShowTemplates] = createSignal(false)
  const [undoHistory, setUndoHistory] = createSignal<string[]>([])
  const [redoHistory, setRedoHistory] = createSignal<string[]>([])

  // Structured view signals (Phase B)
  const [expandedSections, setExpandedSections] = createSignal<string[]>([])
  const [editingDirectiveId, setEditingDirectiveId] = createSignal<string | null>(null)
  const [editingText, setEditingText] = createSignal("")
  const [searchQuery, setSearchQuery] = createSignal("")
  const [showAddModal, setShowAddModal] = createSignal(false)
  const [addDirectiveText, setAddDirectiveText] = createSignal("")
  const [addDirectiveSection, setAddDirectiveSection] = createSignal("")

  // Wizard signals (Phase D)
  const [wizardStep, setWizardStep] = createSignal(1)
  const [selectedTemplate, setSelectedTemplate] = createSignal<string | null>(null)
  const [selectedSections, setSelectedSections] = createSignal<string[]>([])

  const hasChanges = () => content() !== originalContent()
  const canUndo = () => undoHistory().length > 0
  const canRedo = () => redoHistory().length > 0

  // Parsed sections memo (Phase B)
  const parsedSections = createMemo(() => parseDirectivesMarkdown(content()))

  // Filtered sections memo (Phase B)
  const filteredSections = createMemo(() => {
    const query = searchQuery().toLowerCase().trim()
    if (!query) return parsedSections()

    return parsedSections()
      .map((section) => ({
        ...section,
        directives: section.directives.filter(
          (d) =>
            d.text.toLowerCase().includes(query) ||
            section.title.toLowerCase().includes(query)
        ),
      }))
      .filter((section) => section.directives.length > 0)
  })

  // Total directive count (Phase A)
  const totalDirectiveCount = createMemo(() => getDirectiveCount(parsedSections()))
  const totalSectionCount = createMemo(() => parsedSections().length)

  // Empty state detection (Phase D)
  const isEmptyState = createMemo(() => !content().trim() && !loading())

  // Format preview memo for add directive (Phase C)
  const formatPreview = createMemo(() => {
    const text = addDirectiveText().trim()
    if (!text) return null

    const existingSectionTitles = getSectionTitles(parsedSections())
    const result = formatDirectiveRuleBased(text, existingSectionTitles)
    const validation = validateDirective(result.formatted)

    return {
      formatted: result.formatted,
      suggestedSection: result.suggestedSection,
      validation,
    }
  })

  // Initialize expanded sections when content changes
  createEffect(() => {
    const sections = parsedSections()
    if (sections.length > 0 && expandedSections().length === 0) {
      setExpandedSections(sections.map((s) => s.title))
    }
  })

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

  // Structured view operations (Phase B)
  const toggleSection = (title: string) => {
    setExpandedSections((prev) =>
      prev.includes(title) ? prev.filter((t) => t !== title) : [...prev, title]
    )
  }

  const expandAll = () => {
    setExpandedSections(parsedSections().map((s) => s.title))
  }

  const collapseAll = () => {
    setExpandedSections([])
  }

  const handleStructuredEdit = (directiveId: string, newText: string) => {
    const sections = parsedSections()
    const updated = updateDirective(sections, directiveId, newText)
    const newMarkdown = directivesToMarkdown(updated)
    pushToUndoHistory()
    setContent(newMarkdown)
    setEditingDirectiveId(null)
    setEditingText("")
  }

  const handleStructuredDelete = (directiveId: string) => {
    const sections = parsedSections()
    const updated = removeDirective(sections, directiveId)
    const newMarkdown = directivesToMarkdown(updated)
    pushToUndoHistory()
    setContent(newMarkdown)
  }

  const handleStructuredAdd = (text: string, sectionTitle: string) => {
    const sections = parsedSections()
    const updated = addDirective(sections, text, sectionTitle)
    const newMarkdown = directivesToMarkdown(updated)
    pushToUndoHistory()
    setContent(newMarkdown)
    // Ensure the target section is expanded
    if (!expandedSections().includes(sectionTitle)) {
      setExpandedSections((prev) => [...prev, sectionTitle])
    }
  }

  const startEditing = (directiveId: string, currentText: string) => {
    setEditingDirectiveId(directiveId)
    setEditingText(currentText)
  }

  const cancelEditing = () => {
    setEditingDirectiveId(null)
    setEditingText("")
  }

  // Add modal operations (Phase C - with AI-assisted input)
  const openAddModal = (sectionTitle?: string) => {
    setAddDirectiveText("")
    setAddDirectiveSection(sectionTitle || "")
    setShowAddModal(true)
  }

  const closeAddModal = () => {
    setShowAddModal(false)
    setAddDirectiveText("")
    setAddDirectiveSection("")
  }

  const handleAddFromModal = () => {
    const preview = formatPreview()
    if (!preview || !preview.validation.valid) return

    const section = addDirectiveSection() || preview.suggestedSection
    handleStructuredAdd(preview.formatted, section)
    closeAddModal()
  }

  // Quick-add from structured view (Phase C)
  const handleQuickAdd = () => {
    const preview = formatPreview()
    if (!preview || !preview.validation.valid) return

    const section = addDirectiveSection() || preview.suggestedSection
    handleStructuredAdd(preview.formatted, section)
    setAddDirectiveText("")
    setAddDirectiveSection("")
  }

  // Wizard operations (Phase D)
  const handleWizardSelectTemplate = (templateId: string) => {
    const template = DIRECTIVE_TEMPLATES.find((t) => t.id === templateId)
    if (!template) return

    setSelectedTemplate(templateId)
    // Parse template to get section names
    const sections = parseDirectivesMarkdown(template.content)
    setSelectedSections(sections.map((s) => s.title))
    setWizardStep(2)
  }

  const toggleWizardSection = (sectionTitle: string) => {
    setSelectedSections((prev) =>
      prev.includes(sectionTitle)
        ? prev.filter((s) => s !== sectionTitle)
        : [...prev, sectionTitle]
    )
  }

  const applyWizardTemplate = () => {
    const templateId = selectedTemplate()
    if (!templateId) return

    const template = DIRECTIVE_TEMPLATES.find((t) => t.id === templateId)
    if (!template) return

    const allSections = parseDirectivesMarkdown(template.content)
    const filteredSects = allSections.filter((s) => selectedSections().includes(s.title))
    const newContent = directivesToMarkdown(filteredSects)

    pushToUndoHistory()
    setContent(newContent)
    setWizardStep(1)
    setSelectedTemplate(null)
    setSelectedSections([])
  }

  const skipWizard = () => {
    setWizardStep(1)
    setSelectedTemplate(null)
    setSelectedSections([])
    setViewMode("edit")
  }

  const getWizardTemplateSections = createMemo(() => {
    const templateId = selectedTemplate()
    if (!templateId) return []
    const template = DIRECTIVE_TEMPLATES.find((t) => t.id === templateId)
    if (!template) return []
    return parseDirectivesMarkdown(template.content)
  })

  const wizardPreview = createMemo(() => {
    const sections = getWizardTemplateSections()
    const selected = selectedSections()
    const filtered = sections.filter((s) => selected.includes(s.title))
    return directivesToMarkdown(filtered)
  })

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

        // Initialize expanded sections from new content
        const sections = parseDirectivesMarkdown(data.content || "")
        setExpandedSections(sections.map((s) => s.title))
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
                      class={`directives-toolbar-btn ${viewMode() === "structured" ? "active" : ""}`}
                      onClick={() => setViewMode("structured")}
                      title="Structured view"
                      data-testid="structured-view-btn"
                    >
                      <LayoutGrid class="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      class={`directives-toolbar-btn ${viewMode() === "edit" ? "active" : ""}`}
                      onClick={() => setViewMode("edit")}
                      title="Source mode"
                      data-testid="source-view-btn"
                    >
                      <FileCode class="w-4 h-4" />
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

              {/* Directive Summary Bar (Phase A) */}
              <Show when={!loading() && viewMode() === "structured" && !isEmptyState()}>
                <div class="directives-summary-bar" data-testid="directives-summary">
                  <span>{totalDirectiveCount()} directives in {totalSectionCount()} sections</span>
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

              {/* Structured View (Phase B) */}
              <Show when={!loading() && viewMode() === "structured" && !isEmptyState()}>
                <div class="directives-structured-view" data-testid="structured-view">
                  {/* Search & Expand/Collapse Toolbar */}
                  <div class="directives-structured-toolbar">
                    <div class="directives-search">
                      <Search class="w-4 h-4" style={{ "flex-shrink": "0", color: "var(--text-muted)" }} />
                      <input
                        type="text"
                        placeholder="Search directives..."
                        value={searchQuery()}
                        onInput={(e) => setSearchQuery(e.currentTarget.value)}
                        data-testid="directives-search-input"
                      />
                      <Show when={searchQuery()}>
                        <button
                          type="button"
                          class="directives-search-clear"
                          onClick={() => setSearchQuery("")}
                        >
                          <X class="w-3 h-3" />
                        </button>
                      </Show>
                    </div>
                    <div class="directives-expand-collapse">
                      <button
                        type="button"
                        class="directives-expand-btn"
                        onClick={expandAll}
                        title="Expand all sections"
                      >
                        Expand All
                      </button>
                      <button
                        type="button"
                        class="directives-expand-btn"
                        onClick={collapseAll}
                        title="Collapse all sections"
                      >
                        Collapse All
                      </button>
                    </div>
                  </div>

                  {/* Quick-Add Input (Phase C) */}
                  <div class="directives-quick-add" data-testid="quick-add-input">
                    <textarea
                      class="directives-quick-add-textarea"
                      placeholder="Describe a rule in plain English, e.g. 'Never use eval()'"
                      value={addDirectiveText()}
                      onInput={(e) => setAddDirectiveText(e.currentTarget.value)}
                      rows={2}
                    />
                    <Show when={addDirectiveText().trim()}>
                      <div class="directives-quick-add-preview" data-testid="quick-add-preview">
                        <Show when={formatPreview()}>
                          {(preview) => (
                            <>
                              <div class="directives-quick-add-preview-row">
                                <span class="add-directive-preview-label">Formatted</span>
                                <span class="add-directive-preview-content">{preview().formatted}</span>
                              </div>
                              <div class="directives-quick-add-preview-row">
                                <span class="add-directive-preview-label">Section</span>
                                <span
                                  class="directives-section-badge"
                                  data-color={getSectionColor(addDirectiveSection() || preview().suggestedSection)}
                                  data-testid="suggested-section-badge"
                                >
                                  {addDirectiveSection() || preview().suggestedSection}
                                </span>
                                <select
                                  class="directives-quick-add-section-override"
                                  value={addDirectiveSection()}
                                  onChange={(e) => setAddDirectiveSection(e.currentTarget.value)}
                                >
                                  <option value="">Auto</option>
                                  <For each={[...getSectionTitles(parsedSections()), ...getSuggestedSections()].filter((v, i, a) => a.indexOf(v) === i)}>
                                    {(section) => <option value={section}>{section}</option>}
                                  </For>
                                </select>
                              </div>
                              <div class="directives-quick-add-preview-row">
                                <Show when={preview().validation.valid}>
                                  <span class="directives-validation-ok">
                                    <CheckCircle2 class="w-3 h-3" />
                                    Valid
                                  </span>
                                </Show>
                                <Show when={!preview().validation.valid}>
                                  <span class="directives-validation-error">
                                    <XCircle class="w-3 h-3" />
                                    {preview().validation.error}
                                  </span>
                                </Show>
                              </div>
                            </>
                          )}
                        </Show>
                        <button
                          type="button"
                          class="directives-quick-add-btn"
                          onClick={handleQuickAdd}
                          disabled={!formatPreview()?.validation.valid}
                          data-testid="quick-add-btn"
                        >
                          <Plus class="w-4 h-4" />
                          Add
                        </button>
                      </div>
                    </Show>
                  </div>

                  {/* Search Results Count */}
                  <Show when={searchQuery()}>
                    <div class="directives-search-results">
                      {filteredSections().reduce((c, s) => c + s.directives.length, 0)} results in {filteredSections().length} sections
                    </div>
                  </Show>

                  {/* Section Cards */}
                  <div class="directives-sections-list" data-testid="sections-list">
                    <For each={filteredSections()}>
                      {(section) => {
                        const color = () => getSectionColor(section.title)
                        const isExpanded = () => expandedSections().includes(section.title)

                        return (
                          <div class="directive-section" data-testid={`section-${section.title.toLowerCase().replace(/\s+/g, "-")}`}>
                            <button
                              type="button"
                              class="directive-section-header"
                              onClick={() => toggleSection(section.title)}
                            >
                              <div class="directive-section-header-info">
                                <span class="directive-section-chevron">
                                  <Show when={isExpanded()} fallback={<ChevronRight class="w-4 h-4" />}>
                                    <ChevronDown class="w-4 h-4" />
                                  </Show>
                                </span>
                                <div class="directive-section-color" data-color={color()} />
                                <span class="directive-section-title">{section.title}</span>
                                <span class="directive-section-count">{section.directives.length}</span>
                              </div>
                              <button
                                type="button"
                                class="directive-section-add-btn"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  openAddModal(section.title)
                                }}
                                title={`Add directive to ${section.title}`}
                              >
                                <Plus class="w-4 h-4" />
                              </button>
                            </button>

                            <Show when={isExpanded()}>
                              <div class="directive-cards-grid">
                                <For each={section.directives}>
                                  {(directive) => (
                                    <Show
                                      when={editingDirectiveId() === directive.id}
                                      fallback={
                                        <div
                                          class="directive-card"
                                          data-color={color()}
                                          data-testid={`directive-card-${directive.id}`}
                                        >
                                          <div class="directive-card-content">
                                            <span class="directive-card-text">{directive.text}</span>
                                            <div class="directive-card-actions">
                                              <button
                                                type="button"
                                                class="directive-card-action-btn"
                                                onClick={() => startEditing(directive.id, directive.text)}
                                                title="Edit directive"
                                                data-testid={`edit-btn-${directive.id}`}
                                              >
                                                <Pencil class="w-3.5 h-3.5" />
                                              </button>
                                              <button
                                                type="button"
                                                class="directive-card-action-btn delete"
                                                onClick={() => handleStructuredDelete(directive.id)}
                                                title="Delete directive"
                                                data-testid={`delete-btn-${directive.id}`}
                                              >
                                                <Trash2 class="w-3.5 h-3.5" />
                                              </button>
                                            </div>
                                          </div>
                                        </div>
                                      }
                                    >
                                      {/* Inline Edit Mode */}
                                      <div class="directive-card editing" data-color={color()}>
                                        <div class="directive-card-edit">
                                          <textarea
                                            class="directive-card-edit-input"
                                            value={editingText()}
                                            onInput={(e) => setEditingText(e.currentTarget.value)}
                                            onKeyDown={(e) => {
                                              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                                handleStructuredEdit(directive.id, editingText())
                                              }
                                              if (e.key === "Escape") {
                                                cancelEditing()
                                              }
                                            }}
                                            data-testid={`edit-textarea-${directive.id}`}
                                          />
                                          <div class="directive-card-edit-actions">
                                            <button
                                              type="button"
                                              class="directive-card-edit-btn directive-card-edit-btn-cancel"
                                              onClick={cancelEditing}
                                            >
                                              Cancel
                                            </button>
                                            <button
                                              type="button"
                                              class="directive-card-edit-btn directive-card-edit-btn-save"
                                              onClick={() => handleStructuredEdit(directive.id, editingText())}
                                              data-testid={`save-edit-btn-${directive.id}`}
                                            >
                                              Save
                                            </button>
                                          </div>
                                        </div>
                                      </div>
                                    </Show>
                                  )}
                                </For>
                              </div>
                            </Show>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </div>
              </Show>

              {/* Template Wizard for Empty State (Phase D) */}
              <Show when={!loading() && viewMode() === "structured" && isEmptyState()}>
                <div class="directives-wizard" data-testid="directives-wizard">
                  <Show when={wizardStep() === 1}>
                    <div class="directives-wizard-step" data-testid="wizard-step-1">
                      <h3 class="directives-wizard-heading">Get Started with Directives</h3>
                      <p class="directives-wizard-description">
                        Choose a template to pre-populate your directives, or start from scratch.
                      </p>
                      <div class="directives-wizard-grid">
                        <For each={DIRECTIVE_TEMPLATES}>
                          {(template) => (
                            <button
                              type="button"
                              class="directives-wizard-card"
                              onClick={() => handleWizardSelectTemplate(template.id)}
                              data-testid={`wizard-template-${template.id}`}
                            >
                              <div class="directives-wizard-card-name">{template.name}</div>
                              <div class="directives-wizard-card-description">{template.description}</div>
                            </button>
                          )}
                        </For>
                      </div>
                      <button
                        type="button"
                        class="directives-wizard-skip"
                        onClick={skipWizard}
                        data-testid="wizard-skip-btn"
                      >
                        Start from scratch
                      </button>
                    </div>
                  </Show>

                  <Show when={wizardStep() === 2}>
                    <div class="directives-wizard-step" data-testid="wizard-step-2">
                      <h3 class="directives-wizard-heading">Customize Sections</h3>
                      <p class="directives-wizard-description">
                        Toggle which sections to include from the template.
                      </p>
                      <div class="directives-wizard-section-toggles">
                        <For each={getWizardTemplateSections()}>
                          {(section) => (
                            <label class="directives-wizard-section-toggle" data-testid={`wizard-toggle-${section.title.toLowerCase().replace(/\s+/g, "-")}`}>
                              <input
                                type="checkbox"
                                checked={selectedSections().includes(section.title)}
                                onChange={() => toggleWizardSection(section.title)}
                              />
                              <div
                                class="directive-section-color"
                                data-color={getSectionColor(section.title)}
                              />
                              <span>{section.title}</span>
                              <span class="directives-wizard-section-count">({section.directives.length} directives)</span>
                            </label>
                          )}
                        </For>
                      </div>

                      <div class="directives-wizard-preview" data-testid="wizard-preview">
                        <div class="directives-wizard-preview-label">Preview</div>
                        <pre class="directives-wizard-preview-content">{wizardPreview()}</pre>
                      </div>

                      <div class="directives-wizard-actions">
                        <button
                          type="button"
                          class="directives-wizard-btn-back"
                          onClick={() => { setWizardStep(1); setSelectedTemplate(null) }}
                        >
                          Back
                        </button>
                        <button
                          type="button"
                          class="directives-wizard-btn-apply"
                          onClick={applyWizardTemplate}
                          disabled={selectedSections().length === 0}
                          data-testid="wizard-apply-btn"
                        >
                          Apply Template
                        </button>
                      </div>
                    </div>
                  </Show>
                </div>
              </Show>

              {/* Source Mode (renamed from Edit) */}
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
                    data-testid="source-textarea"
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

              {/* Add Directive Modal (Phase B + C enhancements) */}
              <Show when={showAddModal()}>
                <div class="add-directive-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) closeAddModal() }}>
                  <div class="add-directive-modal" data-testid="add-directive-modal">
                    <div class="add-directive-modal-header">
                      <h3>Add Directive</h3>
                      <button
                        type="button"
                        class="add-directive-modal-close"
                        onClick={closeAddModal}
                      >
                        <X class="w-4 h-4" />
                      </button>
                    </div>
                    <div class="add-directive-modal-body">
                      <div class="add-directive-field">
                        <label class="add-directive-label">Directive</label>
                        <textarea
                          class="add-directive-input"
                          placeholder="Describe a rule in plain English, e.g. 'Never use eval()'"
                          value={addDirectiveText()}
                          onInput={(e) => setAddDirectiveText(e.currentTarget.value)}
                          data-testid="add-directive-textarea"
                        />
                        <span class="add-directive-hint">Write naturally and it will be formatted automatically</span>
                      </div>

                      {/* Live Preview (Phase C) */}
                      <Show when={formatPreview()}>
                        {(preview) => (
                          <div class="add-directive-preview" data-testid="add-directive-preview">
                            <div class="add-directive-preview-label">Live Preview</div>
                            <div class="add-directive-preview-content">{preview().formatted}</div>
                            <div class="add-directive-preview-section">
                              Suggested section:{" "}
                              <span
                                class="directives-section-badge"
                                data-color={getSectionColor(addDirectiveSection() || preview().suggestedSection)}
                              >
                                {addDirectiveSection() || preview().suggestedSection}
                              </span>
                            </div>
                            <Show when={!preview().validation.valid}>
                              <div class="directives-validation-error" style={{ "margin-top": "8px" }}>
                                <XCircle class="w-3 h-3" />
                                {preview().validation.error}
                              </div>
                            </Show>
                          </div>
                        )}
                      </Show>

                      <div class="add-directive-field">
                        <label class="add-directive-label">Section</label>
                        <select
                          class="add-directive-select"
                          value={addDirectiveSection()}
                          onChange={(e) => setAddDirectiveSection(e.currentTarget.value)}
                          data-testid="add-directive-section-select"
                        >
                          <option value="">Auto-detect</option>
                          <For each={[...getSectionTitles(parsedSections()), ...getSuggestedSections()].filter((v, i, a) => a.indexOf(v) === i)}>
                            {(section) => <option value={section}>{section}</option>}
                          </For>
                        </select>
                      </div>
                    </div>
                    <div class="add-directive-modal-footer">
                      <button
                        type="button"
                        class="add-directive-btn add-directive-btn-secondary"
                        onClick={closeAddModal}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        class="add-directive-btn add-directive-btn-primary"
                        onClick={handleAddFromModal}
                        disabled={!formatPreview()?.validation.valid}
                        data-testid="add-directive-confirm-btn"
                      >
                        <Plus class="w-4 h-4" />
                        Add Directive
                      </button>
                    </div>
                  </div>
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
                  data-testid="save-btn"
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
