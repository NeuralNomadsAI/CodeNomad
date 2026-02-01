import { Component, Show, createSignal } from "solid-js"
import { BookmarkPlus, Check, Pencil, X, Globe, FolderOpen } from "lucide-solid"
import { cn } from "../lib/cn"
import {
  captureCardState,
  dismissCard,
  updateEditedInstruction,
  updateSelectedScope,
  acceptInstruction,
} from "../stores/instruction-capture"
import type { InstructionCategory, InstructionScope } from "../lib/instruction-classifier"
import { ERA_CODE_API_BASE } from "../lib/api-client"

// ---------------------------------------------------------------------------
// Category badge colors
// ---------------------------------------------------------------------------

const CATEGORY_COLORS: Record<InstructionCategory, string> = {
  workflow: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  tooling: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  style: "bg-pink-500/20 text-pink-300 border-pink-500/30",
  architecture: "bg-orange-500/20 text-orange-300 border-orange-500/30",
  testing: "bg-green-500/20 text-green-300 border-green-500/30",
  quality: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  environment: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
  communication: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30",
}

function categoryBadgeClass(category: InstructionCategory | null): string {
  if (!category) return "bg-muted/40 text-muted-foreground border-muted/60"
  return CATEGORY_COLORS[category] ?? "bg-muted/40 text-muted-foreground border-muted/60"
}

// ---------------------------------------------------------------------------
// Persist function placeholder — wired up by the parent
// ---------------------------------------------------------------------------

async function defaultPersist(
  instruction: string,
  scope: InstructionScope,
  category: InstructionCategory | null,
): Promise<void> {
  // POST to /api/era/classify-instruction
  const resp = await fetch(`${ERA_CODE_API_BASE}/api/era/classify-instruction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction, scope, category }),
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => "Unknown error")
    throw new Error(body)
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const InstructionCaptureCard: Component = () => {
  const [editing, setEditing] = createSignal(false)

  const state = () => captureCardState()
  const visible = () => state().visible
  const classification = () => state().classification
  const status = () => state().status
  const errorMessage = () => state().errorMessage
  const selectedScope = () => state().selectedScope
  const editedInstruction = () => state().userEditedInstruction
  const category = () => state().selectedCategory

  function toggleScope() {
    const next: InstructionScope = selectedScope() === "project" ? "global" : "project"
    updateSelectedScope(next)
  }

  function handleSave() {
    acceptInstruction(defaultPersist)
  }

  function handleEditToggle() {
    setEditing((prev) => !prev)
  }

  return (
    <Show when={visible()}>
      <div
        class={cn(
          "mx-2 mb-2 rounded-lg border overflow-hidden transition-all duration-300",
          "bg-card/95 backdrop-blur-sm shadow-lg",
          "border-primary/20",
          status() === "saved" && "border-success/40",
          status() === "error" && "border-destructive/40",
        )}
      >
        {/* Header row */}
        <div class="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/40">
          <div class="flex items-center gap-2 min-w-0">
            <BookmarkPlus class="w-4 h-4 shrink-0 text-primary/70" />
            <span class="text-xs font-medium text-muted-foreground truncate">
              Save as guidance?
            </span>
            <Show when={category()}>
              <span
                class={cn(
                  "text-[10px] px-1.5 py-0.5 rounded border font-medium uppercase tracking-wider",
                  categoryBadgeClass(category()),
                )}
              >
                {category()}
              </span>
            </Show>
          </div>

          <button
            onClick={dismissCard}
            class="p-0.5 rounded hover:bg-muted/60 text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            aria-label="Dismiss"
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body */}
        <div class="px-3 py-2 space-y-2">
          {/* Instruction text */}
          <Show
            when={editing()}
            fallback={
              <p class="text-sm text-foreground/90 leading-relaxed">
                {editedInstruction()}
              </p>
            }
          >
            <textarea
              value={editedInstruction()}
              onInput={(e) => updateEditedInstruction(e.currentTarget.value)}
              class={cn(
                "w-full text-sm bg-muted/30 border border-border/50 rounded px-2 py-1.5",
                "text-foreground/90 resize-none focus:outline-none focus:ring-1 focus:ring-primary/40",
              )}
              rows={2}
            />
          </Show>

          {/* Actions row */}
          <div class="flex items-center justify-between gap-2">
            {/* Scope toggle */}
            <button
              onClick={toggleScope}
              class={cn(
                "flex items-center gap-1 text-xs px-2 py-1 rounded-md border transition-colors",
                "hover:bg-muted/50",
                selectedScope() === "project"
                  ? "border-blue-500/30 text-blue-300"
                  : "border-amber-500/30 text-amber-300",
              )}
              title={selectedScope() === "project" ? "Project-scoped" : "Global (all projects)"}
            >
              <Show when={selectedScope() === "project"} fallback={<Globe class="w-3 h-3" />}>
                <FolderOpen class="w-3 h-3" />
              </Show>
              <span>{selectedScope() === "project" ? "Project" : "Global"}</span>
            </button>

            {/* Right actions */}
            <div class="flex items-center gap-1.5">
              <Show when={status() === "error"}>
                <span class="text-[10px] text-destructive truncate max-w-[140px]">
                  {errorMessage()}
                </span>
              </Show>

              <Show when={status() === "saved"}>
                <span class="flex items-center gap-1 text-xs text-success">
                  <Check class="w-3 h-3" />
                  Saved
                </span>
              </Show>

              <Show when={status() === "pending" || status() === "error"}>
                <button
                  onClick={handleEditToggle}
                  class={cn(
                    "p-1.5 rounded-md text-muted-foreground/70 hover:text-muted-foreground hover:bg-muted/50 transition-colors",
                    editing() && "bg-muted/50 text-muted-foreground",
                  )}
                  aria-label="Edit instruction"
                  title="Edit"
                >
                  <Pencil class="w-3.5 h-3.5" />
                </button>

                <button
                  onClick={handleSave}
                  disabled={status() === "saving"}
                  class={cn(
                    "flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-md transition-colors",
                    "bg-primary/20 text-primary hover:bg-primary/30 border border-primary/30",
                    status() === "saving" && "opacity-50 cursor-not-allowed",
                  )}
                >
                  <BookmarkPlus class="w-3 h-3" />
                  {status() === "saving" ? "Saving..." : "Save"}
                </button>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Show>
  )
}

export default InstructionCaptureCard
