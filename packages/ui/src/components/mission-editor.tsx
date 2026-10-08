import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup } from "solid-js"
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
import { missionProfileRoles, profilesForTemplate } from "./mission-profile-controls-data"
import { useConfig } from "../stores/preferences"
import { missionDefaultsFor, missionTaskModeFor, normalizeMissionDefaults, type MissionTaskMode } from "../lib/mission-defaults"
import type { MissionProfileDefault } from "../lib/mission-defaults"
import { retainSubmittedMissionModel, submittedMissionModel, type UserMissionModel } from "../lib/mission-model-library"
import { MissionModelLibrary } from "./mission-model-library"
import { MissionProfileSummary } from "./mission-profile-summary"
import { MissionTaskModeControls } from "./mission-task-mode-controls"
import { holdRecurrence, uncertainRecurrence } from "../stores/mission-recurrence"
import { HttpResponseError } from "../lib/retryable-file-search"
import { MISSION_LIFECYCLE_TEXT_LIMIT, recurrenceStartText } from "../../../server/src/missions/lifecycle-input"
import { recurrenceInputBudget } from "../../../server/src/missions/recurrence-read-budget"
import { getRootClient } from "../stores/opencode-client"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { createRequestLocation, requestLocationOptions, toRequestLocation } from "../stores/request-locations"
import { MissionConversationPicker } from "./mission-conversation-picker"

export interface MissionEditorAction { kind: "create" | "edit" | "delete"; mission?: MissionMap }

export function MissionEditor(props: {
  instanceId: string; directory?: string; viewDirectory?: string; projectID?: string; action: MissionEditorAction
  active?: () => boolean
  captureOperation?: () => (() => boolean)
  onSaved: (mission?: MissionMap) => void; onCancel: () => void
  onOpenPreferences?: () => void
  onRecurrenceSaved?: () => void
  onRecurrenceRefresh?: () => void
}) {
  const { t } = useI18n()
  const zoneErrorId = createUniqueId()
  const config = useConfig()
  // The revision and draft belong to this editor, not to live snapshot refreshes.
  const action = props.action, original = action.mission, kind = action.kind
  // The UI's physical folder fences the view; it must not replace the server's
  // existing native default location (notably on WSL) in the creation request.
  const identity = () => JSON.stringify([props.instanceId, props.viewDirectory ?? props.directory, props.projectID])
  const captureView = createMissionViewFence(identity, () => props.active?.() ?? true)
  const held = kind === "create" ? uncertainMissionCreation(identity()) : undefined
  const recurrenceHold = kind === "create" ? uncertainRecurrence(identity()) : undefined
  const [mode, setMode] = createSignal<"once" | "recurring">(recurrenceHold ? "recurring" : "once")
  const [titleOverride, setTitleOverride] = createSignal<string | undefined>(recurrenceHold && "title" in recurrenceHold && typeof recurrenceHold.title === "string" ? recurrenceHold.title : undefined)
  const [time, setTime] = createSignal(recurrenceHold?.clock.time ?? "09:00")
  const [zone, setZone] = createSignal(recurrenceHold?.clock.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const zoneValid = createMemo(() => {
    if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(zone().trim())) return false
    try { new Intl.DateTimeFormat(undefined, { timeZone: zone().trim() }); return true } catch { return false }
  })
  const [watched, setWatched] = createSignal<string[]>(recurrenceHold?.watchedConversationIDs ?? [])
  const [objective, setObjective] = createSignal(recurrenceHold?.instructions ?? held?.objective ?? original?.objective ?? "")
  const instructions = objective
  const title = () => titleOverride() ?? instructions().split(/\r?\n/, 1)[0].trim().slice(0, 200)
  const [notes, setNotes] = createSignal(recurrenceHold?.notes ?? held?.notes ?? original?.notes ?? "")
  const [template, setTemplate] = createSignal<MissionMap["template"]>(recurrenceHold?.template ?? held?.template ?? "custom")
  const [profiles, setProfiles] = createSignal<MissionProfiles | undefined>(copyMissionProfiles(recurrenceHold?.profiles ?? held?.profiles))
  const [customProfiles, setCustomProfiles] = createSignal(Boolean(held || recurrenceHold))
  const [taskMode, setTaskMode] = createSignal<MissionTaskMode | undefined>(recurrenceHold?.taskMode ?? held?.taskMode ?? "native")
  const [customTaskMode, setCustomTaskMode] = createSignal(Boolean(held || recurrenceHold))
  const [defaults, setDefaults] = createSignal<MissionProfileDefault[]>([])
  const [defaultsReady, setDefaultsReady] = createSignal(kind !== "create" || Boolean(held || recurrenceHold))
  const [defaultsRefreshing, setDefaultsRefreshing] = createSignal(false)
  const [defaultsFailed, setDefaultsFailed] = createSignal(false)
  const creationReady = () => defaultsReady() && (kind !== "create" || Boolean(held || recurrenceHold) || config.isUiConfigLoaded())
  const [profileDetailsOpen, setProfileDetailsOpen] = createSignal(false)
  const [modelDetailsOpen, setModelDetailsOpen] = createSignal(false)
  const [selectedModel, setSelectedModel] = createSignal<Pick<UserMissionModel, "id" | "name"> | undefined>(held ? submittedMissionModel(held.requestId)
    : recurrenceHold ? submittedMissionModel(recurrenceHold.requestID) : undefined)
  // One creation-time snapshot only, after the owned preference document loads.
  // Refreshes and other windows' preference edits never replace this draft.
  createEffect(() => {
    if (defaultsReady() || !config.isUiConfigLoaded() || !config.missionDefaultsValid()) return
    const loaded = normalizeMissionDefaults(config.preferences().missionProfileDefaults)
    setDefaults(loaded); setProfiles(missionDefaultsFor(loaded, template())); setTaskMode(missionTaskModeFor(loaded, template()))
    setDefaultsReady(true)
  })
  const [uncertain, setUncertain] = createSignal(Boolean(held || recurrenceHold))
  const [deleteManagedSessions, setDeleteManagedSessions] = createSignal(false)
  const [deleteAttempted, setDeleteAttempted] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal("")
  const watchedIDs = watched
  const needsSourceLocation = createMemo(() => mode() === "recurring" && watchedIDs().length > 0)
  const sourceIdentity = () => JSON.stringify([identity(), props.directory, getOpenCodeInstanceGeneration(props.instanceId)])
  const [sourceLocation, setSourceLocation] = createSignal<{ key: string; directory: string }>()
  const [sourceLocationFailed, setSourceLocationFailed] = createSignal(false)
  const [sourceLocationRevision, setSourceLocationRevision] = createSignal(0)
  createEffect(() => {
    sourceLocationRevision()
    if (!needsSourceLocation() || !creationReady() || !(props.active?.() ?? true)) return
    const key = sourceIdentity(), viewCurrent = captureView(), controller = new AbortController()
    let alive = true
    setSourceLocation(undefined); setSourceLocationFailed(false)
    const location = createRequestLocation(props.directory)
    const current = () => alive && viewCurrent() && sourceIdentity() === key
    void getRootClient(props.instanceId).location.get({ location: toRequestLocation(location) }, {
      ...requestLocationOptions(location), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    }).then(value => {
      if (!current()) return
      if (!value.directory || value.directory.length > 4096 || value.directory.includes("\0")
        || props.projectID && value.project.id !== props.projectID) throw new Error("Native source Location differs")
      setSourceLocation({ key, directory: value.directory })
    }).catch(() => { if (current()) setSourceLocationFailed(true) })
    onCleanup(() => { alive = false; controller.abort() })
  })
  const sourceLocationReady = () => !needsSourceLocation() || sourceLocation()?.key === sourceIdentity()
  const sourceInputBudget = () => recurrenceInputBudget({ consigne: instructions().trim(), watchedConversationIDs: watchedIDs(),
    roots: sourceLocation()?.key === sourceIdentity() ? [{ directory: sourceLocation()!.directory }] : [] })
  let requestId = held?.requestId ?? recurrenceHold?.requestID ?? crypto.randomUUID(), lastPayload = ""

  async function useSavedDefaults() {
    if (pending() || uncertain() || defaultsRefreshing() || !(props.active?.() ?? true)) return
    const current = captureView()
    setDefaultsRefreshing(true); setDefaultsFailed(false)
    try {
      await config.reloadMissionPreferences()
      if (!current()) return
      if (!config.missionDefaultsValid()) throw new Error("Invalid mission defaults")
      const loaded = normalizeMissionDefaults(config.preferences().missionProfileDefaults)
      setDefaults(loaded); setProfiles(missionDefaultsFor(loaded, template())); setTaskMode(missionTaskModeFor(loaded, template()))
      setCustomProfiles(false); setCustomTaskMode(false); setDefaultsReady(true)
    } catch { if (current()) setDefaultsFailed(true) }
    finally { if (current()) setDefaultsRefreshing(false) }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault()
    if (!creationReady() || defaultsRefreshing() || pending() || uncertain() || !(props.active?.() ?? true)) return
    const recurrence = kind === "create" && mode() === "recurring"
    if (recurrence) {
      try { recurrenceStartText({ consigne: instructions().trim(), template: template(), taskMode: taskMode() ?? "native" }) }
      catch { setError(t("missions.recurrence.instructionsTooLong", { limit: MISSION_LIFECYCLE_TEXT_LIMIT })); return }
      const held = uncertainRecurrence(identity())
      if (held || uncertainMissionCreation(identity())) { setUncertain(true); return }
      const selected = copyMissionProfiles(profiles())
      if (!selected?.coordinator?.agent || !selected.coordinator.model?.providerID || !selected.coordinator.model.id
        || missionProfileRoles[template()].some(role => !selected.roles?.[role]?.agent
          || !selected.roles[role].model?.providerID || !selected.roles[role].model?.id)) {
        setError(t("missions.recurrence.profilesRequired")); return
      }
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time()) || !zoneValid()) {
        setError(t("missions.recurrence.clockInvalid")); return
      }
      const ids = watchedIDs()
      if (ids.length > 32 || new Set(ids).size !== ids.length || ids.some(id => !/^[A-Za-z0-9_.:-]{1,240}$/.test(id))) {
        setError(t("missions.recurrence.watchedInvalid")); return
      }
      if (!sourceLocationReady()) { setError(t("missions.recurrence.sourceLocationUnavailable")); return }
      if (!sourceInputBudget().sufficient) {
        setError(t("missions.recurrence.sourceInputTooLong", { limit: MISSION_LIFECYCLE_TEXT_LIMIT })); return
      }
      const payload = { title: title().trim(), instructions: instructions().trim(), notes: notes(), template: template(), clock: { time: time(), zone: zone().trim() }, watchedConversationIDs: ids,
        profiles: selected, taskMode: taskMode() ?? "native", directory: props.directory }
      const serialized = JSON.stringify(payload)
      if (lastPayload && lastPayload !== serialized) requestId = crypto.randomUUID()
      lastPayload = serialized
      const scope = identity(), currentView = captureView(), operation = props.captureOperation?.() ?? (() => true)
      const current = () => currentView() && operation() && props.action === action
      setPending(true); setError("")
      try {
        await serverApi.createMissionRecurrence(props.instanceId, { ...payload, requestID: requestId })
        if (current()) props.onRecurrenceSaved?.()
      } catch (error) {
        if (error instanceof HttpResponseError && error.status === 503 && error.code === "recurrence-capacity") {
          if (current()) setError(t("missions.recurrence.capacity"))
          return
        }
        if (error instanceof HttpResponseError && error.status === 400) {
          if (current()) setError(error.code === "recurrence-input-capacity" ? t("missions.recurrence.sourceInputTooLong", { limit: MISSION_LIFECYCLE_TEXT_LIMIT })
            : t("missions.recurrence.invalid"))
          return
        }
        // Transport/5xx/409 can follow a committed native write. Never retry or
        // turn a list read into permission to issue a new request in this scope.
        holdRecurrence(scope, { ...payload, requestID: requestId });
        retainSubmittedMissionModel(requestId, selectedModel())
        if (current()) setUncertain(true)
      } finally { if (current()) setPending(false) }
      return
    }
    // A hold learned after this editor opened still cannot become a new logical
    // creation merely because the user submits another draft in the same scope.
    if (kind === "create" && uncertainRecurrence(identity())) { setUncertain(true); return }
    const existingHold = kind === "create" ? uncertainMissionCreation(identity()) : undefined
    if (existingHold) {
      setObjective(existingHold.objective); setNotes(existingHold.notes); setTemplate(existingHold.template)
      setProfiles(copyMissionProfiles(existingHold.profiles)); setCustomProfiles(true)
      setTaskMode(existingHold.taskMode); setCustomTaskMode(true)
      setSelectedModel(submittedMissionModel(existingHold.requestId)); setUncertain(true); return
    }
    const origin = identity(), directory = props.directory, instanceId = props.instanceId
    const viewCurrent = captureView()
    const operationCurrent = props.captureOperation?.() ?? (() => true)
    const current = () => viewCurrent() && operationCurrent() && props.action === action
    const fields = { objective: objective().trim(), notes: notes(), template: template(),
      ...(kind === "create" && taskMode() !== undefined ? { taskMode: taskMode() } : {}),
      ...(kind === "create" && profiles() !== undefined ? { profiles: copyMissionProfiles(profiles()) } : {}) }
    const payload = kind === "create" ? missionCreationPayloadIdentity({ ...fields, directory })
      : JSON.stringify(kind === "delete" ? { deleteManagedSessions: deleteManagedSessions() } : fields)
    if (lastPayload && lastPayload !== payload) requestId = crypto.randomUUID()
    lastPayload = payload
    setPending(true)
    setError("")
    const creation = { ...fields, requestId, directory }
    const modelIdentity = selectedModel()
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
      if (kind === "create" && isUncertainCreation(error)) {
        retainUncertainMissionCreation(origin, creation)
        retainSubmittedMissionModel(requestId, modelIdentity)
      }
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
        <Show when={kind === "create"}>
          <details class="mission-profile-optional" onToggle={event => setModelDetailsOpen(event.currentTarget.open)}>
            <summary>{t("missions.models.title")}</summary>
            <div hidden={!modelDetailsOpen()}>
              <MissionModelLibrary disabled={!creationReady() || defaultsRefreshing() || pending() || uncertain() || !(props.active?.() ?? true)}
                active={() => modelDetailsOpen() && (props.active?.() ?? true)}
                draft={() => ({ objective: objective(), notes: notes(), template: template(), ...(customProfiles() ? { profiles: copyMissionProfiles(profiles()) ?? {} } : {}), ...(customTaskMode() ? { taskMode: taskMode() } : {}) })}
                onUse={model => {
                  requestId = crypto.randomUUID(); lastPayload = ""; setError("")
                  setObjective(model.objective); setTitleOverride(undefined); setNotes(model.notes); setTemplate(model.template); setSelectedModel({ id: model.id, name: model.name })
                  setCustomProfiles(model.profiles !== undefined)
                  setCustomTaskMode(model.taskMode !== undefined); setTaskMode(model.taskMode ?? missionTaskModeFor(defaults(), model.template))
                  setProfiles(model.profiles === undefined ? missionDefaultsFor(defaults(), model.template) : copyMissionProfiles(model.profiles))
                }} />
            </div>
          </details>
          <Show when={selectedModel()}>{model => <p>{t("missions.models.current", { name: model().name })}</p>}</Show>
        </Show>
        <Show when={kind === "create"}><label>{t("missions.recurrence.mode")}
          <select value={mode()} disabled={pending() || uncertain()} onChange={event => setMode(event.currentTarget.value as "once" | "recurring")}>
            <option value="once">{t("missions.recurrence.once")}</option><option value="recurring">{t("missions.recurrence.recurring")}</option>
          </select></label></Show>
        <Show when={kind === "create"}>
          <label>{t("missions.control.template")}
            <select aria-label={t("missions.control.template")} value={template()} disabled={!creationReady() || defaultsRefreshing() || pending() || uncertain()} onChange={e => {
              const next = e.currentTarget.value as MissionMap["template"]
              setTemplate(next); setProfiles(customProfiles() ? profilesForTemplate(profiles(), next) : missionDefaultsFor(defaults(), next))
              if (!customTaskMode()) setTaskMode(missionTaskModeFor(defaults(), next))
            }}>
              <For each={["custom", "wayfinder", "pocock-fix-bug"] as const}>{id => <option value={id}>{t(`missions.control.template.${id}`)}</option>}</For>
            </select>
          </label>
        </Show>
        <Show when={kind === "create" && mode() === "recurring"}>
          <label>{t("missions.recurrence.scheduleTitle")}<input required maxLength={200} value={title()} disabled={pending() || uncertain()} onInput={e => setTitleOverride(e.currentTarget.value)} /></label>
          <label>{t("missions.recurrence.instructions")}<textarea required maxLength={MISSION_LIFECYCLE_TEXT_LIMIT} value={instructions()} disabled={pending() || uncertain()} onInput={e => setObjective(e.currentTarget.value)} /></label>
          <div class="mission-recurrence-clock">
            <label>{t("missions.recurrence.time")}<input type="time" required value={time()} disabled={pending() || uncertain()} onInput={e => setTime(e.currentTarget.value)} /></label>
            <label>{t("missions.recurrence.zone")}<input required maxLength={100} value={zone()} aria-label={t("missions.recurrence.zone")} aria-invalid={!zoneValid()}
              aria-describedby={!zoneValid() ? zoneErrorId : undefined} disabled={pending() || uncertain()} onInput={e => setZone(e.currentTarget.value)} />
              <Show when={!zoneValid()}><span id={zoneErrorId} role="alert">{t("missions.simple.zoneInvalid")}</span></Show></label>
          </div>
          <MissionConversationPicker instanceId={props.instanceId} directory={props.directory} projectID={props.projectID}
            value={watchedIDs()} disabled={pending() || uncertain()} active={() => mode() === "recurring" && (props.active?.() ?? true)} onChange={setWatched} />
          <Show when={needsSourceLocation() && !sourceLocationReady()}><p role={sourceLocationFailed() ? "alert" : "status"}>{t(sourceLocationFailed() ? "missions.recurrence.sourceLocationUnavailable" : "missions.control.loading")}</p></Show>
          <Show when={sourceLocationReady() && !sourceInputBudget().sufficient}><p role="alert">{t(watchedIDs().length ? "missions.recurrence.sourceInputTooLong" : "missions.recurrence.instructionsTooLong", { limit: MISSION_LIFECYCLE_TEXT_LIMIT })}</p></Show>
        </Show>
        <Show when={kind !== "create" || mode() === "once"}>
        <label>{t("missions.control.objective")}
          <textarea required maxLength={20_000} value={objective()} disabled={pending() || uncertain()} onInput={e => setObjective(e.currentTarget.value)} />
        </label>
        </Show>
        <Show when={kind === "create"}>
          <MissionTaskModeControls value={taskMode() ?? "native"} disabled={!creationReady() || defaultsRefreshing() || pending() || uncertain()}
            onChange={value => { setTaskMode(value); setCustomTaskMode(true) }} />
          <MissionProfileSummary template={template()} profiles={profiles()} />
          <details class="mission-profile-optional" onToggle={event => setProfileDetailsOpen(event.currentTarget.open)}><summary>{t("missions.defaults.creation")}</summary>
          <Show when={props.onOpenPreferences}><button type="button" class="window-text-button" title={t("missions.defaults.hint")} onClick={props.onOpenPreferences}>{t("missions.defaults.manage")}</button></Show>
          <Show when={profileDetailsOpen()}>
            <MissionProfileControls instanceId={props.instanceId} directory={props.directory} template={template()} profiles={profiles()}
              requireRoleProfiles={mode() === "recurring"}
              taskMode={taskMode()}
              disabled={!creationReady() || defaultsRefreshing() || pending() || uncertain()} active={() => profileDetailsOpen() && (props.active?.() ?? true)}
              onChange={value => { setCustomProfiles(true); setProfiles(value) }} />
          </Show>
          <button type="button" class="window-action" disabled={pending() || defaultsRefreshing() || uncertain()} onClick={() => void useSavedDefaults()}>{t("missions.defaults.use")}</button>
          </details>
          <p class="mission-editor-start-hint">{t("missions.control.creationNotice")}</p>
        </Show>
        <label>{t(kind === "edit" ? "missions.control.guidance.notes" : "missions.control.notes")}
          <textarea maxLength={20_000} value={notes()} disabled={pending() || uncertain()} onInput={e => setNotes(e.currentTarget.value)} />
        </label>
        <Show when={kind === "create" && (!defaultsReady() || defaultsFailed() || config.isUiConfigLoaded() && !config.missionDefaultsValid())}>
          <p role={config.uiConfigLoadFailed() || defaultsFailed() || config.isUiConfigLoaded() && !config.missionDefaultsValid() ? "alert" : "status"}>
            {t(config.isUiConfigLoaded() && !config.missionDefaultsValid() ? "missions.defaults.invalid"
              : config.uiConfigLoadFailed() || defaultsFailed() ? "missions.defaults.unavailable" : "missions.defaults.loading")}
          </p>
          <button type="button" class="window-action" disabled={defaultsRefreshing() || uncertain()}
            onClick={() => void useSavedDefaults()}>{t("missions.defaults.reload")}</button>
        </Show>
      </Show>
      <Show when={uncertain()} fallback={<Show when={error()}><p role="alert">{error()}</p></Show>}><p role="alert">{t("missions.control.creation.uncertain")}</p></Show>
    </div>
    <footer class="window-footer">
      <button type="button" class="button-secondary" onClick={props.onCancel}>{t("missions.control.cancel")}</button>
      <Show when={needsSourceLocation() && sourceLocationFailed() && !uncertain()}><button type="button" class="button-secondary"
        onClick={() => setSourceLocationRevision(value => value + 1)}>{t("missions.control.refresh")}</button></Show>
      <Show when={uncertain()}><button type="button" class="button-secondary" onClick={() => {
        if (!(props.active?.() ?? true)) return
        if (mode() === "recurring") props.onRecurrenceRefresh?.()
        else void missionStore.refresh(props.instanceId)
      }}>{t("missions.control.refresh")}</button></Show>
      <button type="submit" class="button-primary" disabled={!creationReady() || defaultsRefreshing() || pending() || uncertain() || !(props.active?.() ?? true)
        || kind === "create" && mode() === "recurring" && (!zoneValid() || !sourceLocationReady() || !sourceInputBudget().sufficient)
        || (kind !== "delete" && !(mode() === "recurring" ? instructions() : objective()).trim())}>
        {t(pending() ? "missions.control.mutation.pending" : kind === "delete" ? "missions.control.delete" : "missions.control.save")}
      </button>
    </footer>
  </form>
}
