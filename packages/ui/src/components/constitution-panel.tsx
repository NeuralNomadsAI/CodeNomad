import { Component, createSignal, createMemo, createEffect, onMount, Show } from "solid-js"
import { Lock, RefreshCw, AlertTriangle, FileQuestion, FolderOpen, Folder } from "lucide-solid"
import { cn } from "../lib/cn"
import DirectiveCardList from "./directive-card-list"
import type { ViewMode } from "./directive-card-list"
import { parseDirectivesMarkdown } from "../lib/directive-parser"
import {
  fetchDirectives,
  constitution,
  isDirectivesLoading,
} from "../stores/era-directives"
import { isEraInstalled } from "../stores/era-status"

interface ConstitutionPanelProps {
  folder?: string
}

/**
 * Extract project name from folder path
 */
function getProjectName(folder: string): string {
  const parts = folder.split("/")
  return parts[parts.length - 1] || folder
}

const ConstitutionPanel: Component<ConstitutionPanelProps> = (props) => {
  const [viewMode, setViewMode] = createSignal<ViewMode>("cards")

  onMount(() => {
    if (props.folder) {
      fetchDirectives(props.folder)
    }
  })

  createEffect(() => {
    if (props.folder) {
      fetchDirectives(props.folder)
    }
  })

  const parsedSections = createMemo(() => {
    const content = constitution()?.content
    if (!content) return []
    return parseDirectivesMarkdown(content)
  })

  const rawContent = () => constitution()?.content || ""

  return (
    <div class={cn("flex flex-col gap-4")}>
      {/* Header */}
      <div class={cn("flex items-center justify-between gap-4 flex-wrap")}>
        <div>
          <h2 class={cn("flex items-center gap-2 text-lg font-semibold text-foreground")}>
            <Lock class="w-5 h-5 text-destructive" />
            Constitution
          </h2>
          <p class={cn("text-sm mt-1 text-muted-foreground")}>Foundational safety rules that cannot be overridden</p>
        </div>
      </div>

      {/* Project indicator */}
      <Show when={props.folder}>
        <div class={cn("flex flex-wrap items-center gap-2 p-3 rounded-lg mb-4 bg-secondary border border-border")}>
          <label class={cn("text-sm font-medium text-muted-foreground")}>Project:</label>
          <div class={cn("flex items-center gap-2")}>
            <Folder class="w-4 h-4 text-success" />
            <span class={cn("text-sm font-semibold text-foreground")}>{getProjectName(props.folder)}</span>
            <span class={cn("text-xs truncate max-w-md font-mono text-muted-foreground")} title={props.folder}>{props.folder}</span>
          </div>
        </div>
      </Show>

      {/* No project open */}
      <Show when={!props.folder}>
        <div class={cn("flex flex-col items-center justify-center py-12 text-center text-muted-foreground")}>
          <FolderOpen class={cn("w-12 h-12 mb-4 opacity-30")} />
          <p class={cn("text-sm font-medium mb-1 text-foreground")}>No Project Open</p>
          <p class={cn("text-xs max-w-sm mb-4 text-muted-foreground")}>
            Open a project to view its constitution. The constitution defines
            immutable safety rules that govern AI behavior in your project.
          </p>
        </div>
      </Show>

      <Show when={props.folder}>
        {/* Read-only notice */}
        <div class={cn("flex items-start gap-3 p-4 rounded-lg bg-destructive/10 border border-destructive/30")}>
          <Lock class={cn("flex-shrink-0 text-destructive w-5 h-5")} />
          <div class={cn("text-sm text-muted-foreground")}>
            <strong class={cn("block font-semibold mb-1 text-destructive")}>Immutable Document</strong>
            The constitution cannot be modified through the UI. It contains core principles
            that govern all AI behavior and can only be changed through a formal review process.
          </div>
        </div>

        <Show when={!isEraInstalled()}>
          <div class={cn("flex items-center gap-2 p-4 rounded-md bg-warning/10 text-warning")}>
            <AlertTriangle class="w-5 h-5" />
            <div>
              <strong>Era Code Not Installed</strong>
              <p>Install Era Code to view the constitution.</p>
            </div>
          </div>
        </Show>

        <Show when={isDirectivesLoading()}>
          <div class={cn("flex items-center justify-center gap-2 py-8 text-muted-foreground")}>
            <RefreshCw class="w-5 h-5 animate-spin" />
            <span>Loading constitution...</span>
          </div>
        </Show>

        <Show when={!isDirectivesLoading() && isEraInstalled()}>
          <Show when={!constitution()?.exists}>
            <div class={cn("flex flex-col items-center justify-center py-12 text-center text-muted-foreground")}>
              <FileQuestion class={cn("w-12 h-12 mb-4 opacity-30")} />
              <p class={cn("text-sm font-medium mb-1 text-foreground")}>No Constitution Found</p>
              <p class={cn("text-xs max-w-sm mb-4 text-muted-foreground")}>
                Create a constitution file at <code>.era/memory/constitution.md</code> to
                establish foundational rules for your project.
              </p>
            </div>
          </Show>

          <Show when={constitution()?.exists}>
            <DirectiveCardList
              sections={parsedSections()}
              rawContent={rawContent()}
              readOnly={true}
              showViewToggle={true}
              viewMode={viewMode()}
              onViewModeChange={setViewMode}
            />
          </Show>
        </Show>
      </Show>
    </div>
  )
}

export default ConstitutionPanel
