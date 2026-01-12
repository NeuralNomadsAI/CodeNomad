import { Component } from "solid-js"
import { MessageCircle } from "lucide-solid"

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
    <div class="ready-card">
      <div class="ready-card-content">
        <MessageCircle class="ready-card-icon" />
        <span class="ready-card-text">Ready for your next message</span>
      </div>
    </div>
  )
}

export default ReadyCard
