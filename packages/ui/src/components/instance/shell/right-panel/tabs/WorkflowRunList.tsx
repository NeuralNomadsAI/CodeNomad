import { For, Show, createEffect, createMemo, createSignal, type Component } from "solid-js"
import type { WorkflowRun, WorkflowRunStep } from "../../../../../../../server/src/api-types"
import { Markdown } from "../../../../markdown"
import { showConfirmDialog } from "../../../../../stores/alerts"
import {
  answerWorkflowGate,
  approveWorkflowRun,
  cancelWorkflowRun,
  pauseWorkflowRun,
  resumeWorkflowRun,
} from "../../../../../stores/workflows"
import { formatWorkflowError, formatWorkflowRunTime, parseWorkflowObject } from "./workflow-helpers"
import WorkflowExecutionTree, { Usage } from "./WorkflowExecutionTree"

interface WorkflowRunListProps {
  instanceId: string
  runs: WorkflowRun[]
  locale: string
  t: (key: string, vars?: Record<string, any>) => string
  onError: (message: string) => void
  onOpenSession: (run: WorkflowRun, sessionId: string) => void
}

const LegacyOutput: Component<{ step: WorkflowRunStep; t: WorkflowRunListProps["t"] }> = (props) => (
  <Show when={props.step.output !== undefined || props.step.outputTruncated}>
    <div class="workflow-output">
      <Show when={props.step.output !== undefined}>
        <div class="workflow-output-label">{props.t("instanceShell.workflows.output")}</div>
        <Show when={typeof props.step.output === "string"} fallback={<pre>{JSON.stringify(props.step.output, null, 2)}</pre>}>
          <Markdown part={{ type: "text", text: props.step.output as string } as any} size="sm" escapeRawHtml />
        </Show>
      </Show>
      <Show when={props.step.outputTruncated}><p class="workflow-output-truncated">{props.t("instanceShell.workflows.outputTruncated")}</p></Show>
    </div>
  </Show>
)

const WorkflowRunCard: Component<WorkflowRunListProps & { run: WorkflowRun; expanded: boolean; onToggle: () => void }> = (props) => {
  const [busy, setBusy] = createSignal(false)
  const [gateInput, setGateInput] = createSignal("{}")
  const t = props.t
  const action = async (operation: () => Promise<WorkflowRun>) => {
    setBusy(true)
    props.onError("")
    try { await operation() } catch (error) {
      props.onError(formatWorkflowError(error, t))
    } finally { setBusy(false) }
  }
  const approve = async () => {
    const gate = props.run.pendingGate
    const reviewStepId = props.run.pendingReviewStepId
    if (!gate && !reviewStepId) return
    const confirmed = await showConfirmDialog(t("instanceShell.workflows.confirm.approve.message"), {
      confirmLabel: t("instanceShell.workflows.actions.approve"),
      cancelLabel: t("instanceShell.workflows.actions.keepWaiting"), dismissible: false,
    })
    if (!confirmed) return
    await action(() => gate
      ? answerWorkflowGate(props.instanceId, props.run.id, gate.executionNodeId, true)
      : approveWorkflowRun(props.instanceId, props.run.id, reviewStepId!))
  }
  const cancel = async () => {
    const confirmed = await showConfirmDialog(t("instanceShell.workflows.confirm.cancel.message"), {
      variant: "warning", confirmLabel: t("instanceShell.workflows.actions.cancel"),
      cancelLabel: t("instanceShell.workflows.actions.keepRunning"), dismissible: false,
    })
    if (confirmed) await action(() => cancelWorkflowRun(props.instanceId, props.run.id))
  }
  const recover = async () => {
    const expectedRevision = props.run.revision
    const confirmed = await showConfirmDialog(t("instanceShell.workflows.confirm.recovery.message"), {
      variant: "warning", confirmLabel: t("instanceShell.workflows.actions.confirmRecovery"),
      cancelLabel: t("instanceShell.workflows.actions.keepWaiting"), dismissible: false,
    })
    if (confirmed) await action(() => resumeWorkflowRun(props.instanceId, props.run.id, true, expectedRevision))
  }
  const answerInput = async (event: SubmitEvent) => {
    event.preventDefault()
    const gate = props.run.pendingGate
    if (!gate) return
    let answer: unknown
    try { answer = JSON.parse(gateInput()) } catch {
      props.onError(t("instanceShell.workflows.gate.invalidJson"))
      return
    }
    await action(() => answerWorkflowGate(props.instanceId, props.run.id, gate.executionNodeId, answer))
  }
  const cancellable = () => ["running", "pausing", "paused", "waiting_for_review", "waiting_for_input", "interrupted", "recovery_required"].includes(props.run.status)
  const toggleId = () => `workflow-run-toggle-${props.run.id}`
  const detailsId = () => `workflow-run-details-${props.run.id}`
  return (
    <article class="workflow-run">
      <header>
        <div>
          <h3><button id={toggleId()} type="button" class="workflow-run-toggle" aria-expanded={props.expanded} aria-controls={detailsId()} onClick={props.onToggle}>{props.run.objective}</button></h3>
          <time dateTime={props.run.updatedAt}>{formatWorkflowRunTime(props.run.updatedAt, props.locale)}</time>
          <Show when={props.run.definitionId}><p class="workflow-run-definition">{t("instanceShell.workflows.run.definition", { id: props.run.definitionId, revision: props.run.definitionRevision })}</p></Show>
        </div>
        <span class={`workflow-status workflow-status-${props.run.status}`}>{t(`instanceShell.workflows.status.${props.run.status}`)}</span>
      </header>
      <div id={detailsId()} role="region" aria-labelledby={toggleId()} hidden={!props.expanded}>
      <Show when={props.expanded}>
      <Show when={props.run.definitionSnapshot?.budget || props.run.usage}>
        <section class="workflow-run-totals" aria-label={t("instanceShell.workflows.usage.total")}>
          <Show when={props.run.definitionSnapshot?.budget}>
            {(budget) => <p>{t("instanceShell.workflows.usage.budget", {
              cost: budget().maxCost ?? t("instanceShell.workflows.usage.unlimited"),
              tokens: budget().maxTokens ?? t("instanceShell.workflows.usage.unlimited"),
            })}</p>}
          </Show>
          <Usage usage={props.run.usage} t={t} />
        </section>
      </Show>
      <Show when={props.run.executionNodes} fallback={
        <div class="workflow-steps">
          <For each={props.run.steps}>{(step) => (
            <section class="workflow-step">
              <div class="workflow-step-heading"><strong>{step.title}</strong><span class={`workflow-status workflow-status-${step.status}`}>{t(`instanceShell.workflows.status.${step.status}`)}</span></div>
               <Show when={step.error}><div class="workflow-error" role="alert">{step.error}</div></Show>
              <LegacyOutput step={step} t={t} />
               <Show when={step.sessionId}>{(sessionId) => <button type="button" class="workflow-session-link" onClick={() => props.onOpenSession(props.run, sessionId())}>{t("instanceShell.workflows.actions.openSession")}</button>}</Show>
            </section>
          )}</For>
        </div>
      }>
        <WorkflowExecutionTree run={props.run} t={t} onOpenSession={(sessionId) => props.onOpenSession(props.run, sessionId)} />
      </Show>
      <Show when={props.run.pendingGate}>
        {(gate) => (
          <section class="workflow-gate">
            <h4>{t(`instanceShell.workflows.gate.${gate().gate}`)}</h4>
            <p>{gate().prompt}</p>
            <Show when={gate().inputSchema}><div class="workflow-output-label">{t("instanceShell.workflows.gate.schema")}</div><pre>{JSON.stringify(gate().inputSchema, null, 2)}</pre></Show>
            <Show when={gate().gate === "approval"} fallback={
              <form onSubmit={answerInput} class="workflow-form">
                <label class="workflow-field"><span>{t("instanceShell.workflows.gate.answer")}</span><textarea required spellcheck={false} rows={5} value={gateInput()} onInput={(event) => setGateInput(event.currentTarget.value)} /></label>
                <button type="submit" class="workflow-button workflow-button-primary" disabled={busy()}>{t("instanceShell.workflows.gate.submit")}</button>
              </form>
            }>
              <form onSubmit={(event) => { event.preventDefault(); void approve() }}>
                <button type="submit" class="workflow-button workflow-button-primary" disabled={busy()}>{t("instanceShell.workflows.actions.approve")}</button>
              </form>
            </Show>
          </section>
        )}
      </Show>
      <Show when={props.run.error}><div class="workflow-error" role="alert">{props.run.error}</div></Show>
      <div class="workflow-run-actions">
        <Show when={props.run.pendingReviewStepId && !props.run.pendingGate}><button type="button" class="workflow-button workflow-button-primary" disabled={busy()} onClick={() => void approve()}>{t("instanceShell.workflows.actions.approve")}</button></Show>
        <Show when={props.run.status === "running" && props.run.definitionSnapshot}><button type="button" class="workflow-button" disabled={busy()} onClick={() => void action(() => pauseWorkflowRun(props.instanceId, props.run.id))}>{t("instanceShell.workflows.actions.pause")}</button></Show>
        <Show when={props.run.status === "paused" || props.run.status === "interrupted"}><button type="button" class="workflow-button workflow-button-primary" disabled={busy()} onClick={() => void action(() => resumeWorkflowRun(props.instanceId, props.run.id))}>{t("instanceShell.workflows.actions.resume")}</button></Show>
        <Show when={props.run.status === "recovery_required"}><button type="button" class="workflow-button workflow-button-primary" disabled={busy()} onClick={() => void recover()}>{t("instanceShell.workflows.actions.confirmRecovery")}</button></Show>
        <Show when={cancellable()}><button type="button" class="workflow-button workflow-button-danger" disabled={busy()} onClick={() => void cancel()}>{t("instanceShell.workflows.actions.cancel")}</button></Show>
      </div>
      </Show>
      </div>
    </article>
  )
}

const RUN_PAGE_SIZE = 10

const WorkflowRunList: Component<WorkflowRunListProps> = (props) => {
  const [expandedId, setExpandedId] = createSignal("")
  const [visibleCount, setVisibleCount] = createSignal(RUN_PAGE_SIZE)
  const visibleRuns = createMemo(() => props.runs.slice(0, visibleCount()))
  createEffect(() => {
    if (expandedId() && !props.runs.some(({ id }) => id === expandedId())) setExpandedId("")
  })
  return (
    <div class="workflow-run-list">
      <For each={visibleRuns()}>{(run) => (
        <WorkflowRunCard
          {...props}
          run={run}
          expanded={expandedId() === run.id}
          onToggle={() => setExpandedId((current) => current === run.id ? "" : run.id)}
        />
      )}</For>
      <Show when={props.runs.length > visibleRuns().length}>
        <button type="button" class="workflow-button workflow-history-more" onClick={() => setVisibleCount((count) => count + RUN_PAGE_SIZE)}>
          {props.t("instanceShell.workflows.history.showMore", { count: Math.min(RUN_PAGE_SIZE, props.runs.length - visibleRuns().length) })}
        </button>
      </Show>
    </div>
  )
}

export default WorkflowRunList
