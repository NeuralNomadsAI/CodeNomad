import { Component, Show } from "solid-js"
import { ShieldAlert, Info, Settings } from "lucide-solid"
import { cn } from "../lib/cn"
import { Button } from "./ui"
import type { GovernanceDecision } from "../stores/era-governance"

interface GovernanceBlockMessageProps {
  command: string
  decision: GovernanceDecision
  onOverride?: () => void
  onOpenSettings?: () => void
}

const GovernanceBlockMessage: Component<GovernanceBlockMessageProps> = (props) => {
  return (
    <div class={cn("p-4 rounded-lg my-2 bg-destructive/10 border border-destructive")}>
      <div class={cn("flex items-center gap-2 mb-2")}>
        <ShieldAlert class="w-5 h-5" />
        <span class={cn("font-semibold text-sm text-destructive")}>Command Blocked by Governance</span>
        <Show when={props.decision.rule}>
          <span class={cn("font-mono text-xs px-2 py-0.5 rounded bg-secondary text-muted-foreground")}>{props.decision.rule}</span>
        </Show>
      </div>

      <div class={cn("mb-2 p-2 rounded bg-secondary")}>
        <code class={cn("font-mono text-sm text-foreground break-all")}>{props.command}</code>
      </div>

      <Show when={props.decision.reason}>
        <div class={cn("text-sm mb-2 text-foreground")}>{props.decision.reason}</div>
      </Show>

      <Show when={props.decision.suggestion}>
        <div class={cn("flex items-start gap-2 text-sm p-3 rounded mt-2 bg-secondary text-muted-foreground")}>
          <Info class="w-4 h-4 flex-shrink-0 mt-0.5 text-info" />
          <span>{props.decision.suggestion}</span>
        </div>
      </Show>

      <div class={cn("flex items-center gap-2 mt-3")}>
        <Show when={props.decision.overridable && props.onOverride}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => props.onOverride?.()}
          >
            Override with Justification
          </Button>
        </Show>
        <Show when={props.onOpenSettings}>
          <button
            type="button"
            class={cn("text-sm underline text-info cursor-pointer")}
            onClick={() => props.onOpenSettings?.()}
          >
            <Settings class="w-3 h-3 inline mr-1" />
            Governance Settings
          </button>
        </Show>
      </div>
    </div>
  )
}

export default GovernanceBlockMessage
