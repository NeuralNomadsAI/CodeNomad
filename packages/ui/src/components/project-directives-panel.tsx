import { Component, createSignal, createMemo, createEffect, onMount, Show, For } from "solid-js"
import { Folder, RefreshCw, AlertTriangle, Plus, Save, Check, FolderOpen, ChevronDown } from "lucide-solid"
import DirectiveCardList from "./directive-card-list"
import AddDirectiveModal from "./add-directive-modal"
import type { ViewMode } from "./directive-card-list"
import {
  parseDirectivesMarkdown,
  directivesToMarkdown,
  addDirective,
  type DirectiveSection,
} from "../lib/directive-parser"
import {
  fetchDirectives,
  projectDirectives,
  isDirectivesLoading,
  saveDirectives,
} from "../stores/era-directives"
import { isEraInstalled } from "../stores/era-status"
import { showToastNotification } from "../lib/notifications"
import { instances } from "../stores/instances"

interface ProjectDirectivesPanelProps {
  folder?: string
}

/**
 * Extract project name from folder path
 */
function getProjectName(folder: string): string {
  const parts = folder.split("/")
  return parts[parts.length - 1] || folder
}

const ProjectDirectivesPanel: Component<ProjectDirectivesPanelProps> = (props) => {
  const [viewMode, setViewMode] = createSignal<ViewMode>("cards")
  const [isAddModalOpen, setIsAddModalOpen] = createSignal(false)
  const [addToSection, setAddToSection] = createSignal<string | undefined>()
  const [isSaving, setIsSaving] = createSignal(false)
  const [saveStatus, setSaveStatus] = createSignal<{ type: "success" | "error"; message: string } | null>(null)
  const [localContent, setLocalContent] = createSignal<string | null>(null)
  const [hasChanges, setHasChanges] = createSignal(false)
  const [selectedFolder, setSelectedFolder] = createSignal<string | undefined>(props.folder)

  // Get all open project folders
  const openProjects = createMemo(() => {
    const instanceList = Array.from(instances().values())
    return instanceList
      .filter(inst => inst.folder && inst.status === "ready")
      .map(inst => ({
        id: inst.id,
        folder: inst.folder,
        name: getProjectName(inst.folder),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  // Effective folder to use (selected or from props)
  const effectiveFolder = createMemo(() => selectedFolder() ?? props.folder)

  // Update selected folder when props.folder changes
  createEffect(() => {
    if (props.folder && !selectedFolder()) {
      setSelectedFolder(props.folder)
    }
  })

  // Track previously fetched folder to avoid duplicate fetches
  let lastFetchedFolder: string | null = null

  // Single effect for fetching directives when folder changes
  createEffect(() => {
    const folder = effectiveFolder()
    if (folder && folder !== lastFetchedFolder) {
      lastFetchedFolder = folder
      fetchDirectives(folder)
      setLocalContent(null)
      setHasChanges(false)
    }
  })

  // Reset local content when project directives change from server
  createEffect(() => {
    const serverContent = projectDirectives()?.content
    if (serverContent !== undefined && localContent() === null) {
      setLocalContent(serverContent || "")
    }
  })

  const currentContent = () => localContent() ?? projectDirectives()?.content ?? ""

  const parsedSections = createMemo(() => {
    return parseDirectivesMarkdown(currentContent())
  })

  const handleSectionsChange = (sections: DirectiveSection[]) => {
    const newContent = directivesToMarkdown(sections)
    setLocalContent(newContent)
    setHasChanges(true)
    setSaveStatus(null)
  }

  const handleRawChange = (content: string) => {
    setLocalContent(content)
    setHasChanges(true)
    setSaveStatus(null)
  }

  const handleSave = async () => {
    const folder = effectiveFolder()
    if (!folder) return

    setIsSaving(true)
    setSaveStatus(null)

    try {
      const result = await saveDirectives(folder, "project", currentContent())
      if (result.success) {
        setSaveStatus({ type: "success", message: "Saved successfully" })
        setHasChanges(false)
        // Refresh to get the latest from server
        await fetchDirectives(folder)
        setLocalContent(null)
        showToastNotification({
          variant: "success",
          title: "Saved",
          message: "Project directives saved successfully",
          duration: 3000,
        })
        setTimeout(() => setSaveStatus(null), 3000)
      } else {
        setSaveStatus({ type: "error", message: result.error || "Failed to save" })
        showToastNotification({
          variant: "error",
          title: "Save Failed",
          message: result.error || "Failed to save project directives",
          duration: 5000,
        })
      }
    } catch {
      setSaveStatus({ type: "error", message: "Failed to save" })
      showToastNotification({
        variant: "error",
        title: "Save Failed",
        message: "An unexpected error occurred while saving",
        duration: 5000,
      })
    } finally {
      setIsSaving(false)
    }
  }

  const handleAddDirective = (text: string, section?: string) => {
    const sections = parsedSections()
    const newSections = addDirective(sections, text, section)
    handleSectionsChange(newSections)
    setIsAddModalOpen(false)
    setAddToSection(undefined)
  }

  const openAddModal = (sectionTitle?: string) => {
    setAddToSection(sectionTitle)
    setIsAddModalOpen(true)
  }

  const existingSections = createMemo(() => parsedSections().map(s => s.title))

  const currentFolder = effectiveFolder()
  const currentProjectName = currentFolder ? getProjectName(currentFolder) : null

  return (
    <div class="directives-panel">
      {/* Header */}
      <div class="directives-panel-header">
        <div>
          <h2 class="flex items-center gap-2">
            <Folder class="w-5 h-5 text-green-400" />
            Project Directives
          </h2>
          <p>Conventions and rules specific to this codebase</p>
        </div>
        <Show when={currentFolder}>
          <div class="directives-panel-actions">
            <Show when={hasChanges()}>
              <button
                type="button"
                class="directives-add-btn"
                onClick={handleSave}
                disabled={isSaving()}
              >
                {isSaving() ? (
                  <RefreshCw class="w-4 h-4 animate-spin" />
                ) : (
                  <Save class="w-4 h-4" />
                )}
                Save Changes
              </button>
            </Show>
            <Show when={saveStatus()}>
              <span class={`directives-save-status ${saveStatus()?.type}`}>
                <Show when={saveStatus()?.type === "success"}>
                  <Check class="w-4 h-4" />
                </Show>
                <Show when={saveStatus()?.type === "error"}>
                  <AlertTriangle class="w-4 h-4" />
                </Show>
                {saveStatus()?.message}
              </span>
            </Show>
            <button
              type="button"
              class="directives-add-btn"
              onClick={() => openAddModal()}
            >
              <Plus class="w-4 h-4" />
              Add Directive
            </button>
          </div>
        </Show>
      </div>

      {/* Project Selector */}
      <Show when={openProjects().length > 0}>
        <div class="project-selector">
          <label class="project-selector-label">Project:</label>
          <Show when={openProjects().length === 1}>
            <div class="project-selector-single">
              <Folder class="w-4 h-4 text-green-400" />
              <span class="project-selector-name">{currentProjectName}</span>
              <span class="project-selector-path" title={currentFolder}>{currentFolder}</span>
            </div>
          </Show>
          <Show when={openProjects().length > 1}>
            <div class="project-selector-dropdown">
              <select
                class="project-selector-select"
                value={currentFolder}
                onChange={(e) => {
                  const newFolder = e.currentTarget.value
                  setSelectedFolder(newFolder)
                  setLocalContent(null)
                  setHasChanges(false)
                }}
              >
                <For each={openProjects()}>
                  {(project) => (
                    <option value={project.folder}>{project.name}</option>
                  )}
                </For>
              </select>
              <ChevronDown class="w-4 h-4 project-selector-chevron" />
            </div>
            <span class="project-selector-path" title={currentFolder}>{currentFolder}</span>
          </Show>
        </div>
      </Show>

      {/* No project open */}
      <Show when={!currentFolder && openProjects().length === 0}>
        <div class="directives-empty">
          <FolderOpen class="directives-empty-icon w-12 h-12" />
          <p class="directives-empty-title">No Project Open</p>
          <p class="directives-empty-description">
            Open a project to manage its directives. Project directives define
            coding conventions and rules specific to each codebase.
          </p>
        </div>
      </Show>

      <Show when={currentFolder}>
        <Show when={!isEraInstalled()}>
          <div class="governance-notice governance-notice-warning">
            <AlertTriangle class="w-5 h-5" />
            <div>
              <strong>Era Code Not Installed</strong>
              <p>Install Era Code to manage project directives.</p>
            </div>
          </div>
        </Show>

        <Show when={isDirectivesLoading()}>
          <div class="directives-loading">
            <RefreshCw class="w-5 h-5 animate-spin" />
            <span>Loading directives...</span>
          </div>
        </Show>

        <Show when={!isDirectivesLoading() && isEraInstalled()}>
          <DirectiveCardList
            sections={parsedSections()}
            rawContent={currentContent()}
            readOnly={false}
            showViewToggle={true}
            viewMode={viewMode()}
            onViewModeChange={setViewMode}
            onChange={handleSectionsChange}
            onRawChange={handleRawChange}
            onAddToSection={openAddModal}
          />
        </Show>
      </Show>

      {/* Add Directive Modal */}
      <Show when={isAddModalOpen()}>
        <AddDirectiveModal
          open={isAddModalOpen()}
          onClose={() => {
            setIsAddModalOpen(false)
            setAddToSection(undefined)
          }}
          type="project"
          existingSections={existingSections()}
          defaultSection={addToSection()}
          onAdd={handleAddDirective}
        />
      </Show>
    </div>
  )
}

export default ProjectDirectivesPanel
