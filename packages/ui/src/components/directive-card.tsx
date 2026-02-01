import { Component, createSignal, Show } from "solid-js"
import { Edit2, Trash2, Check, X } from "lucide-solid"
import { cn } from "../lib/cn"
import { Button } from "./ui"
import type { ParsedDirective } from "../lib/directive-parser"
import { getSectionColor } from "../lib/directive-parser"

interface DirectiveCardProps {
  directive: ParsedDirective
  readOnly?: boolean
  onEdit?: (id: string, newText: string) => void
  onDelete?: (id: string) => void
}

const DirectiveCard: Component<DirectiveCardProps> = (props) => {
  const [isEditing, setIsEditing] = createSignal(false)
  const [editText, setEditText] = createSignal("")

  const color = () => getSectionColor(props.directive.section || "")

  const startEdit = () => {
    setEditText(props.directive.text)
    setIsEditing(true)
  }

  const cancelEdit = () => {
    setIsEditing(false)
    setEditText("")
  }

  const saveEdit = () => {
    const newText = editText().trim()
    if (newText && newText !== props.directive.text) {
      props.onEdit?.(props.directive.id, newText)
    }
    setIsEditing(false)
    setEditText("")
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && e.metaKey) {
      saveEdit()
    } else if (e.key === "Escape") {
      cancelEdit()
    }
  }

  return (
    <div
      class={cn(
        "relative rounded-lg p-3 pl-4 transition-all",
        "bg-background border border-border",
        "border-l-4",
        isEditing() && "border-info shadow-[0_0_0_2px_rgba(59,130,246,0.2)]",
        !isEditing() && "hover:border-info/30"
      )}
      data-color={color()}
    >
      <Show when={!isEditing()}>
        <div class={cn("flex items-start justify-between gap-3")}>
          <span class={cn(
            "flex-1 text-sm leading-relaxed",
            props.readOnly ? "text-muted-foreground" : "text-foreground"
          )}>
            {props.directive.text}
          </span>
          <Show when={!props.readOnly}>
            <div class={cn("flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity")}>
              <button
                type="button"
                class={cn("p-1.5 rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-secondary")}
                onClick={startEdit}
                title="Edit directive"
              >
                <Edit2 class="w-4 h-4" />
              </button>
              <button
                type="button"
                class={cn("p-1.5 rounded transition-colors text-muted-foreground hover:text-destructive hover:bg-destructive/10")}
                onClick={() => props.onDelete?.(props.directive.id)}
                title="Delete directive"
              >
                <Trash2 class="w-4 h-4" />
              </button>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={isEditing()}>
        <div class={cn("flex flex-col gap-3")}>
          <textarea
            class={cn(
              "w-full p-2 rounded-md text-sm resize-none min-h-[60px]",
              "bg-secondary border border-border text-foreground",
              "focus:outline-none focus:border-info"
            )}
            value={editText()}
            onInput={(e) => setEditText(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            autofocus
            placeholder="Enter directive text..."
          />
          <div class={cn("flex items-center justify-end gap-2")}>
            <Button
              variant="outline"
              size="sm"
              onClick={cancelEdit}
              class="text-xs"
            >
              <X class="w-3 h-3" />
              <span>Cancel</span>
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={saveEdit}
              disabled={!editText().trim()}
              class="text-xs"
            >
              <Check class="w-3 h-3" />
              <span>Save</span>
            </Button>
          </div>
        </div>
      </Show>
    </div>
  )
}

export default DirectiveCard
