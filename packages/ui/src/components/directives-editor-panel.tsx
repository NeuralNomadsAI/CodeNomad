import { Component, Show, For, createSignal, createEffect, createMemo } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { X, FileText, Save, RefreshCw, AlertTriangle, Check, Globe, FolderCog, Undo2, Download, Eye, FileCode, Sparkles, GitCompare, ChevronDown, ChevronRight, Plus, Pencil, Trash2, Search, LayoutGrid, CheckCircle2, XCircle } from "lucide-solid"
import { cn } from "../lib/cn"
import { Button } from "./ui"
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
            <div class="flex items-center justify-between px-4 py-3 border-b border-border">
              <Dialog.Title class="text-sm font-semibold text-foreground">
                <FileText class="w-5 h-5" />
                <span>Directives Editor</span>
              </Dialog.Title>
              <Dialog.CloseButton class="settings-panel-close">
                <X class="w-4 h-4" />
              </Dialog.CloseButton>
            </div>

            <div class="settings-panel-content">
              {/* Type Selector */}
              <div class={cn("flex items-center rounded-lg overflow-hidden mb-4 bg-secondary border border-border")}>
                <button
                  type="button"
                  class={cn(
                    "flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors flex-1 justify-center",
                    activeType() === "project"
                      ? "bg-info text-white"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent",
                    "disabled:opacity-50 disabled:cursor-not-allowed"
                  )}
                  onClick={() => handleTypeChange("project")}
                  disabled={!props.folder}
                >
                  <FolderCog class="w-4 h-4" />
                  <span>Project</span>
                </button>
                <button
                  type="button"
                  class={cn(
                    "flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors flex-1 justify-center",
                    activeType() === "global"
                      ? "bg-info text-white"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  )}
                  onClick={() => handleTypeChange("global")}
                >
                  <Globe class="w-4 h-4" />
                  <span>Global</span>
                </button>
              </div>

              {/* File Path */}
              <Show when={filePath()}>
                <div class={cn("flex items-center gap-2 mb-4 text-xs")}>
                  <code class={cn("px-2 py-1 rounded font-mono bg-accent text-muted-foreground truncate")}>{filePath()}</code>
                  <Show when={!fileExists()}>
                    <span class={cn("text-warning font-medium")}>(New file)</span>
                  </Show>
                </div>
              </Show>

              {/* Error State */}
              <Show when={error()}>
                <div class={cn("flex items-center gap-2 p-4 rounded-md mb-4 bg-destructive/10 text-destructive")}>
                  <AlertTriangle class="w-5 h-5" />
                  <span>{error()}</span>
                </div>
              </Show>

              {/* Success State */}
              <Show when={success()}>
                <div class={cn("flex items-center gap-2 p-4 rounded-md mb-4 bg-success/10 text-success")}>
                  <Check class="w-5 h-5" />
                  <span>Directives saved successfully</span>
                </div>
              </Show>

              {/* Loading State */}
              <Show when={loading()}>
                <div class={cn("flex items-center justify-center gap-3 py-8 text-muted-foreground")}>
                  <div class={cn("w-5 h-5 border-2 border-t-transparent border-muted-foreground rounded-full animate-spin")} />
                  <span>Loading directives...</span>
                </div>
              </Show>

              {/* Toolbar */}
              <Show when={!loading()}>
                <div class={cn("flex items-center gap-1 flex-wrap mb-4 p-2 rounded-lg bg-secondary border border-border")}>
                  {/* View Mode Toggles */}
                  <div class={cn("flex items-center rounded-md overflow-hidden bg-accent")}>
                    <button
                      type="button"
                      class={cn(
                        "p-2 transition-colors",
                        viewMode() === "structured"
                          ? "bg-info text-white"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                      onClick={() => setViewMode("structured")}
                      title="Structured view"
                      data-testid="structured-view-btn"
                    >
                      <LayoutGrid class="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      class={cn(
                        "p-2 transition-colors",
                        viewMode() === "edit"
                          ? "bg-info text-white"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                      onClick={() => setViewMode("edit")}
                      title="Source mode"
                      data-testid="source-view-btn"
                    >
                      <FileCode class="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      class={cn(
                        "p-2 transition-colors",
                        viewMode() === "preview"
                          ? "bg-info text-white"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                      onClick={() => setViewMode("preview")}
                      title="Preview mode"
                    >
                      <Eye class="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      class={cn(
                        "p-2 transition-colors",
                        viewMode() === "diff"
                          ? "bg-info text-white"
                          : "text-muted-foreground hover:text-foreground",
                        "disabled:opacity-50 disabled:cursor-not-allowed"
                      )}
                      onClick={() => setViewMode("diff")}
                      disabled={!hasChanges()}
                      title="Diff view (show changes)"
                    >
                      <GitCompare class="w-4 h-4" />
                    </button>
                  </div>

                  <div class={cn("w-px h-6 mx-1 bg-border")} />

                  {/* Undo/Redo */}
                  <div class={cn("flex items-center")}>
                    <button
                      type="button"
                      class={cn(
                        "p-2 rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-accent",
                        "disabled:opacity-50 disabled:cursor-not-allowed"
                      )}
                      onClick={handleUndo}
                      disabled={!canUndo()}
                      title={`Undo (${undoHistory().length} available)`}
                    >
                      <Undo2 class="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      class={cn(
                        "p-2 rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-accent",
                        "disabled:opacity-50 disabled:cursor-not-allowed"
                      )}
                      onClick={handleRedo}
                      disabled={!canRedo()}
                      title={`Redo (${redoHistory().length} available)`}
                    >
                      <Undo2 class="w-4 h-4" style={{ transform: "scaleX(-1)" }} />
                    </button>
                    <button
                      type="button"
                      class={cn(
                        "p-2 rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-accent",
                        "disabled:opacity-50 disabled:cursor-not-allowed"
                      )}
                      onClick={handleRevert}
                      disabled={!hasChanges()}
                      title="Revert to last saved version"
                    >
                      <RefreshCw class="w-4 h-4" />
                    </button>
                  </div>

                  <div class={cn("w-px h-6 mx-1 bg-border")} />

                  {/* Templates & Export */}
                  <div class={cn("flex items-center")}>
                    <button
                      type="button"
                      class={cn(
                        "p-2 rounded transition-colors",
                        showTemplates()
                          ? "bg-info text-white"
                          : "text-muted-foreground hover:text-foreground hover:bg-accent"
                      )}
                      onClick={() => setShowTemplates(!showTemplates())}
                      title="Templates"
                    >
                      <Sparkles class="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      class={cn(
                        "p-2 rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-accent",
                        "disabled:opacity-50 disabled:cursor-not-allowed"
                      )}
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
                <div class={cn("text-xs text-muted-foreground mb-3 px-1")} data-testid="directives-summary">
                  <span>{totalDirectiveCount()} directives in {totalSectionCount()} sections</span>
                </div>
              </Show>

              {/* Templates Panel */}
              <Show when={showTemplates() && !loading()}>
                <div class={cn("rounded-lg border border-border overflow-hidden mb-4")}>
                  <div class={cn("flex items-center justify-between px-4 py-3 bg-secondary")}>
                    <span class={cn("text-sm font-medium text-foreground")}>Choose a template to get started</span>
                    <button
                      type="button"
                      class={cn("p-1 rounded transition-colors text-muted-foreground hover:text-foreground")}
                      onClick={() => setShowTemplates(false)}
                    >
                      <X class="w-4 h-4" />
                    </button>
                  </div>
                  <div class={cn("grid grid-cols-2 gap-3 p-4")}>
                    <For each={DIRECTIVE_TEMPLATES}>
                      {(template) => (
                        <button
                          type="button"
                          class={cn(
                            "flex flex-col gap-1 p-3 rounded-lg text-left transition-colors",
                            "bg-accent border border-border",
                            "hover:border-info hover:bg-info/5"
                          )}
                          onClick={() => applyTemplate(template)}
                        >
                          <div class={cn("text-sm font-medium text-foreground")}>{template.name}</div>
                          <div class={cn("text-xs text-muted-foreground")}>{template.description}</div>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              {/* Structured View (Phase B) */}
              <Show when={!loading() && viewMode() === "structured" && !isEmptyState()}>
                <div data-testid="structured-view">
                  {/* Search & Expand/Collapse Toolbar */}
                  <div class={cn("flex items-center gap-3 flex-wrap mb-4")}>
                    <div class={cn("flex items-center gap-2 px-3 py-1.5 rounded-lg flex-1 max-w-xs bg-secondary border border-border")}>
                      <Search class="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      <input
                        type="text"
                        placeholder="Search directives..."
                        class={cn("flex-1 bg-transparent text-sm outline-none text-foreground placeholder:text-muted-foreground")}
                        value={searchQuery()}
                        onInput={(e) => setSearchQuery(e.currentTarget.value)}
                        data-testid="directives-search-input"
                      />
                      <Show when={searchQuery()}>
                        <button
                          type="button"
                          class={cn("p-1 rounded transition-colors text-muted-foreground hover:text-foreground")}
                          onClick={() => setSearchQuery("")}
                        >
                          <X class="w-3 h-3" />
                        </button>
                      </Show>
                    </div>
                    <div class={cn("flex items-center gap-2")}>
                      <button
                        type="button"
                        class={cn("px-2 py-1 text-xs rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-secondary")}
                        onClick={expandAll}
                        title="Expand all sections"
                      >
                        Expand All
                      </button>
                      <button
                        type="button"
                        class={cn("px-2 py-1 text-xs rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-secondary")}
                        onClick={collapseAll}
                        title="Collapse all sections"
                      >
                        Collapse All
                      </button>
                    </div>
                  </div>

                  {/* Quick-Add Input (Phase C) */}
                  <div class={cn("mb-4 rounded-lg border border-border overflow-hidden")} data-testid="quick-add-input">
                    <textarea
                      class={cn(
                        "w-full p-3 text-sm resize-none bg-secondary text-foreground",
                        "placeholder:text-muted-foreground",
                        "focus:outline-none focus:border-info border-b border-border"
                      )}
                      placeholder="Describe a rule in plain English, e.g. 'Never use eval()'"
                      value={addDirectiveText()}
                      onInput={(e) => setAddDirectiveText(e.currentTarget.value)}
                      rows={2}
                    />
                    <Show when={addDirectiveText().trim()}>
                      <div class={cn("p-3 bg-accent flex flex-col gap-2")} data-testid="quick-add-preview">
                        <Show when={formatPreview()}>
                          {(preview) => (
                            <>
                              <div class={cn("flex items-center gap-2 text-xs")}>
                                <span class={cn("text-muted-foreground font-medium")}>Formatted</span>
                                <span class={cn("text-foreground")}>{preview().formatted}</span>
                              </div>
                              <div class={cn("flex items-center gap-2 text-xs")}>
                                <span class={cn("text-muted-foreground font-medium")}>Section</span>
                                <span
                                  class={cn("px-2 py-0.5 rounded-full text-xs font-medium bg-info/10 text-info")}
                                  data-color={getSectionColor(addDirectiveSection() || preview().suggestedSection)}
                                  data-testid="suggested-section-badge"
                                >
                                  {addDirectiveSection() || preview().suggestedSection}
                                </span>
                                <select
                                  class={cn("px-2 py-0.5 rounded text-xs bg-secondary border border-border text-foreground")}
                                  value={addDirectiveSection()}
                                  onChange={(e) => setAddDirectiveSection(e.currentTarget.value)}
                                >
                                  <option value="">Auto</option>
                                  <For each={[...getSectionTitles(parsedSections()), ...getSuggestedSections()].filter((v, i, a) => a.indexOf(v) === i)}>
                                    {(section) => <option value={section}>{section}</option>}
                                  </For>
                                </select>
                              </div>
                              <div class={cn("flex items-center gap-2 text-xs")}>
                                <Show when={preview().validation.valid}>
                                  <span class={cn("flex items-center gap-1 text-success")}>
                                    <CheckCircle2 class="w-3 h-3" />
                                    Valid
                                  </span>
                                </Show>
                                <Show when={!preview().validation.valid}>
                                  <span class={cn("flex items-center gap-1 text-destructive")}>
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
                          class={cn(
                            "flex items-center gap-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors self-end",
                            "bg-info text-white hover:bg-info/90",
                            "disabled:opacity-50 disabled:cursor-not-allowed"
                          )}
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
                    <div class={cn("text-xs text-muted-foreground mb-3")}>
                      {filteredSections().reduce((c, s) => c + s.directives.length, 0)} results in {filteredSections().length} sections
                    </div>
                  </Show>

                  {/* Section Cards */}
                  <div class={cn("flex flex-col gap-3")} data-testid="sections-list">
                    <For each={filteredSections()}>
                      {(section) => {
                        const color = () => getSectionColor(section.title)
                        const isExpanded = () => expandedSections().includes(section.title)

                        return (
                          <div class={cn("rounded-lg border border-border overflow-hidden")} data-testid={`section-${section.title.toLowerCase().replace(/\s+/g, "-")}`}>
                            <button
                              type="button"
                              class={cn(
                                "flex items-center justify-between w-full px-4 py-3 text-left transition-colors",
                                "bg-background border-b border-border hover:bg-accent"
                              )}
                              onClick={() => toggleSection(section.title)}
                            >
                              <div class={cn("flex items-center gap-2")}>
                                <span class={cn("text-muted-foreground")}>
                                  <Show when={isExpanded()} fallback={<ChevronRight class="w-4 h-4" />}>
                                    <ChevronDown class="w-4 h-4" />
                                  </Show>
                                </span>
                                <div
                                  class={cn("w-1 h-5 rounded-full")}
                                  data-color={color()}
                                />
                                <span class={cn("font-semibold text-sm text-foreground")}>{section.title}</span>
                                <span class={cn("text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground")}>{section.directives.length}</span>
                              </div>
                              <button
                                type="button"
                                class={cn("p-1.5 rounded transition-colors text-muted-foreground hover:text-info hover:bg-secondary")}
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
                              <div class={cn("p-4 flex flex-col gap-3")}>
                                <For each={section.directives}>
                                  {(directive) => (
                                    <Show
                                      when={editingDirectiveId() === directive.id}
                                      fallback={
                                        <div
                                          class={cn("p-3 rounded-lg bg-background border border-border")}
                                          data-color={color()}
                                          data-testid={`directive-card-${directive.id}`}
                                        >
                                          <div class={cn("flex items-start justify-between gap-2")}>
                                            <span class={cn("text-sm text-foreground flex-1")}>{directive.text}</span>
                                            <div class={cn("flex items-center gap-1 flex-shrink-0")}>
                                              <button
                                                type="button"
                                                class={cn("p-1 rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-accent")}
                                                onClick={() => startEditing(directive.id, directive.text)}
                                                title="Edit directive"
                                                data-testid={`edit-btn-${directive.id}`}
                                              >
                                                <Pencil class="w-3.5 h-3.5" />
                                              </button>
                                              <button
                                                type="button"
                                                class={cn("p-1 rounded transition-colors text-muted-foreground hover:text-destructive hover:bg-destructive/10")}
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
                                      <div class={cn("p-3 rounded-lg bg-background border-2 border-info")} data-color={color()}>
                                        <textarea
                                          class={cn(
                                            "w-full p-2 rounded text-sm resize-none min-h-[60px]",
                                            "bg-secondary border border-border text-foreground",
                                            "focus:outline-none focus:border-info"
                                          )}
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
                                        <div class={cn("flex items-center justify-end gap-2 mt-2")}>
                                          <button
                                            type="button"
                                            class={cn("px-3 py-1 rounded text-xs font-medium transition-colors text-muted-foreground hover:text-foreground hover:bg-accent")}
                                            onClick={cancelEditing}
                                          >
                                            Cancel
                                          </button>
                                          <button
                                            type="button"
                                            class={cn("px-3 py-1 rounded text-xs font-medium transition-colors bg-info text-white hover:bg-info/90")}
                                            onClick={() => handleStructuredEdit(directive.id, editingText())}
                                            data-testid={`save-edit-btn-${directive.id}`}
                                          >
                                            Save
                                          </button>
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
                <div class={cn("flex flex-col items-center gap-6 py-8")} data-testid="directives-wizard">
                  <Show when={wizardStep() === 1}>
                    <div class={cn("text-center max-w-md")} data-testid="wizard-step-1">
                      <h3 class={cn("text-lg font-semibold text-foreground mb-2")}>Get Started with Directives</h3>
                      <p class={cn("text-sm text-muted-foreground mb-6")}>
                        Choose a template to pre-populate your directives, or start from scratch.
                      </p>
                      <div class={cn("grid grid-cols-2 gap-3 mb-6")}>
                        <For each={DIRECTIVE_TEMPLATES}>
                          {(template) => (
                            <button
                              type="button"
                              class={cn(
                                "flex flex-col gap-1 p-4 rounded-lg text-left transition-colors",
                                "bg-secondary border border-border",
                                "hover:border-info hover:bg-info/5"
                              )}
                              onClick={() => handleWizardSelectTemplate(template.id)}
                              data-testid={`wizard-template-${template.id}`}
                            >
                              <div class={cn("text-sm font-medium text-foreground")}>{template.name}</div>
                              <div class={cn("text-xs text-muted-foreground")}>{template.description}</div>
                            </button>
                          )}
                        </For>
                      </div>
                      <button
                        type="button"
                        class={cn("text-sm text-muted-foreground hover:text-foreground transition-colors underline")}
                        onClick={skipWizard}
                        data-testid="wizard-skip-btn"
                      >
                        Start from scratch
                      </button>
                    </div>
                  </Show>

                  <Show when={wizardStep() === 2}>
                    <div class={cn("w-full max-w-md")} data-testid="wizard-step-2">
                      <h3 class={cn("text-lg font-semibold text-foreground mb-2")}>Customize Sections</h3>
                      <p class={cn("text-sm text-muted-foreground mb-4")}>
                        Toggle which sections to include from the template.
                      </p>
                      <div class={cn("flex flex-col gap-2 mb-4")}>
                        <For each={getWizardTemplateSections()}>
                          {(section) => (
                            <label
                              class={cn("flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors bg-secondary border border-border hover:bg-accent")}
                              data-testid={`wizard-toggle-${section.title.toLowerCase().replace(/\s+/g, "-")}`}
                            >
                              <input
                                type="checkbox"
                                checked={selectedSections().includes(section.title)}
                                onChange={() => toggleWizardSection(section.title)}
                                class={cn("rounded")}
                              />
                              <div
                                class={cn("w-1 h-5 rounded-full")}
                                data-color={getSectionColor(section.title)}
                              />
                              <span class={cn("text-sm font-medium text-foreground")}>{section.title}</span>
                              <span class={cn("text-xs text-muted-foreground ml-auto")}>({section.directives.length} directives)</span>
                            </label>
                          )}
                        </For>
                      </div>

                      <div class={cn("rounded-lg border border-border overflow-hidden mb-4")} data-testid="wizard-preview">
                        <div class={cn("px-3 py-2 text-xs font-medium text-muted-foreground bg-secondary")}>Preview</div>
                        <pre class={cn("p-3 text-xs font-mono whitespace-pre-wrap break-all bg-accent text-muted-foreground overflow-auto max-h-[200px]")}>{wizardPreview()}</pre>
                      </div>

                      <div class={cn("flex items-center justify-between gap-3")}>
                        <button
                          type="button"
                          class={cn("px-4 py-2 rounded-lg text-sm font-medium transition-colors text-muted-foreground hover:text-foreground hover:bg-secondary")}
                          onClick={() => { setWizardStep(1); setSelectedTemplate(null) }}
                        >
                          Back
                        </button>
                        <Button
                          variant="default"
                          size="sm"
                          onClick={applyWizardTemplate}
                          disabled={selectedSections().length === 0}
                          data-testid="wizard-apply-btn"
                        >
                          Apply Template
                        </Button>
                      </div>
                    </div>
                  </Show>
                </div>
              </Show>

              {/* Source Mode (renamed from Edit) */}
              <Show when={!loading() && viewMode() === "edit"}>
                <div>
                  <textarea
                    class={cn(
                      "w-full rounded-lg p-4 text-sm resize-none min-h-[400px]",
                      "bg-secondary border border-border text-foreground",
                      "font-mono leading-relaxed",
                      "placeholder:text-muted-foreground",
                      "focus:outline-none focus:border-info"
                    )}
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
                <div class={cn("rounded-lg border border-border overflow-hidden")}>
                  <Show when={content().trim()}>
                    <div class={cn("p-4 prose prose-sm max-w-none text-foreground")}>
                      <Markdown part={{ type: "text", text: content() }} />
                    </div>
                  </Show>
                  <Show when={!content().trim()}>
                    <div class={cn("flex items-center justify-center py-12 text-sm text-muted-foreground")}>
                      No content to preview. Switch to edit mode to add directives.
                    </div>
                  </Show>
                </div>
              </Show>

              {/* Diff Mode */}
              <Show when={!loading() && viewMode() === "diff"}>
                <div class={cn("rounded-lg border border-border overflow-hidden")}>
                  <Show when={hasChanges()}>
                    <div class={cn("font-mono text-xs overflow-auto max-h-[500px]")}>
                      <For each={diffLines()}>
                        {(line) => (
                          <div class={cn(
                            "flex px-3 py-0.5",
                            line.type === "added" && "bg-success/10 text-success",
                            line.type === "removed" && "bg-destructive/10 text-destructive",
                            line.type === "unchanged" && "text-muted-foreground"
                          )}>
                            <span class={cn("w-6 text-right mr-3 select-none opacity-50")}>
                              {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
                            </span>
                            <span class={cn("flex-1 whitespace-pre-wrap break-all")}>{line.content || "\u00A0"}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={!hasChanges()}>
                    <div class={cn("flex items-center justify-center py-12 text-sm text-muted-foreground")}>
                      No changes to display.
                    </div>
                  </Show>
                </div>
              </Show>

              {/* Add Directive Modal (Phase B + C enhancements) */}
              <Show when={showAddModal()}>
                <div class={cn("fixed inset-0 flex items-center justify-center p-4 bg-black/60 z-[100]")} onClick={(e) => { if (e.target === e.currentTarget) closeAddModal() }}>
                  <div class={cn("w-full max-w-lg rounded-xl overflow-hidden bg-background border border-border shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)]")} data-testid="add-directive-modal">
                    <div class={cn("flex items-center justify-between px-6 py-4 border-b border-border")}>
                      <h3 class={cn("text-lg font-semibold text-foreground")}>Add Directive</h3>
                      <button
                        type="button"
                        class={cn("p-1 rounded transition-colors text-muted-foreground hover:text-foreground")}
                        onClick={closeAddModal}
                      >
                        <X class="w-4 h-4" />
                      </button>
                    </div>
                    <div class={cn("p-6 space-y-4")}>
                      <div class={cn("space-y-2")}>
                        <label class={cn("block text-sm font-medium text-foreground")}>Directive</label>
                        <textarea
                          class={cn(
                            "w-full p-3 rounded-lg text-sm resize-none min-h-[80px]",
                            "bg-secondary border border-border text-foreground",
                            "placeholder:text-muted-foreground",
                            "focus:outline-none focus:border-info"
                          )}
                          placeholder="Describe a rule in plain English, e.g. 'Never use eval()'"
                          value={addDirectiveText()}
                          onInput={(e) => setAddDirectiveText(e.currentTarget.value)}
                          data-testid="add-directive-textarea"
                        />
                        <span class={cn("text-xs text-muted-foreground")}>Write naturally and it will be formatted automatically</span>
                      </div>

                      {/* Live Preview (Phase C) */}
                      <Show when={formatPreview()}>
                        {(preview) => (
                          <div class={cn("p-4 rounded-lg bg-secondary border border-border")} data-testid="add-directive-preview">
                            <div class={cn("text-xs font-medium uppercase tracking-wide mb-2 text-muted-foreground")}>Live Preview</div>
                            <div class={cn("text-sm text-foreground mb-2")}>{preview().formatted}</div>
                            <div class={cn("text-xs text-muted-foreground")}>
                              Suggested section:{" "}
                              <span
                                class={cn("px-2 py-0.5 rounded-full text-xs font-medium bg-info/10 text-info")}
                                data-color={getSectionColor(addDirectiveSection() || preview().suggestedSection)}
                              >
                                {addDirectiveSection() || preview().suggestedSection}
                              </span>
                            </div>
                            <Show when={!preview().validation.valid}>
                              <div class={cn("flex items-center gap-1 mt-2 text-xs text-destructive")}>
                                <XCircle class="w-3 h-3" />
                                {preview().validation.error}
                              </div>
                            </Show>
                          </div>
                        )}
                      </Show>

                      <div class={cn("space-y-2")}>
                        <label class={cn("block text-sm font-medium text-foreground")}>Section</label>
                        <select
                          class={cn(
                            "w-full p-2 rounded-lg text-sm",
                            "bg-secondary border border-border text-foreground",
                            "focus:outline-none focus:border-info"
                          )}
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
                    <div class={cn("flex items-center justify-end gap-3 px-6 py-4 border-t border-border bg-secondary")}>
                      <Button variant="outline" size="sm" onClick={closeAddModal}>
                        Cancel
                      </Button>
                      <Button
                        variant="default"
                        size="sm"
                        onClick={handleAddFromModal}
                        disabled={!formatPreview()?.validation.valid}
                        data-testid="add-directive-confirm-btn"
                      >
                        <Plus class="w-4 h-4" />
                        Add Directive
                      </Button>
                    </div>
                  </div>
                </div>
              </Show>

              {/* Actions */}
              <div class={cn("flex items-center justify-end gap-3 mt-4 pt-4 border-t border-border")}>
                <Show when={hasChanges()}>
                  <span class={cn("text-xs text-warning mr-auto")}>Unsaved changes</span>
                </Show>
                <button
                  type="button"
                  class={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                    "bg-secondary border border-border text-foreground",
                    "hover:bg-accent",
                    "disabled:opacity-50 disabled:cursor-not-allowed"
                  )}
                  onClick={() => loadDirectives(activeType())}
                  disabled={loading() || saving()}
                >
                  <RefreshCw class={cn("w-4 h-4", loading() && "animate-spin")} />
                  <span>Reload</span>
                </button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={saveDirectives}
                  disabled={loading() || saving() || !hasChanges()}
                  data-testid="save-btn"
                >
                  <Save class="w-4 h-4" />
                  <span>{saving() ? "Saving..." : "Save"}</span>
                </Button>
              </div>

              {/* Help Text */}
              <div class={cn("mt-4 p-3 rounded-lg text-xs leading-relaxed bg-secondary text-muted-foreground")}>
                <p class={cn("mb-1")}>
                  <strong class={cn("text-foreground")}>Project Directives</strong> define coding standards and workflows specific to this project.
                </p>
                <p>
                  <strong class={cn("text-foreground")}>Global Directives</strong> apply across all projects and can be overridden by project-level directives.
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
