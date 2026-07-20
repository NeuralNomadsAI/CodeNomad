import { For, Show, createEffect, createMemo, createSignal, onMount, type Accessor, type Component } from "solid-js"
import { ArrowDown, ArrowUp, Plus, RefreshCw, Trash2 } from "lucide-solid"
import type { WorkflowRun, WorkflowRunStep } from "../../../../../../../server/src/api-types"
import AgentSelector from "../../../../agent-selector"
import ModelSelector from "../../../../model-selector"
import { Markdown } from "../../../../markdown"
import { showConfirmDialog } from "../../../../../stores/alerts"
import { hydrateRestoredSessionChain, setActiveSessionFromList } from "../../../../../stores/sessions"
import {
  approveWorkflowRun,
  cancelWorkflowRun,
  createWorkflowRun,
  getWorkflowRuns,
  getWorkflowDraft,
  loadWorkflowRuns,
  setWorkflowDraft,
  workflowErrors,
  workflowLoading,
  workflowStatusTransitions,
  type WorkflowDraftStage,
} from "../../../../../stores/workflows"

interface WorkflowsTabProps {
  t: (key: string, vars?: Record<string, any>) => string
  instanceId: string
  activeSessionId: Accessor<string | null>
  active: Accessor<boolean>
}

const MAX_STAGES = 12
let nextStageId = 0
const newStageId = () => `stage-${Date.now()}-${++nextStageId}`

const WorkflowsTab: Component<WorkflowsTabProps> = (props) => {
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
  const [actionRunId, setActionRunId] = createSignal<string | null>(null)
  const [actionError, setActionError] = createSignal("")
  const [statusAnnouncement, setStatusAnnouncement] = createSignal("")
  const runs = createMemo(() => getWorkflowRuns(props.instanceId))
  const loading = createMemo(() => workflowLoading().get(props.instanceId) ?? false)
  const loadError = createMemo(() => workflowErrors().get(props.instanceId) ?? "")

  createEffect(() => {
    setWorkflowDraft(props.instanceId, { objective: objective(), stages: stages() })
  })

  createEffect(() => {
    if (!props.active()) return
    const transition = workflowStatusTransitions().get(props.instanceId)
    if (!transition) return
    setStatusAnnouncement("")
    queueMicrotask(() => {
      if (props.active()) {
        setStatusAnnouncement(props.t("instanceShell.workflows.live.statusChanged", {
          status: props.t(`instanceShell.workflows.status.${transition.status}`),
        }))
      }
    })
  })

  onMount(() => void loadWorkflowRuns(props.instanceId))

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
    setStages((current) => [
      ...current,
      {
        id: newStageId(),
        title: props.t("instanceShell.workflows.defaults.newStage.title", { number: current.length + 1 }),
        instructions: "",
        requiresApproval: false,
      },
    ])
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setActionError("")
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
      setActionError(error instanceof Error ? error.message : props.t("instanceShell.workflows.errors.action"))
    } finally {
      setSubmitting(false)
    }
  }

  const approve = async (run: WorkflowRun) => {
    const confirmed = await showConfirmDialog(props.t("instanceShell.workflows.confirm.approve.message"), {
      confirmLabel: props.t("instanceShell.workflows.actions.approve"),
      cancelLabel: props.t("instanceShell.workflows.actions.keepWaiting"),
      dismissible: false,
    })
    if (!confirmed) return
    await runAction(run.id, () => approveWorkflowRun(props.instanceId, run.id))
  }

  const cancel = async (run: WorkflowRun) => {
    const confirmed = await showConfirmDialog(props.t("instanceShell.workflows.confirm.cancel.message"), {
      variant: "warning",
      confirmLabel: props.t("instanceShell.workflows.actions.cancel"),
      cancelLabel: props.t("instanceShell.workflows.actions.keepRunning"),
      dismissible: false,
    })
    if (!confirmed) return
    await runAction(run.id, () => cancelWorkflowRun(props.instanceId, run.id))
  }

  const runAction = async (runId: string, action: () => Promise<WorkflowRun>) => {
    setActionRunId(runId)
    setActionError("")
    try {
      await action()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : props.t("instanceShell.workflows.errors.action"))
    } finally {
      setActionRunId(null)
    }
  }

  const openSession = async (sessionId: string) => {
    setActionError("")
    try {
      await hydrateRestoredSessionChain(props.instanceId, [sessionId])
      setActiveSessionFromList(props.instanceId, sessionId)
    } catch {
      setActionError(props.t("instanceShell.workflows.errors.openSession"))
    }
  }

  const formatTime = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
  const isCancellable = (run: WorkflowRun) => run.status === "running" || run.status === "waiting_for_review"
  const statusLabel = (status: WorkflowRun["status"] | WorkflowRunStep["status"]) =>
    props.t(`instanceShell.workflows.status.${status}`)

  const renderOutput = (step: WorkflowRunStep) => (
    <Show when={step.output !== undefined || step.outputTruncated}>
      <div class="workflow-output">
        <Show when={step.output !== undefined}>
          <div class="workflow-output-label">{props.t("instanceShell.workflows.output")}</div>
          <Show
            when={typeof step.output === "string"}
            fallback={<pre>{JSON.stringify(step.output, null, 2)}</pre>}
          >
            <Markdown part={{ type: "text", text: step.output as string } as any} size="sm" escapeRawHtml />
          </Show>
        </Show>
        <Show when={step.outputTruncated}>
          <p class="workflow-output-truncated">{props.t("instanceShell.workflows.outputTruncated")}</p>
        </Show>
      </div>
    </Show>
  )

  return (
    <div class="workflow-tab">
      <div class="sr-only" aria-live="polite" aria-atomic="true">{statusAnnouncement()}</div>
      <section class="workflow-builder" aria-labelledby="workflow-builder-title">
        <div class="workflow-section-heading">
          <div>
            <h2 id="workflow-builder-title">{props.t("instanceShell.workflows.builder.title")}</h2>
            <p>{props.t("instanceShell.workflows.builder.description")}</p>
          </div>
        </div>
        <form onSubmit={submit} class="workflow-form">
          <label class="workflow-field">
            <span>{props.t("instanceShell.workflows.objective.label")}</span>
            <textarea
              required
              value={objective()}
              onInput={(event) => setObjective(event.currentTarget.value)}
              placeholder={props.t("instanceShell.workflows.objective.placeholder")}
              rows={3}
            />
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
                  <button type="button" onClick={() => moveStage(index(), -1)} disabled={index() === 0} aria-label={props.t("instanceShell.workflows.actions.moveUp")}>
                    <ArrowUp aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => moveStage(index(), 1)} disabled={index() === stages().length - 1} aria-label={props.t("instanceShell.workflows.actions.moveDown")}>
                    <ArrowDown aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => setStages((current) => current.filter(({ id }) => id !== stage.id))} disabled={stages().length === 1} aria-label={props.t("instanceShell.workflows.actions.removeStage")}>
                    <Trash2 aria-hidden="true" />
                  </button>
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
                    <AgentSelector
                      instanceId={props.instanceId}
                      sessionId={`workflow-${stage.id}`}
                      currentAgent={stage.agent ?? ""}
                      allowChildAgents
                      square
                      onAgentChange={async (agent) => updateStage(stage.id, { agent })}
                    />
                  </label>
                  <label class="workflow-field">
                    <span>{props.t("instanceShell.workflows.fields.model")}</span>
                    <ModelSelector
                      instanceId={props.instanceId}
                      sessionId={`workflow-${stage.id}`}
                      currentModel={stage.model ?? { providerId: "", modelId: "" }}
                      square
                      onModelChange={async (model) => updateStage(stage.id, { model })}
                    />
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
            <button type="button" class="workflow-button" onClick={addStage} disabled={stages().length >= MAX_STAGES}>
              <Plus aria-hidden="true" /> {props.t("instanceShell.workflows.actions.addStage")}
            </button>
            <button type="submit" class="workflow-button workflow-button-primary" disabled={submitting()}>
              {props.t(submitting() ? "instanceShell.workflows.actions.starting" : "instanceShell.workflows.actions.start")}
            </button>
          </div>
        </form>
      </section>

      <section class="workflow-history" aria-labelledby="workflow-history-title">
        <div class="workflow-section-heading">
          <div>
            <h2 id="workflow-history-title">{props.t("instanceShell.workflows.history.title")}</h2>
            <p>{props.t("instanceShell.workflows.history.description")}</p>
          </div>
          <button type="button" class="workflow-icon-button" onClick={() => void loadWorkflowRuns(props.instanceId)} disabled={loading()} aria-label={props.t("instanceShell.workflows.actions.refresh")}>
            <RefreshCw aria-hidden="true" />
          </button>
        </div>

        <Show when={actionError() || loadError()}>
          <div class="workflow-error" role="alert">{actionError() || loadError()}</div>
        </Show>
        <Show when={loading() && runs().length === 0}>
          <div class="workflow-state">{props.t("instanceShell.workflows.history.loading")}</div>
        </Show>
        <Show when={!loading() && !loadError() && runs().length === 0}>
          <div class="workflow-state">{props.t("instanceShell.workflows.history.empty")}</div>
        </Show>

        <div class="workflow-run-list">
          <For each={runs()}>
            {(run) => (
              <article class="workflow-run">
                <header>
                  <div>
                    <h3>{run.objective}</h3>
                    <time dateTime={run.updatedAt}>{formatTime(run.updatedAt)}</time>
                  </div>
                  <span class={`workflow-status workflow-status-${run.status}`}>{statusLabel(run.status)}</span>
                </header>
                <div class="workflow-steps">
                  <For each={run.steps}>
                    {(step) => (
                      <section class="workflow-step">
                        <div class="workflow-step-heading">
                          <strong>{step.title}</strong>
                          <span class={`workflow-status workflow-status-${step.status}`}>{statusLabel(step.status)}</span>
                        </div>
                        <Show when={step.error}><div class="workflow-error" role="alert">{step.error}</div></Show>
                        {renderOutput(step)}
                        <Show when={step.sessionId}>
                          {(sessionId) => <button type="button" class="workflow-session-link" onClick={() => void openSession(sessionId())}>{props.t("instanceShell.workflows.actions.openSession")}</button>}
                        </Show>
                      </section>
                    )}
                  </For>
                </div>
                <Show when={run.error}><div class="workflow-error" role="alert">{run.error}</div></Show>
                <div class="workflow-run-actions">
                  <Show when={run.pendingReviewStepId}>
                    <button type="button" class="workflow-button workflow-button-primary" disabled={actionRunId() === run.id} onClick={() => void approve(run)}>{props.t("instanceShell.workflows.actions.approve")}</button>
                  </Show>
                  <Show when={isCancellable(run)}>
                    <button type="button" class="workflow-button workflow-button-danger" disabled={actionRunId() === run.id} onClick={() => void cancel(run)}>{props.t("instanceShell.workflows.actions.cancel")}</button>
                  </Show>
                </div>
              </article>
            )}
          </For>
        </div>
      </section>
    </div>
  )
}

export default WorkflowsTab
