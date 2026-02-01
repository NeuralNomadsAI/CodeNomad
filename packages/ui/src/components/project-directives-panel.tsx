import { Component, createSignal, createMemo, createEffect, onMount, Show, For } from "solid-js"
import { Folder, RefreshCw, AlertTriangle, Plus, Save, Check, FolderOpen, ChevronDown } from "lucide-solid"
import { cn } from "../lib/cn"
import { Button } from "./ui"
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
    <div class={cn("flex flex-col gap-6")}>
      {/* Header */}
      <div class={cn("flex items-center justify-between gap-4 flex-wrap")}>
        <div>
          <h2 class={cn("flex items-center gap-2 text-lg font-semibold text-foreground")}>
            <Folder class="w-5 h-5 text-success" />
            Project Directives
          </h2>
          <p class={cn("text-sm mt-1 text-muted-foreground")}>Conventions and rules specific to this codebase</p>
        </div>
        <Show when={currentFolder}>
          <div class={cn("flex items-center gap-3")}>
            <Show when={hasChanges()}>
              <Button
                variant="default"
                size="sm"
                onClick={handleSave}
                disabled={isSaving()}
              >
                {isSaving() ? (
                  <RefreshCw class="w-4 h-4 animate-spin" />
                ) : (
                  <Save class="w-4 h-4" />
                )}
                Save Changes
              </Button>
            </Show>
            <Show when={saveStatus()}>
              <span class={cn(
                "flex items-center gap-2 text-sm",
                saveStatus()?.type === "success" ? "text-success" : "text-destructive"
              )}>
                <Show when={saveStatus()?.type === "success"}>
                  <Check class="w-4 h-4" />
                </Show>
                <Show when={saveStatus()?.type === "error"}>
                  <AlertTriangle class="w-4 h-4" />
                </Show>
                {saveStatus()?.message}
              </span>
            </Show>
            <Button
              variant="default"
              size="sm"
              onClick={() => openAddModal()}
            >
              <Plus class="w-4 h-4" />
              Add Directive
            </Button>
          </div>
        </Show>
      </div>

      {/* Project Selector */}
      <Show when={openProjects().length > 0}>
        <div class={cn("flex flex-wrap items-center gap-2 p-3 rounded-lg mb-4 bg-secondary border border-border")}>
          <label class={cn("text-sm font-medium text-muted-foreground")}>Project:</label>
          <Show when={openProjects().length === 1}>
            <div class={cn("flex items-center gap-2")}>
              <Folder class="w-4 h-4 text-success" />
              <span class={cn("text-sm font-semibold text-foreground")}>{currentProjectName}</span>
              <span class={cn("text-xs truncate max-w-md font-mono text-muted-foreground")} title={currentFolder}>{currentFolder}</span>
            </div>
          </Show>
          <Show when={openProjects().length > 1}>
            <div class={cn("relative flex items-center")}>
              <select
                class={cn(
                  "pl-3 pr-8 py-1.5 rounded-md text-sm font-medium appearance-none cursor-pointer min-w-[150px]",
                  "bg-background border border-border text-foreground",
                  "hover:border-info",
                  "focus:outline-none focus:border-info focus:shadow-[0_0_0_2px_rgba(59,130,246,0.2)]"
                )}
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
              <ChevronDown class={cn("w-4 h-4 absolute right-2 pointer-events-none text-muted-foreground")} />
            </div>
            <span class={cn("text-xs truncate max-w-md font-mono text-muted-foreground")} title={currentFolder}>{currentFolder}</span>
          </Show>
        </div>
      </Show>

      {/* No project open */}
      <Show when={!currentFolder && openProjects().length === 0}>
        <div class={cn("flex flex-col items-center justify-center py-12 text-center text-muted-foreground")}>
          <FolderOpen class={cn("w-12 h-12 mb-4 opacity-30")} />
          <p class={cn("text-sm font-medium mb-1 text-foreground")}>No Project Open</p>
          <p class={cn("text-xs max-w-sm mb-4 text-muted-foreground")}>
            Open a project to manage its directives. Project directives define
            coding conventions and rules specific to each codebase.
          </p>
        </div>
      </Show>

      <Show when={currentFolder}>
        <Show when={!isEraInstalled()}>
          <div class={cn("flex items-center gap-2 p-4 rounded-md bg-warning/10 text-warning")}>
            <AlertTriangle class="w-5 h-5" />
            <div>
              <strong>Era Code Not Installed</strong>
              <p>Install Era Code to manage project directives.</p>
            </div>
          </div>
        </Show>

        <Show when={isDirectivesLoading()}>
          <div class={cn("flex items-center justify-center gap-2 py-8 text-muted-foreground")}>
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
