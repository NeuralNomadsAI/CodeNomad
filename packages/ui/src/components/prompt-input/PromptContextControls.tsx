import type { Component } from "solid-js"
import AgentSelector from "../agent-selector"
import ModelSelector from "../model-selector"
import ThinkingSelector from "../thinking-selector"

interface PromptContextControlsProps {
  instanceId: string
  sessionId: string
  currentAgent: string
  currentModel: { providerId: string; modelId: string }
  onAgentChange: (agent: string) => Promise<void>
  onModelChange: (model: { providerId: string; modelId: string }) => Promise<void>
}

const PromptContextControls: Component<PromptContextControlsProps> = (props) => (
  <div class="prompt-context-controls">
    <AgentSelector
      instanceId={props.instanceId}
      sessionId={props.sessionId}
      currentAgent={props.currentAgent}
      onAgentChange={props.onAgentChange}
    />
    <ModelSelector
      instanceId={props.instanceId}
      sessionId={props.sessionId}
      currentModel={props.currentModel}
      onModelChange={props.onModelChange}
    />
    <ThinkingSelector instanceId={props.instanceId} currentModel={props.currentModel} />
  </div>
)

export default PromptContextControls
