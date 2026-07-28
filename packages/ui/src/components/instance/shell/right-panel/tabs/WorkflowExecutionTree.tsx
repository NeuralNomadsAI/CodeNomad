import { For, Show, createSignal, type Component } from "solid-js"
import type { WorkflowExecutionNode, WorkflowNode, WorkflowRun, WorkflowUsage } from "../../../../../../../server/src/api-types"
import { Markdown } from "../../../../markdown"
import { buildWorkflowExecutionTree, WORKFLOW_EXECUTION_NODE_LIMIT, type WorkflowExecutionTreeNode } from "./workflow-helpers"

interface WorkflowExecutionTreeProps {
  run: WorkflowRun
  t: (key: string, vars?: Record<string, any>) => string
  onOpenSession: (sessionId: string) => void
}

const nodeTitles = (node: WorkflowNode | undefined, result = new Map<string, string>()): Map<string, string> => {
  if (!node) return result
  if (node.title) result.set(node.id, node.title)
  if (node.type === "sequence") node.steps.forEach((child) => nodeTitles(child, result))
  if (node.type === "parallel") node.branches.forEach((child) => nodeTitles(child, result))
  if (node.type === "foreach" || node.type === "repeat") nodeTitles(node.body, result)
  if (node.type === "condition") {
    nodeTitles(node.then, result)
    nodeTitles(node.else, result)
  }
  return result
}

const Usage: Component<{ usage?: WorkflowUsage; t: WorkflowExecutionTreeProps["t"] }> = (props) => (
  <Show when={props.usage}>
    {(usage) => (
      <dl class="workflow-usage">
        <div><dt>{props.t("instanceShell.workflows.usage.cost")}</dt><dd>{usage().cost.toLocaleString()}</dd></div>
        <div><dt>{props.t("instanceShell.workflows.usage.tokens")}</dt><dd>{usage().tokens.toLocaleString()}</dd></div>
        <div><dt>{props.t("instanceShell.workflows.usage.input")}</dt><dd>{usage().inputTokens.toLocaleString()}</dd></div>
        <div><dt>{props.t("instanceShell.workflows.usage.output")}</dt><dd>{usage().outputTokens.toLocaleString()}</dd></div>
        <div><dt>{props.t("instanceShell.workflows.usage.reasoning")}</dt><dd>{usage().reasoningTokens.toLocaleString()}</dd></div>
        <div><dt>{props.t("instanceShell.workflows.usage.cacheRead")}</dt><dd>{usage().cacheReadTokens.toLocaleString()}</dd></div>
        <div><dt>{props.t("instanceShell.workflows.usage.cacheWrite")}</dt><dd>{usage().cacheWriteTokens.toLocaleString()}</dd></div>
      </dl>
    )}
  </Show>
)

const NodeOutput: Component<{ node: WorkflowExecutionNode; t: WorkflowExecutionTreeProps["t"] }> = (props) => (
  <Show when={props.node.output !== undefined || props.node.outputTruncated}>
    <div class="workflow-output">
      <Show when={props.node.output !== undefined}>
        <div class="workflow-output-label">{props.t("instanceShell.workflows.output")}</div>
        <Show when={typeof props.node.output === "string"} fallback={<pre>{JSON.stringify(props.node.output, null, 2)}</pre>}>
          <Markdown part={{ type: "text", text: props.node.output as string } as any} size="sm" escapeRawHtml />
        </Show>
      </Show>
      <Show when={props.node.outputTruncated}><p class="workflow-output-truncated">{props.t("instanceShell.workflows.outputTruncated")}</p></Show>
    </div>
  </Show>
)

const ExecutionNode: Component<{
  item: WorkflowExecutionTreeNode
  titles: Map<string, string>
  t: WorkflowExecutionTreeProps["t"]
  onOpenSession: (sessionId: string) => void
}> = (props) => {
  const node = () => props.item.node
  const [open, setOpen] = createSignal(false)
  return (
    <li class="workflow-execution-node">
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <span class="workflow-node-order" aria-hidden="true" />
          <span class="workflow-node-title">{props.t(`instanceShell.workflows.nodeType.${node().type}`)} · {props.titles.get(node().definitionNodeId) ?? node().definitionNodeId}</span>
          <span class={`workflow-status workflow-status-${node().status}`}>{props.t(`instanceShell.workflows.status.${node().status}`)}</span>
        </summary>
        <Show when={open()}>
        <div class="workflow-node-body">
          <p>{props.t("instanceShell.workflows.execution.attempt", { attempt: node().attempt })}</p>
          <Show when={node().error}><div class="workflow-error" role="alert">{node().error}</div></Show>
          <Usage usage={node().usage} t={props.t} />
          <NodeOutput node={node()} t={props.t} />
          <Show when={node().sessionIds?.length}>
            <div class="workflow-session-links">
              <For each={node().sessionIds}>{(sessionId, index) => (
                <button type="button" class="workflow-session-link" onClick={() => props.onOpenSession(sessionId)}>
                  {props.t("instanceShell.workflows.actions.openSessionNumber", { number: index() + 1 })}
                </button>
              )}</For>
            </div>
          </Show>
        </div>
        <Show when={props.item.children.length}>
          <ol class="workflow-execution-tree">
            <For each={props.item.children}>{(child) => <ExecutionNode item={child} titles={props.titles} t={props.t} onOpenSession={props.onOpenSession} />}</For>
          </ol>
        </Show>
        </Show>
      </details>
    </li>
  )
}

const WorkflowExecutionTree: Component<WorkflowExecutionTreeProps> = (props) => {
  const titles = () => nodeTitles(props.run.definitionSnapshot?.root)
  const nodes = () => props.run.executionNodes ?? []
  const visibleNodes = () => nodes().slice(0, WORKFLOW_EXECUTION_NODE_LIMIT)
  const tree = () => buildWorkflowExecutionTree(visibleNodes())
  return (
    <Show when={tree().length}>
      <section class="workflow-execution" aria-label={props.t("instanceShell.workflows.execution.title")}>
        <ol class="workflow-execution-tree">
          <For each={tree()}>{(item) => <ExecutionNode item={item} titles={titles()} t={props.t} onOpenSession={props.onOpenSession} />}</For>
        </ol>
        <Show when={nodes().length > visibleNodes().length}>
          <p class="workflow-node-limit" role="status">{props.t("instanceShell.workflows.execution.nodesLimited", { shown: visibleNodes().length, total: nodes().length })}</p>
        </Show>
      </section>
    </Show>
  )
}

export { Usage }
export default WorkflowExecutionTree
