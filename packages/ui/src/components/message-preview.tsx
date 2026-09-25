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

  return (
    <div class="message-preview message-stream">
      <MessageBlock
        messageId={props.messageId}
        instanceId={props.instanceId}
        sessionId={props.sessionId}
        store={props.store}
        messageIndex={0}
        showThinking={() => false}
        thinkingDefaultExpanded={() => false}
        usageMetricsVisibility={() => "hidden"}
        toolVisibility={() => "expanded"}
      />
    </div>
  )
}

export default MessagePreview
