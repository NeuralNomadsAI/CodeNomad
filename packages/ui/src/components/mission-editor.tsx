import { For, Show, createSignal } from "solid-js"
import type { MissionMap } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { HttpResponseError } from "../lib/retryable-file-search"
import { useI18n } from "../lib/i18n"

export interface MissionEditorAction { kind: "create" | "edit" | "delete"; mission?: MissionMap }

export function MissionEditor(props: {
  instanceId: string; directory?: string; action: MissionEditorAction
  onSaved: (mission?: MissionMap) => void; onCancel: () => void
}) {
  const { t } = useI18n()
  // The revision and draft belong to this editor, not to live snapshot refreshes.
  const original = props.action.mission
  const kind = props.action.kind
  const [objective, setObjective] = createSignal(original?.objective ?? "")
  const [notes, setNotes] = createSignal(original?.notes ?? "")
  const [template, setTemplate] = createSignal<MissionMap["template"]>("custom")
  const [deleteManagedSessions, setDeleteManagedSessions] = createSignal(false)
  const [deleteAttempted, setDeleteAttempted] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal("")
  let requestId = crypto.randomUUID(), lastPayload = ""

  async function save(event: SubmitEvent) {
    event.preventDefault()
    if (pending()) return
    const fields = { objective: objective().trim(), notes: notes(), template: template() }
    const payload = JSON.stringify(kind === "delete" ? { deleteManagedSessions: deleteManagedSessions() } : fields)
    if (lastPayload && lastPayload !== payload) requestId = crypto.randomUUID()
    lastPayload = payload
    setPending(true)
    setError("")
    try {
      if (kind === "delete" && original) {
        // A failed acknowledgement may follow a committed tombstone. Keep its
        // immutable request available for retry even after the list refreshes.
        setDeleteAttempted(true)
        await serverApi.deleteMission(props.instanceId, original.id, { expectedRevision: original.revision, requestId, deleteManagedSessions: deleteManagedSessions() })
        props.onSaved()
      } else {
        const result = kind === "edit" && original
          ? await serverApi.editMission(props.instanceId, original.id, { objective: fields.objective, notes: fields.notes, expectedRevision: original.revision, requestId })
          : await serverApi.createMission(props.instanceId, { ...fields, directory: props.directory, requestId })
        props.onSaved(result.mission)
      }
    } catch (error) {
      setError(t(error instanceof HttpResponseError && error.status === 409
        ? "missions.control.mutation.conflict" : kind === "delete" ? "missions.control.delete.error" : "missions.control.mutation.error"))
    } finally { setPending(false) }
  }

  return <form class="mission-editor window-shell" onSubmit={save} aria-label={t(`missions.control.${kind}`)}>
    <header class="window-header"><h3 class="window-title">{t(`missions.control.${kind}`)}</h3></header>
    <div class="window-body">
      <Show when={kind !== "delete"} fallback={<>
        <p>{t("missions.control.delete.detail")}</p>
        <label class="mission-delete-sessions"><input type="checkbox" checked={deleteManagedSessions()} disabled={pending() || deleteAttempted()}
          onChange={event => setDeleteManagedSessions(event.currentTarget.checked)} />{t("missions.control.delete.sessions")}</label>
      </>}>
        <label>{t("missions.control.objective")}
          <textarea required maxLength={20_000} value={objective()} disabled={pending()} onInput={e => setObjective(e.currentTarget.value)} />
        </label>
        <label>{t("missions.control.notes")}
          <textarea maxLength={20_000} value={notes()} disabled={pending()} onInput={e => setNotes(e.currentTarget.value)} />
        </label>
        <Show when={kind === "create"}>
          <label>{t("missions.control.template")}
            <select value={template()} disabled={pending()} onChange={e => setTemplate(e.currentTarget.value as MissionMap["template"])}>
              <For each={["custom", "wayfinder", "pocock-fix-bug"] as const}>{id => <option value={id}>{t(`missions.control.template.${id}`)}</option>}</For>
            </select>
          </label>
          <p>{t("missions.control.create.detail")}</p>
        </Show>
      </Show>
      <Show when={error()}><p role="alert">{error()}</p></Show>
    </div>
    <footer class="window-footer">
      <button type="button" class="button-secondary" disabled={pending()} onClick={props.onCancel}>{t("missions.control.cancel")}</button>
      <button type="submit" class="button-primary" disabled={pending() || (kind !== "delete" && !objective().trim())}>
        {t(pending() ? "missions.control.mutation.pending" : kind === "delete" ? "missions.control.delete" : "missions.control.save")}
      </button>
    </footer>
  </form>
}
