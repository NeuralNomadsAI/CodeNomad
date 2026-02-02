import { Show } from "solid-js"
import { getSessionStatus } from "../stores/session-status"
import { Loader2 } from "lucide-solid"
import { cn } from "../lib/cn"

interface CompactionCardProps {
  instanceId: string
  sessionId: string
}

export default function CompactionCard(props: CompactionCardProps) {
  const isCompacting = () => getSessionStatus(props.instanceId, props.sessionId) === "compacting"

  return (
    <Show when={isCompacting()}>
      <div class={cn(
        "mx-3 mb-2 px-4 py-3 rounded-lg border",
        "bg-violet-500/5 border-violet-500/20",
        "flex items-center gap-3",
        "animate-in fade-in slide-in-from-bottom-2 duration-300"
      )}>
        <Loader2 class="w-4 h-4 text-violet-500 animate-spin shrink-0" />
        <div class="flex flex-col gap-0.5 min-w-0">
          <span class="text-sm font-medium text-violet-600 dark:text-violet-400">
            Compacting context
          </span>
          <span class="text-xs text-muted-foreground">
            Summarizing conversation history to free up context window space. This happens automatically and will resume shortly.
          </span>
        </div>
      </div>
    </Show>
  )
}
