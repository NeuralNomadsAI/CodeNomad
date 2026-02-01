/**
 * Saved Instructions Panel
 *
 * Settings section for reviewing, editing, deleting, promoting, and
 * demoting saved instructions (directives + Era Memory).
 */
import { Component, Show, For, createSignal, createResource, createMemo } from "solid-js"
import {
  Trash2,
  Edit2,
  Save,
  ArrowUpRight,
  ArrowDownRight,
  X,
  Globe,
  FolderOpen,
  RefreshCw,
  AlertTriangle,
  BookmarkPlus,
} from "lucide-solid"
import { cn } from "../lib/cn"
import { Button } from "./ui"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui"
import { Badge } from "./ui"
import { Separator } from "./ui"
import { ERA_CODE_API_BASE } from "../lib/api-client"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SavedInstruction {
  id: string
  content: string
  category: string
  scope: "project" | "global"
  storageType: "directive" | "memory"
  createdAt?: string
  accessCount?: number
  projectPath?: string
}

// ---------------------------------------------------------------------------
// Category badge styles
// ---------------------------------------------------------------------------

const CATEGORY_COLORS: Record<string, string> = {
  workflow: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  tooling: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  style: "bg-pink-500/20 text-pink-400 border-pink-500/30",
  architecture: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  testing: "bg-green-500/20 text-green-400 border-green-500/30",
  quality: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  environment: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  communication: "bg-indigo-500/20 text-indigo-400 border-indigo-500/30",
}

function categoryBadge(category: string) {
  return CATEGORY_COLORS[category] ?? "bg-muted/40 text-muted-foreground border-muted/60"
}

// ---------------------------------------------------------------------------
// Data Fetching
// ---------------------------------------------------------------------------

async function fetchInstructions(folder?: string): Promise<SavedInstruction[]> {
  const params = new URLSearchParams()
  if (folder) params.set("folder", folder)

  const resp = await fetch(`${ERA_CODE_API_BASE}/api/era/instructions?${params}`)
  if (!resp.ok) return []
  const data = await resp.json()
  return data.instructions ?? []
}

// ---------------------------------------------------------------------------
// Instruction Row Component
// ---------------------------------------------------------------------------

interface InstructionRowProps {
  instruction: SavedInstruction
  onDelete: (inst: SavedInstruction) => void
  onEdit: (inst: SavedInstruction, newContent: string) => void
  onPromote: (inst: SavedInstruction) => void
  onDemote: (inst: SavedInstruction) => void
}

const InstructionRow: Component<InstructionRowProps> = (props) => {
  const [editing, setEditing] = createSignal(false)
  const [editText, setEditText] = createSignal("")
  const [loading, setLoading] = createSignal(false)

  function startEdit() {
    setEditText(props.instruction.content)
    setEditing(true)
  }

  function cancelEdit() {
    setEditing(false)
    setEditText("")
  }

  async function saveEdit() {
    setLoading(true)
    try {
      await props.onEdit(props.instruction, editText())
      setEditing(false)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div class="group flex flex-col gap-2 px-3 py-2.5 rounded-lg border border-border/50 bg-secondary/30 hover:bg-secondary/60 transition-colors">
      {/* Top row: content + badges */}
      <div class="flex items-start gap-2">
        <div class="flex-1 min-w-0">
          <Show
            when={editing()}
            fallback={
              <p class="text-sm text-foreground/90 leading-relaxed break-words">
                {props.instruction.content}
              </p>
            }
          >
            <textarea
              value={editText()}
              onInput={(e) => setEditText(e.currentTarget.value)}
              class="w-full text-sm bg-muted/30 border border-border/50 rounded px-2 py-1.5 text-foreground/90 resize-none focus:outline-none focus:ring-1 focus:ring-primary/40"
              rows={2}
            />
          </Show>
        </div>

        {/* Badges */}
        <div class="flex items-center gap-1.5 shrink-0">
          <span
            class={cn(
              "text-[10px] px-1.5 py-0.5 rounded border font-medium uppercase tracking-wider",
              categoryBadge(props.instruction.category),
            )}
          >
            {props.instruction.category}
          </span>

          <span
            class={cn(
              "flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border font-medium",
              props.instruction.scope === "project"
                ? "border-blue-500/30 text-blue-400 bg-blue-500/10"
                : "border-amber-500/30 text-amber-400 bg-amber-500/10",
            )}
          >
            <Show when={props.instruction.scope === "project"} fallback={<Globe class="w-2.5 h-2.5" />}>
              <FolderOpen class="w-2.5 h-2.5" />
            </Show>
            {props.instruction.scope}
          </span>

          <span
            class={cn(
              "text-[10px] px-1.5 py-0.5 rounded border font-medium",
              props.instruction.storageType === "directive"
                ? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10"
                : "border-violet-500/30 text-violet-400 bg-violet-500/10",
            )}
          >
            {props.instruction.storageType}
          </span>
        </div>
      </div>

      {/* Meta row */}
      <div class="flex items-center justify-between text-[11px] text-muted-foreground/70">
        <div class="flex items-center gap-3">
          <Show when={props.instruction.createdAt}>
            <span>Saved {props.instruction.createdAt?.split("T")[0]}</span>
          </Show>
          <Show when={props.instruction.accessCount != null && props.instruction.accessCount > 0}>
            <span>{props.instruction.accessCount} accesses</span>
          </Show>
        </div>

        {/* Actions */}
        <div class={cn(
          "flex items-center gap-1 transition-opacity",
          editing() ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}>
          <Show when={editing()}>
            <button
              onClick={cancelEdit}
              class="p-1 rounded hover:bg-muted/60 text-muted-foreground/60 hover:text-muted-foreground transition-colors"
              title="Cancel"
            >
              <X class="w-3.5 h-3.5" />
            </button>
            <button
              onClick={saveEdit}
              disabled={loading()}
              class="p-1 rounded hover:bg-primary/20 text-primary/70 hover:text-primary transition-colors"
              title="Save"
            >
              <Save class="w-3.5 h-3.5" />
            </button>
          </Show>

          <Show when={!editing()}>
            <button
              onClick={startEdit}
              class="p-1 rounded hover:bg-muted/60 text-muted-foreground/60 hover:text-muted-foreground transition-colors"
              title="Edit"
            >
              <Edit2 class="w-3.5 h-3.5" />
            </button>

            {/* Promote (memory → directive) */}
            <Show when={props.instruction.storageType === "memory"}>
              <button
                onClick={() => props.onPromote(props.instruction)}
                class="p-1 rounded hover:bg-emerald-500/20 text-muted-foreground/60 hover:text-emerald-400 transition-colors"
                title="Promote to directive"
              >
                <ArrowUpRight class="w-3.5 h-3.5" />
              </button>
            </Show>

            {/* Demote (directive → memory) */}
            <Show when={props.instruction.storageType === "directive"}>
              <button
                onClick={() => props.onDemote(props.instruction)}
                class="p-1 rounded hover:bg-violet-500/20 text-muted-foreground/60 hover:text-violet-400 transition-colors"
                title="Demote to memory"
              >
                <ArrowDownRight class="w-3.5 h-3.5" />
              </button>
            </Show>

            <button
              onClick={() => props.onDelete(props.instruction)}
              class="p-1 rounded hover:bg-destructive/20 text-muted-foreground/60 hover:text-destructive transition-colors"
              title="Delete"
            >
              <Trash2 class="w-3.5 h-3.5" />
            </button>
          </Show>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panel Component
// ---------------------------------------------------------------------------

interface SavedInstructionsPanelProps {
  folder?: string
}

const SavedInstructionsPanel: Component<SavedInstructionsPanelProps> = (props) => {
  const [refreshKey, setRefreshKey] = createSignal(0)

  const [instructions, { refetch }] = createResource(
    () => ({ folder: props.folder, key: refreshKey() }),
    (params) => fetchInstructions(params.folder),
  )

  const directives = createMemo(() =>
    (instructions() ?? []).filter((i) => i.storageType === "directive"),
  )

  const memories = createMemo(() =>
    (instructions() ?? []).filter((i) => i.storageType === "memory"),
  )

  function doRefresh() {
    setRefreshKey((k) => k + 1)
  }

  async function handleDelete(inst: SavedInstruction) {
    const resp = await fetch(`${ERA_CODE_API_BASE}/api/era/instructions`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: inst.id,
        storageType: inst.storageType,
        category: inst.category,
        projectPath: inst.projectPath,
      }),
    })
    if (resp.ok) doRefresh()
  }

  async function handleEdit(inst: SavedInstruction, newContent: string) {
    const resp = await fetch(`${ERA_CODE_API_BASE}/api/era/instructions`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: inst.id,
        storageType: inst.storageType,
        newContent,
        category: inst.category,
        projectPath: inst.projectPath,
      }),
    })
    if (resp.ok) doRefresh()
  }

  async function handlePromote(inst: SavedInstruction) {
    const resp = await fetch(`${ERA_CODE_API_BASE}/api/era/instructions/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: inst.id,
        content: inst.content,
        category: inst.category,
        scope: inst.scope,
        projectPath: inst.projectPath,
      }),
    })
    if (resp.ok) doRefresh()
  }

  async function handleDemote(inst: SavedInstruction) {
    const resp = await fetch(`${ERA_CODE_API_BASE}/api/era/instructions/demote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: inst.id,
        content: inst.content,
        category: inst.category,
        scope: inst.scope,
        projectPath: inst.projectPath,
      }),
    })
    if (resp.ok) doRefresh()
  }

  const renderList = (items: () => SavedInstruction[]) => (
    <Show
      when={items().length > 0}
      fallback={
        <div class="flex flex-col items-center justify-center py-8 text-muted-foreground/60">
          <BookmarkPlus class="w-8 h-8 mb-2 opacity-40" />
          <p class="text-sm">No saved instructions yet</p>
          <p class="text-xs mt-1">Instructions will appear here as you save guidance during sessions</p>
        </div>
      }
    >
      <div class="space-y-2">
        <For each={items()}>
          {(inst) => (
            <InstructionRow
              instruction={inst}
              onDelete={handleDelete}
              onEdit={handleEdit}
              onPromote={handlePromote}
              onDemote={handleDemote}
            />
          )}
        </For>
      </div>
    </Show>
  )

  return (
    <div class="mb-8">
      <div class="flex items-center justify-between mb-1">
        <h2 class="text-xl font-semibold text-foreground">Saved Instructions</h2>
        <button
          onClick={doRefresh}
          class="p-1.5 rounded-md hover:bg-muted/60 text-muted-foreground/60 hover:text-muted-foreground transition-colors"
          title="Refresh"
        >
          <RefreshCw class={cn("w-4 h-4", instructions.loading && "animate-spin")} />
        </button>
      </div>
      <p class="text-sm text-muted-foreground mb-6">
        Review and manage instructions captured from your sessions
      </p>

      <Show when={instructions.error}>
        <div class="flex items-center gap-2 px-3 py-2 mb-4 rounded-lg border border-destructive/30 bg-destructive/10 text-destructive text-sm">
          <AlertTriangle class="w-4 h-4 shrink-0" />
          <span>Failed to load instructions</span>
        </div>
      </Show>

      <Tabs defaultValue="directives">
        <TabsList class="mb-4">
          <TabsTrigger value="directives">
            Directives
            <Show when={directives().length > 0}>
              <span class="ml-1.5 text-[10px] bg-muted/60 rounded-full px-1.5 py-0.5">
                {directives().length}
              </span>
            </Show>
          </TabsTrigger>
          <TabsTrigger value="memories">
            Memories
            <Show when={memories().length > 0}>
              <span class="ml-1.5 text-[10px] bg-muted/60 rounded-full px-1.5 py-0.5">
                {memories().length}
              </span>
            </Show>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="directives">
          {renderList(directives)}
        </TabsContent>

        <TabsContent value="memories">
          {renderList(memories)}
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default SavedInstructionsPanel
