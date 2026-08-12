import { Show, createEffect, createMemo, createSignal, type Component } from "solid-js"
import { ApiRequestError, serverApi } from "../../../../../lib/api-client"
import { showConfirmDialog } from "../../../../../stores/alerts"
import {
  createWorkflowDefinition,
  deleteWorkflowDefinition,
  getWorkflowDeclarativeDraft,
  loadWorkflowDefinitions,
  reloadWorkflowDefinition,
  setWorkflowDeclarativeDraft,
  startWorkflowDefinition,
  updateWorkflowDefinition,
  workflowDefinitions,
  workflowDefinitionsError,
  workflowDefinitionsLoading,
  workflowDefinitionTombstones,
} from "../../../../../stores/workflows"
import { formatWorkflowError, parseWorkflowObject } from "./workflow-helpers"
import type { WorkflowBuilderProps } from "./workflow-types"

const DeclarativeWorkflowBuilder: Component<WorkflowBuilderProps> = (props) => {
  const sample = () => JSON.stringify({
    version: 1,
    id: "my-workflow",
    name: props.t("instanceShell.workflows.declarative.sample.name"),
    root: {
      id: "work",
      type: "agent",
      instructions: props.t("instanceShell.workflows.declarative.sample.instructions"),
    },
  }, null, 2)
  const draft = getWorkflowDeclarativeDraft(props.instanceId)
  const [selectedId, setSelectedId] = createSignal(draft?.selectedDefinitionId ?? "")
  const [baselineRevision, setBaselineRevision] = createSignal(draft?.baselineRevision)
  const [source, setSource] = createSignal(draft?.source ?? sample())
  const [objective, setObjective] = createSignal(draft?.objective ?? "")
  const [inputs, setInputs] = createSignal(draft?.inputs ?? "{}")
  const [busy, setBusy] = createSignal("")
  const [notice, setNotice] = createSignal("")
  const [conflict, setConflict] = createSignal(false)
  const selected = createMemo(() => workflowDefinitions().find(({ id }) => id === selectedId()))
  const stale = createMemo(() => Boolean(selected() && baselineRevision() !== selected()!.revision))

  const clearDeletedDraft = () => {
    setSelectedId("")
    setBaselineRevision(undefined)
    setSource("")
    setObjective("")
    setInputs("{}")
    setNotice("")
    setConflict(false)
  }

  createEffect(() => setWorkflowDeclarativeDraft(props.instanceId, {
    selectedDefinitionId: selectedId(), baselineRevision: baselineRevision(), source: source(), objective: objective(), inputs: inputs(),
  }))
  createEffect(() => {
    if (stale()) setConflict(true)
  })
  createEffect(() => {
    const id = selectedId()
    if (id && workflowDefinitionTombstones().has(id)) clearDeletedDraft()
  })

  const fail = (error: unknown) => {
    if (error instanceof ApiRequestError && error.status === 409) {
      setConflict(true)
      void loadWorkflowDefinitions()
      props.onError(props.t("instanceShell.workflows.declarative.conflict"))
      return
    }
    if (error instanceof Error && error.message === "workflow_definition_stale") {
      setConflict(true)
      props.onError(props.t("instanceShell.workflows.declarative.conflict"))
      return
    }
    props.onError(formatWorkflowError(error, props.t))
  }

  const perform = async (name: string, action: () => Promise<void>) => {
    setBusy(name)
    setNotice("")
    props.onError("")
    try { await action() } catch (error) { fail(error) } finally { setBusy("") }
  }

  const choose = (id: string) => {
    setSelectedId(id)
    const record = workflowDefinitions().find((definition) => definition.id === id)
    setBaselineRevision(record?.revision)
    setSource(record?.canonical ?? sample())
    setNotice("")
    setConflict(false)
  }

  const validate = () => perform("validate", async () => {
    const result = await serverApi.validateWorkflowDefinition(source())
    if (result.valid) {
      setNotice(props.t("instanceShell.workflows.declarative.validationValid"))
      return
    }
    setNotice(result.issues.map((issue) => {
      const path = issue.path?.length ? `${issue.path.join(".")}: ` : ""
      return `${path}${issue.message}`
    }).join("\n"))
  })

  const create = () => perform("save", async () => {
    const record = await createWorkflowDefinition(source())
    setSelectedId(record.id)
    setBaselineRevision(record.revision)
    setConflict(false)
    setSource(record.canonical)
    setNotice(props.t("instanceShell.workflows.declarative.created", { revision: record.revision }))
  })

  const update = () => {
    const record = selected()
    if (!record || conflict() || stale()) return
    void perform("save", async () => {
      const updated = await updateWorkflowDefinition(record.id, baselineRevision()!, source())
      setBaselineRevision(updated.revision)
      setConflict(false)
      setSource(updated.canonical)
      setNotice(props.t("instanceShell.workflows.declarative.updated", { revision: updated.revision }))
    })
  }

  const reload = () => {
    const id = selectedId()
    if (!id) return
    void perform("reload", async () => {
      const latest = await reloadWorkflowDefinition(id)
      setBaselineRevision(latest.revision)
      setConflict(false)
      setSource(latest.canonical)
      setNotice(props.t("instanceShell.workflows.declarative.reloaded", { revision: latest.revision }))
    })
  }

  const remove = async () => {
    const record = selected()
    if (!record || conflict() || stale()) return
    const confirmed = await showConfirmDialog(props.t("instanceShell.workflows.declarative.deleteConfirm", { name: record.definition.name }), {
      variant: "warning",
      confirmLabel: props.t("instanceShell.workflows.declarative.delete"),
      cancelLabel: props.t("instanceShell.workflows.declarative.keepDefinition"),
      dismissible: false,
    })
    if (!confirmed) return
    await perform("delete", async () => {
      await deleteWorkflowDefinition(record.id, record.revision)
      clearDeletedDraft()
      setNotice(props.t("instanceShell.workflows.declarative.deleted"))
    })
  }

  const start = async (event: SubmitEvent) => {
    event.preventDefault()
    const record = selected()
    if (!record || conflict() || stale()) return
    await perform("start", async () => {
      let parsedInputs: Record<string, unknown> | undefined
      try { parsedInputs = parseWorkflowObject(inputs()) } catch (error) {
        const key = error instanceof SyntaxError
          ? "instanceShell.workflows.declarative.inputsInvalid"
          : error instanceof Error && error.message === "input_too_large"
            ? "instanceShell.workflows.declarative.inputsTooLarge"
            : error instanceof Error && error.message === "input_too_deep"
              ? "instanceShell.workflows.declarative.inputsTooDeep"
              : "instanceShell.workflows.declarative.inputsObject"
        throw new Error(props.t(key))
      }
      const sessionId = props.activeSessionId()
      await startWorkflowDefinition(
        props.instanceId,
        record.id,
        baselineRevision()!,
        objective().trim() || undefined,
        parsedInputs,
        sessionId && sessionId !== "info" ? sessionId : undefined,
      )
      setNotice(props.t("instanceShell.workflows.declarative.started"))
    })
  }

  return (
    <form class="workflow-form" onSubmit={start}>
      <label class="workflow-field">
        <span>{props.t("instanceShell.workflows.declarative.savedDefinitions")}</span>
        <select value={selectedId()} onChange={(event) => choose(event.currentTarget.value)} disabled={workflowDefinitionsLoading()}>
          <option value="">{props.t("instanceShell.workflows.declarative.newDefinition")}</option>
          {workflowDefinitions().map((record) => <option value={record.id}>{props.t("instanceShell.workflows.declarative.savedDefinitionOption", { name: record.definition.name, revision: record.revision })}</option>)}
        </select>
      </label>
      <Show when={workflowDefinitionsError()}>{(error) => <div class="workflow-error" role="alert">{formatWorkflowError(error(), props.t)}</div>}</Show>
      <label class="workflow-field">
        <span>{props.t("instanceShell.workflows.declarative.source")}</span>
        <textarea class="workflow-source" required spellcheck={false} value={source()} onInput={(event) => setSource(event.currentTarget.value)} rows={18} />
      </label>
      <div class="workflow-builder-actions workflow-action-wrap">
        <button type="button" class="workflow-button" onClick={() => void validate()} disabled={Boolean(busy())}>{props.t("instanceShell.workflows.declarative.validate")}</button>
        <Show when={!selected()} fallback={<button type="button" class="workflow-button workflow-button-primary" onClick={update} disabled={Boolean(busy()) || conflict() || stale()}>{props.t("instanceShell.workflows.declarative.update")}</button>}>
          <button type="button" class="workflow-button workflow-button-primary" onClick={() => void create()} disabled={Boolean(busy()) || !source().trim()}>{props.t("instanceShell.workflows.declarative.create")}</button>
        </Show>
        <Show when={selected()}>
          <button type="button" class="workflow-button" onClick={reload} disabled={Boolean(busy())}>{props.t("instanceShell.workflows.declarative.reload")}</button>
          <button type="button" class="workflow-button workflow-button-danger" onClick={() => void remove()} disabled={Boolean(busy()) || conflict() || stale()}>{props.t("instanceShell.workflows.declarative.delete")}</button>
        </Show>
      </div>
      <Show when={conflict()}><div class="workflow-conflict" role="alert">{props.t("instanceShell.workflows.declarative.conflictHelp")}</div></Show>
      <Show when={notice()}><pre class="workflow-notice" role="status">{notice()}</pre></Show>
      <fieldset class="workflow-start-fields" disabled={!selected() || Boolean(busy()) || conflict() || stale()}>
        <legend>{props.t("instanceShell.workflows.declarative.startSaved")}</legend>
        <label class="workflow-field">
          <span>{props.t("instanceShell.workflows.objective.label")}</span>
          <textarea value={objective()} onInput={(event) => setObjective(event.currentTarget.value)} placeholder={props.t("instanceShell.workflows.declarative.objectiveOptional")} rows={3} />
        </label>
        <label class="workflow-field">
          <span>{props.t("instanceShell.workflows.declarative.inputs")}</span>
          <textarea class="workflow-source" spellcheck={false} value={inputs()} onInput={(event) => setInputs(event.currentTarget.value)} rows={5} />
        </label>
        <button type="submit" class="workflow-button workflow-button-primary">{props.t(busy() === "start" ? "instanceShell.workflows.actions.starting" : "instanceShell.workflows.actions.start")}</button>
      </fieldset>
    </form>
  )
}

export default DeclarativeWorkflowBuilder
