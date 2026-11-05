import { Show, type Component } from "solid-js"
import AgentSelector from "../agent-selector"
import ModelSelector from "../model-selector"
import ThinkingSelector from "../thinking-selector"
import WorktreeSelector from "../worktree-selector"
import { getProjectAvailability } from "../../stores/project-capability"

interface PromptContextControlsProps {
  instanceId: string
  sessionId: string
  worktreeSessionId?: string
  currentAgent: string
  currentModel: { providerId: string; modelId: string }
  onAgentChange: (agent: string) => Promise<void>
  onModelChange: (model: { providerId: string; modelId: string }) => Promise<void>
}

const PromptContextControls: Component<PromptContextControlsProps> = (props) => (
  <div class="prompt-context-controls" data-has-worktree={props.worktreeSessionId && getProjectAvailability(props.instanceId, "worktrees").allowed ? "true" : "false"}>
    <Show when={getProjectAvailability(props.instanceId, "worktrees").allowed && props.worktreeSessionId}>
      {(sessionId) => <WorktreeSelector instanceId={props.instanceId} sessionId={sessionId()} />}
    </Show>
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
