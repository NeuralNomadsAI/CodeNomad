import { For, Show, createSignal } from "solid-js"
import type { MissionMap } from "../../../server/src/api-types"
import type { MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { deletionErrorKey, MissionDeletionError } from "../lib/mission-cleanup"
import { missionStore } from "../stores/missions"
import { createMissionViewFence } from "../lib/mission-view-fence"
import { isUncertainCreation, missionMutationErrorKey } from "../lib/mission-mutation"
import { copyMissionProfiles, missionCreationPayloadIdentity, retainUncertainMissionCreation, uncertainMissionCreation } from "../stores/mission-creation-drafts"
import { MissionProfileControls } from "./mission-profile-controls"
import { profilesForTemplate } from "./mission-profile-controls-data"

export interface MissionEditorAction { kind: "create" | "edit" | "delete"; mission?: MissionMap }

export function MissionEditor(props: {
  instanceId: string; directory?: string; viewDirectory?: string; projectID?: string; action: MissionEditorAction
  active?: () => boolean
  captureOperation?: () => (() => boolean)
  onSaved: (mission?: MissionMap) => void; onCancel: () => void
}) {
  const { t } = useI18n()
  // The revision and draft belong to this editor, not to live snapshot refreshes.
  const action = props.action, original = action.mission, kind = action.kind
  // The UI's physical folder fences the view; it must not replace the server's
  // existing native default location (notably on WSL) in the creation request.
  const identity = () => JSON.stringify([props.instanceId, props.viewDirectory ?? props.directory, props.projectID])
  const captureView = createMissionViewFence(identity, () => props.active?.() ?? true)
  const held = kind === "create" ? uncertainMissionCreation(identity()) : undefined
  const [objective, setObjective] = createSignal(held?.objective ?? original?.objective ?? "")
  const [notes, setNotes] = createSignal(held?.notes ?? original?.notes ?? "")
  const [template, setTemplate] = createSignal<MissionMap["template"]>(held?.template ?? "custom")
  const [profiles, setProfiles] = createSignal<MissionProfiles | undefined>(copyMissionProfiles(held?.profiles))
  const [uncertain, setUncertain] = createSignal(Boolean(held))
  const [deleteManagedSessions, setDeleteManagedSessions] = createSignal(false)
  const [deleteAttempted, setDeleteAttempted] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal("")
  let requestId = held?.requestId ?? crypto.randomUUID(), lastPayload = ""

  async function save(event: SubmitEvent) {
    event.preventDefault()
    if (pending() || uncertain() || !(props.active?.() ?? true)) return
    // A hold learned after this editor opened still cannot become a new logical
    // creation merely because the user submits another draft in the same scope.
    if (kind === "create" && uncertainMissionCreation(identity())) { setUncertain(true); return }
    const origin = identity(), directory = props.directory, instanceId = props.instanceId
    const viewCurrent = captureView()
    const operationCurrent = props.captureOperation?.() ?? (() => true)
    const current = () => viewCurrent() && operationCurrent() && props.action === action
    const fields = { objective: objective().trim(), notes: notes(), template: template(),
      ...(kind === "create" && profiles() !== undefined ? { profiles: copyMissionProfiles(profiles()) } : {}) }
    const payload = kind === "create" ? missionCreationPayloadIdentity({ ...fields, directory })
      : JSON.stringify(kind === "delete" ? { deleteManagedSessions: deleteManagedSessions() } : fields)
    if (lastPayload && lastPayload !== payload) requestId = crypto.randomUUID()
    lastPayload = payload
    setPending(true)
    setError("")
    const creation = { ...fields, requestId, objective: objective(), directory }
    try {
      if (kind === "delete" && original) {
        // A failed acknowledgement may follow a committed tombstone. Keep its
        // immutable request available for retry even after the list refreshes.
        if (deleteAttempted()) {
          const snapshot = await serverApi.fetchMissions(instanceId)
          if (!current()) return
          if (!snapshot.available || snapshot.cleanupUnavailable) throw new MissionDeletionError(503)
          const intent = snapshot.cleanups?.find(item => item.missionID === original.id && item.requestID === requestId
            && item.expectedRevision === original.revision && item.deleteManagedSessions === deleteManagedSessions())
          if (intent && intent.pending === 0) { props.onSaved(); return }
          if (!intent && !snapshot.missions.some(item => item.id === original.id && item.revision === original.revision)) {
            throw new MissionDeletionError(404)
          }
        }
        setDeleteAttempted(true)
        await serverApi.deleteMission(instanceId, original.id, { expectedRevision: original.revision, requestId, deleteManagedSessions: deleteManagedSessions() })
        if (current()) props.onSaved()
      } else {
        const result = kind === "edit" && original
          ? await serverApi.editMission(instanceId, original.id, { objective: fields.objective, notes: fields.notes, expectedRevision: original.revision, requestId })
          : await serverApi.createMission(instanceId, { ...fields, directory, requestId })
        if (current()) props.onSaved(result.mission)
        else if (identity() === origin && missionStore.demandedInstanceIds().includes(instanceId)) void missionStore.refresh(instanceId)
      }
    } catch (error) {
      if (kind === "create" && isUncertainCreation(error)) retainUncertainMissionCreation(origin, creation)
      if (!current()) return
      if (kind === "delete" && original) {
        // Reads can settle a lost HTTP acknowledgement, but never replay a write.
        // Unknown intent keeps the original option/request fenced until verified.
        let key = deletionErrorKey(error)
        try {
          const snapshot = await serverApi.fetchMissions(instanceId)
          if (!current()) return
          const intent = snapshot.available && !snapshot.cleanupUnavailable && snapshot.cleanups?.find(item => item.missionID === original.id && item.requestID === requestId
            && item.expectedRevision === original.revision && item.deleteManagedSessions === deleteManagedSessions())
          if (intent && intent.pending === 0) { props.onSaved(); return }
          if (intent) key = "missions.cleanup.error.pending"
          else if (snapshot.available && !snapshot.cleanupUnavailable && snapshot.missions.some(item => item.id === original.id)
            && error instanceof MissionDeletionError && [400, 403, 409].includes(error.status)) setDeleteAttempted(false)
        } catch { /* Unknown observation is not permission to change the intent. */ }
        if (current()) { setError(t(key)); void missionStore.refresh(instanceId) }
      } else {
        if (kind === "create" && isUncertainCreation(error)) setUncertain(true)
        else setError(t(missionMutationErrorKey(error)))
      }
    } finally { if (current()) setPending(false) }
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
          <textarea required maxLength={20_000} value={objective()} disabled={pending() || uncertain()} onInput={e => setObjective(e.currentTarget.value)} />
        </label>
        <label>{t("missions.control.notes")}
          <textarea maxLength={20_000} value={notes()} disabled={pending() || uncertain()} onInput={e => setNotes(e.currentTarget.value)} />
        </label>
        <Show when={kind === "create"}>
          <label>{t("missions.control.template")}
            <select aria-label={t("missions.control.template")} value={template()} disabled={pending() || uncertain()} onChange={e => {
              const next = e.currentTarget.value as MissionMap["template"]
              setTemplate(next); setProfiles(profilesForTemplate(profiles(), next))
            }}>
              <For each={["custom", "wayfinder", "pocock-fix-bug"] as const}>{id => <option value={id}>{t(`missions.control.template.${id}`)}</option>}</For>
            </select>
          </label>
          <MissionProfileControls instanceId={props.instanceId} directory={props.directory} template={template()} profiles={profiles()}
            disabled={pending() || uncertain()} active={() => props.active?.() ?? true} onChange={setProfiles} />
          <p>{t("missions.control.create.detail")}</p>
        </Show>
      </Show>
      <Show when={uncertain()} fallback={<Show when={error()}><p role="alert">{error()}</p></Show>}><p role="alert">{t("missions.control.creation.uncertain")}</p></Show>
    </div>
    <footer class="window-footer">
      <button type="button" class="button-secondary" onClick={props.onCancel}>{t("missions.control.cancel")}</button>
      <Show when={uncertain()}><button type="button" class="button-secondary" onClick={() => void missionStore.refresh(props.instanceId)}>{t("missions.control.refresh")}</button></Show>
      <button type="submit" class="button-primary" disabled={pending() || uncertain() || !(props.active?.() ?? true) || (kind !== "delete" && !objective().trim())}>
        {t(pending() ? "missions.control.mutation.pending" : kind === "delete" ? "missions.control.delete" : "missions.control.save")}
      </button>
    </footer>
  </form>
}
