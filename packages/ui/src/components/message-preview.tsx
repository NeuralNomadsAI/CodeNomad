import type { Component } from "solid-js"
import MessageBlock from "./message-block"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"

interface MessagePreviewProps {
  instanceId: string
  sessionId: string
  messageId: string
  store: () => InstanceMessageStore
}

const MessagePreview: Component<MessagePreviewProps> = (props) => {
  const lastAssistantIndex = () => 0

  return (
    <div class="w-[520px] max-h-[70vh] overflow-hidden rounded-lg border border-border bg-background shadow-[0_12px_32px_rgba(0,0,0,0.25)] p-3 text-sm flex flex-col gap-4">
      <MessageBlock
        messageId={props.messageId}
        instanceId={props.instanceId}
        sessionId={props.sessionId}
        store={props.store}
        messageIndex={0}
        lastAssistantIndex={lastAssistantIndex}
        showThinking={() => false}
        thinkingDefaultExpanded={() => false}
        showUsageMetrics={() => false}
      />
    </div>
  )
}

export default MessagePreview
