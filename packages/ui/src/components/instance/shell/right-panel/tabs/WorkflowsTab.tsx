import { Show, createEffect, createMemo, createSignal, onMount, type Component } from "solid-js"
import { RefreshCw } from "lucide-solid"
import { useI18n } from "../../../../../lib/i18n"
import { selectInstanceTab } from "../../../../../stores/app-tabs"
import { instances } from "../../../../../stores/instances"
import { hydrateRestoredSessionChain, setActiveSessionFromList } from "../../../../../stores/sessions"
import {
  getWorkflowRuns,
  loadWorkflowDefinitions,
  loadWorkflowRuns,
  workflowErrors,
  workflowLoading,
  workflowStatusTransitions,
} from "../../../../../stores/workflows"
import DeclarativeWorkflowBuilder from "./DeclarativeWorkflowBuilder"
import SimpleWorkflowBuilder from "./SimpleWorkflowBuilder"
import WorkflowRunList from "./WorkflowRunList"
import { formatWorkflowError, resolveWorkflowRunWorkspaceId } from "./workflow-helpers"
import type { WorkflowTabProps } from "./workflow-types"

type WorkflowMode = "simple" | "declarative"
const savedModes = new Map<string, WorkflowMode>()

const WorkflowsTab: Component<WorkflowTabProps> = (props) => {
  const { locale } = useI18n()
  const [mode, setModeSignal] = createSignal<WorkflowMode>(savedModes.get(props.instanceId) ?? "simple")
  const [actionError, setActionError] = createSignal("")
  const [statusAnnouncement, setStatusAnnouncement] = createSignal("")
  const runs = createMemo(() => getWorkflowRuns(props.instanceId))
  const loading = createMemo(() => workflowLoading().get(props.instanceId) ?? false)
  const loadError = createMemo(() => {
    const error = workflowErrors().get(props.instanceId)
    return error ? formatWorkflowError(error, props.t) : ""
  })
  const setMode = (next: WorkflowMode) => {
    savedModes.set(props.instanceId, next)
    setModeSignal(next)
  }

  createEffect(() => {
    if (!props.active()) return
    const transition = workflowStatusTransitions().get(props.instanceId)
    if (!transition) return
    setStatusAnnouncement("")
    queueMicrotask(() => {
      if (props.active()) setStatusAnnouncement(props.t("instanceShell.workflows.live.statusChanged", {
        status: props.t(`instanceShell.workflows.status.${transition.status}`),
      }))
    })
  })

  onMount(() => {
    void loadWorkflowRuns(props.instanceId)
    void loadWorkflowDefinitions()
  })

  const openSession = async (run: Parameters<typeof resolveWorkflowRunWorkspaceId>[0], sessionId: string) => {
    setActionError("")
    try {
      const workspaceId = resolveWorkflowRunWorkspaceId(run, instances())
      if (!workspaceId) {
        setActionError(props.t("instanceShell.workflows.errors.workspaceUnavailable"))
        return
      }
      await hydrateRestoredSessionChain(workspaceId, [sessionId])
      setActiveSessionFromList(workspaceId, sessionId)
      selectInstanceTab(workspaceId)
    } catch {
      setActionError(props.t("instanceShell.workflows.errors.openSession"))
    }
  }

  return (
    <div class="workflow-tab">
      <div class="sr-only" aria-live="polite" aria-atomic="true">{statusAnnouncement()}</div>
      <section class="workflow-builder" aria-labelledby="workflow-builder-title">
        <div class="workflow-section-heading">
          <div>
            <h2 id="workflow-builder-title">{props.t(mode() === "simple" ? "instanceShell.workflows.builder.title" : "instanceShell.workflows.declarative.title")}</h2>
            <p>{props.t(mode() === "simple" ? "instanceShell.workflows.builder.description" : "instanceShell.workflows.declarative.description")}</p>
          </div>
        </div>
        <div class="workflow-mode-switch" role="group" aria-label={props.t("instanceShell.workflows.mode.label")}>
          <button type="button" class="workflow-button" classList={{ "workflow-button-primary": mode() === "simple" }} aria-pressed={mode() === "simple"} onClick={() => setMode("simple")}>{props.t("instanceShell.workflows.mode.simple")}</button>
          <button type="button" class="workflow-button" classList={{ "workflow-button-primary": mode() === "declarative" }} aria-pressed={mode() === "declarative"} onClick={() => setMode("declarative")}>{props.t("instanceShell.workflows.mode.declarative")}</button>
        </div>
        <Show when={mode() === "simple"} fallback={<DeclarativeWorkflowBuilder {...props} onError={setActionError} />}>
          <SimpleWorkflowBuilder {...props} onError={setActionError} />
        </Show>
      </section>

      <section class="workflow-history" aria-labelledby="workflow-history-title">
        <div class="workflow-section-heading">
          <div><h2 id="workflow-history-title">{props.t("instanceShell.workflows.history.title")}</h2><p>{props.t("instanceShell.workflows.history.description")}</p></div>
          <button type="button" class="workflow-icon-button" onClick={() => void loadWorkflowRuns(props.instanceId)} disabled={loading()} aria-label={props.t("instanceShell.workflows.actions.refresh")}><RefreshCw aria-hidden="true" /></button>
        </div>
        <Show when={actionError() || loadError()}><div class="workflow-error" role="alert">{actionError() || loadError()}</div></Show>
        <Show when={loading() && runs().length === 0}><div class="workflow-state">{props.t("instanceShell.workflows.history.loading")}</div></Show>
        <Show when={!loading() && !loadError() && runs().length === 0}><div class="workflow-state">{props.t("instanceShell.workflows.history.empty")}</div></Show>
        <WorkflowRunList instanceId={props.instanceId} runs={runs()} locale={locale()} t={props.t} onError={setActionError} onOpenSession={(run, id) => void openSession(run, id)} />
      </section>
    </div>
  )
}

export default WorkflowsTab
