import { Component, createSignal, For, Show } from "solid-js"
import { Folder, FileCode, Sparkles, FolderOpen, Loader2 } from "lucide-solid"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog"
import { serverApi } from "../lib/api-client"
import { openNativeFolderDialog, supportsNativeDialogsAsync } from "../lib/native/native-functions"
import { cn } from "../lib/cn"

interface NewProjectWizardProps {
  open: boolean
  onClose: () => void
  onProjectCreated: (projectPath: string) => void
}

type TemplateId = "blank" | "typescript-node" | "python" | "react-vite"

interface TemplateOption {
  id: TemplateId
  label: string
  description: string
  icon: typeof Folder
}

const TEMPLATE_OPTIONS: TemplateOption[] = [
  { id: "blank", label: "Blank Project", description: "Empty project with optional README", icon: Folder },
  { id: "typescript-node", label: "TypeScript / Node.js", description: "Node.js with TypeScript setup", icon: FileCode },
  { id: "python", label: "Python", description: "Python project with main.py", icon: FileCode },
  { id: "react-vite", label: "React + Vite", description: "React app with Vite and TypeScript", icon: Sparkles },
]

const NewProjectWizard: Component<NewProjectWizardProps> = (props) => {
  const [projectName, setProjectName] = createSignal("")
  const [location, setLocation] = createSignal("~/Projects")
  const [template, setTemplate] = createSignal<TemplateId>("blank")
  const [gitInit, setGitInit] = createSignal(true)
  const [createReadme, setCreateReadme] = createSignal(true)
  const [isCreating, setIsCreating] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [nameError, setNameError] = createSignal<string | null>(null)

  const NAME_REGEX = /^[a-zA-Z0-9._-]+$/

  function validateName(name: string): string | null {
    if (!name.trim()) return "Project name is required"
    if (!NAME_REGEX.test(name)) return "Use only letters, numbers, dots, hyphens, and underscores"
    return null
  }

  function isFormValid(): boolean {
    return projectName().trim().length > 0 && !validateName(projectName()) && !isCreating()
  }

  function resetForm() {
    setProjectName("")
    setLocation("~/Projects")
    setTemplate("blank")
    setGitInit(true)
    setCreateReadme(true)
    setError(null)
    setNameError(null)
  }

  function handleClose() {
    if (!isCreating()) {
      resetForm()
      props.onClose()
    }
  }

  async function handleBrowseLocation() {
    const hasNative = await supportsNativeDialogsAsync()
    if (hasNative) {
      const selected = await openNativeFolderDialog({
        title: "Select Parent Directory",
        defaultPath: location().replace(/^~/, ""),
      })
      if (selected) {
        setLocation(selected)
      }
    }
  }

  async function handleCreate() {
    const nameErr = validateName(projectName())
    if (nameErr) {
      setNameError(nameErr)
      return
    }

    setIsCreating(true)
    setError(null)

    try {
      const result = await serverApi.initProject({
        name: projectName().trim(),
        location: location(),
        template: template(),
        gitInit: gitInit(),
        createReadme: createReadme(),
      })

      if (result.success) {
        resetForm()
        props.onProjectCreated(result.path)
      } else {
        setError(result.error || "Failed to create project")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project")
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!open) handleClose() }}>
      <DialogContent class="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create New Project</DialogTitle>
          <DialogDescription>Set up a new project with a template and optional git initialization.</DialogDescription>
        </DialogHeader>

        <div class="flex flex-col gap-4">
          {/* Project Name */}
          <div class="flex flex-col gap-1.5">
            <label class="text-sm font-medium text-foreground" for="project-name">
              Project Name
            </label>
            <input
              id="project-name"
              class={cn(
                "w-full px-3 py-2 text-sm rounded-md border bg-background text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20",
                nameError() ? "border-destructive" : "border-border",
              )}
              value={projectName()}
              onInput={(e) => {
                setProjectName(e.currentTarget.value)
                setNameError(null)
                setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && isFormValid()) {
                  e.preventDefault()
                  void handleCreate()
                }
              }}
              placeholder="my-project"
              disabled={isCreating()}
              autofocus
            />
            <Show when={nameError()}>
              <p class="text-xs text-destructive">{nameError()}</p>
            </Show>
          </div>

          {/* Location */}
          <div class="flex flex-col gap-1.5">
            <label class="text-sm font-medium text-foreground" for="project-location">
              Location
            </label>
            <div class="flex gap-2">
              <input
                id="project-location"
                class="flex-1 px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
                value={location()}
                onInput={(e) => {
                  setLocation(e.currentTarget.value)
                  setError(null)
                }}
                placeholder="~/Projects"
                disabled={isCreating()}
              />
              <button
                class="px-3 py-2 rounded-md text-sm font-medium border border-border bg-secondary text-secondary-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                onClick={() => void handleBrowseLocation()}
                disabled={isCreating()}
                aria-label="Browse for location"
              >
                <FolderOpen class="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Template Selection */}
          <div class="flex flex-col gap-1.5">
            <label class="text-sm font-medium text-foreground">Template</label>
            <div class="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Project template">
              <For each={TEMPLATE_OPTIONS}>
                {(opt) => {
                  const Icon = opt.icon
                  return (
                    <button
                      role="radio"
                      aria-checked={template() === opt.id}
                      class={cn(
                        "flex flex-col items-start gap-1 p-3 rounded-md border text-left transition-colors cursor-pointer",
                        template() === opt.id
                          ? "border-primary bg-primary/10"
                          : "border-border bg-background hover:bg-accent/50",
                        isCreating() && "opacity-50 cursor-not-allowed",
                      )}
                      onClick={() => !isCreating() && setTemplate(opt.id)}
                      disabled={isCreating()}
                    >
                      <div class="flex items-center gap-2">
                        <Icon class="w-4 h-4 text-primary" />
                        <span class="text-sm font-medium text-foreground">{opt.label}</span>
                      </div>
                      <span class="text-xs text-muted-foreground">{opt.description}</span>
                    </button>
                  )
                }}
              </For>
            </div>
          </div>

          {/* Options */}
          <div class="flex items-center gap-4">
            <label class="flex items-center gap-2 text-sm text-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={gitInit()}
                onChange={(e) => setGitInit(e.currentTarget.checked)}
                disabled={isCreating()}
                class="rounded border-border"
              />
              Initialize git
            </label>
            <label class="flex items-center gap-2 text-sm text-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={createReadme()}
                onChange={(e) => setCreateReadme(e.currentTarget.checked)}
                disabled={isCreating()}
                class="rounded border-border"
              />
              Create README.md
            </label>
          </div>

          {/* Error */}
          <Show when={error()}>
            <p class="text-sm text-destructive">{error()}</p>
          </Show>
        </div>

        <DialogFooter>
          <button
            class="px-4 py-2 rounded-md text-sm font-medium border border-border bg-secondary text-secondary-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            onClick={handleClose}
            disabled={isCreating()}
          >
            Cancel
          </button>
          <button
            class="px-4 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground transition-colors hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            onClick={() => void handleCreate()}
            disabled={!isFormValid()}
          >
            <Show when={isCreating()}>
              <Loader2 class="w-4 h-4 animate-spin" />
            </Show>
            {isCreating() ? "Creating..." : "Create Project"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default NewProjectWizard
