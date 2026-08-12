import { For, createEffect, createSignal, type Component } from "solid-js"
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-solid"
import AgentSelector from "../../../../agent-selector"
import ModelSelector from "../../../../model-selector"
import {
  createWorkflowRun,
  getWorkflowDraft,
  setWorkflowDraft,
  type WorkflowDraftStage,
} from "../../../../../stores/workflows"
import { formatWorkflowError } from "./workflow-helpers"
import type { WorkflowBuilderProps } from "./workflow-types"

const MAX_STAGES = 12
let nextStageId = 0
const newStageId = () => `stage-${Date.now()}-${++nextStageId}`

const SimpleWorkflowBuilder: Component<WorkflowBuilderProps> = (props) => {
  const initialStages = (): WorkflowDraftStage[] => [
    {
      id: newStageId(),
      title: props.t("instanceShell.workflows.defaults.planner.title"),
      instructions: props.t("instanceShell.workflows.defaults.planner.instructions"),
      requiresApproval: true,
    },
    {
      id: newStageId(),
      title: props.t("instanceShell.workflows.defaults.implementer.title"),
      instructions: props.t("instanceShell.workflows.defaults.implementer.instructions"),
      requiresApproval: false,
    },
  ]
  const savedDraft = getWorkflowDraft(props.instanceId)
  const [objective, setObjective] = createSignal(savedDraft?.objective ?? "")
  const [stages, setStages] = createSignal(savedDraft?.stages ?? initialStages())
  const [submitting, setSubmitting] = createSignal(false)

  createEffect(() => setWorkflowDraft(props.instanceId, { objective: objective(), stages: stages() }))

  const updateStage = (id: string, patch: Partial<WorkflowDraftStage>) => {
    setStages((current) => current.map((stage) => (stage.id === id ? { ...stage, ...patch } : stage)))
  }

  const moveStage = (index: number, offset: -1 | 1) => {
    setStages((current) => {
      const target = index + offset
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const addStage = () => {
    if (stages().length >= MAX_STAGES) return
    setStages((current) => [...current, {
      id: newStageId(),
      title: props.t("instanceShell.workflows.defaults.newStage.title", { number: current.length + 1 }),
      instructions: "",
      requiresApproval: false,
    }])
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    setSubmitting(true)
    props.onError("")
    try {
      const sessionId = props.activeSessionId()
      await createWorkflowRun(props.instanceId, {
        objective: objective().trim(),
        initiatorSessionId: sessionId && sessionId !== "info" ? sessionId : undefined,
        stages: stages().map((stage) => ({
          ...stage,
          title: stage.title.trim(),
          instructions: stage.instructions.trim(),
          agent: stage.agent?.trim() || undefined,
          model: stage.model?.providerId && stage.model.modelId ? stage.model : undefined,
        })),
      })
      setObjective("")
    } catch (error) {
      props.onError(formatWorkflowError(error, props.t))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} class="workflow-form">
      <label class="workflow-field">
        <span>{props.t("instanceShell.workflows.objective.label")}</span>
        <textarea required value={objective()} onInput={(event) => setObjective(event.currentTarget.value)} placeholder={props.t("instanceShell.workflows.objective.placeholder")} rows={3} />
      </label>
      <div class="workflow-stage-heading">
        <strong>{props.t("instanceShell.workflows.stages.title")}</strong>
        <span>{props.t("instanceShell.workflows.stages.count", { count: stages().length, max: MAX_STAGES })}</span>
      </div>
      <For each={stages()}>
        {(stage, index) => (
          <fieldset class="workflow-stage">
            <legend>{props.t("instanceShell.workflows.stages.number", { number: index() + 1 })}</legend>
            <div class="workflow-stage-actions">
              <button type="button" onClick={() => moveStage(index(), -1)} disabled={index() === 0} aria-label={props.t("instanceShell.workflows.actions.moveUp")}><ArrowUp aria-hidden="true" /></button>
              <button type="button" onClick={() => moveStage(index(), 1)} disabled={index() === stages().length - 1} aria-label={props.t("instanceShell.workflows.actions.moveDown")}><ArrowDown aria-hidden="true" /></button>
              <button type="button" onClick={() => setStages((current) => current.filter(({ id }) => id !== stage.id))} disabled={stages().length === 1} aria-label={props.t("instanceShell.workflows.actions.removeStage")}><Trash2 aria-hidden="true" /></button>
            </div>
            <label class="workflow-field">
              <span>{props.t("instanceShell.workflows.fields.title")}</span>
              <input required value={stage.title} onInput={(event) => updateStage(stage.id, { title: event.currentTarget.value })} />
            </label>
            <label class="workflow-field">
              <span>{props.t("instanceShell.workflows.fields.instructions")}</span>
              <textarea required rows={4} value={stage.instructions} onInput={(event) => updateStage(stage.id, { instructions: event.currentTarget.value })} />
            </label>
            <div class="workflow-selectors">
              <label class="workflow-field">
                <span>{props.t("instanceShell.workflows.fields.agent")}</span>
                <AgentSelector instanceId={props.instanceId} sessionId={`workflow-${stage.id}`} currentAgent={stage.agent ?? ""} allowChildAgents square onAgentChange={async (agent) => updateStage(stage.id, { agent })} />
              </label>
              <label class="workflow-field">
                <span>{props.t("instanceShell.workflows.fields.model")}</span>
                <ModelSelector instanceId={props.instanceId} sessionId={`workflow-${stage.id}`} currentModel={stage.model ?? { providerId: "", modelId: "" }} square onModelChange={async (model) => updateStage(stage.id, { model })} />
              </label>
            </div>
            <label class="workflow-approval">
              <input type="checkbox" checked={stage.requiresApproval ?? false} onChange={(event) => updateStage(stage.id, { requiresApproval: event.currentTarget.checked })} />
              <span>{props.t("instanceShell.workflows.fields.requiresApproval")}</span>
            </label>
          </fieldset>
        )}
      </For>
      <div class="workflow-builder-actions">
        <button type="button" class="workflow-button" onClick={addStage} disabled={stages().length >= MAX_STAGES}><Plus aria-hidden="true" /> {props.t("instanceShell.workflows.actions.addStage")}</button>
        <button type="submit" class="workflow-button workflow-button-primary" disabled={submitting()}>{props.t(submitting() ? "instanceShell.workflows.actions.starting" : "instanceShell.workflows.actions.start")}</button>
      </div>
    </form>
  )
}

export default SimpleWorkflowBuilder
