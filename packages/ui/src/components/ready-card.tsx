import { Component } from "solid-js"
import { MessageCircle } from "lucide-solid"
import { cn } from "../lib/cn"

interface ReadyCardProps {
  isReady: boolean
}

/**
 * A card that appears when the assistant has finished responding,
 * inviting the user to continue the conversation.
 */
const ReadyCard: Component<ReadyCardProps> = (props) => {
  if (!props.isReady) return null

  return (
    <div class={cn(
      "flex items-center justify-center px-4 py-3 mt-2 rounded-lg",
      "bg-success/10 border border-success/20 border-l-[3px] border-l-success/60",
    )}>
      <div class="flex items-center gap-2">
        <MessageCircle class="w-4 h-4 text-success/80 animate-pulse" />
        <span class="text-sm font-medium text-success/90 tracking-wide">Ready for your next message</span>
      </div>
    </div>
  )
}

export default ReadyCard
