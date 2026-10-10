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
import { MissionBriefPicker, MissionBriefSave } from "./mission-model-library"
import { MissionProfileSummary } from "./mission-profile-summary"
import { MissionTaskModeControls } from "./mission-task-mode-controls"
import { holdRecurrence, uncertainRecurrence } from "../stores/mission-recurrence"
import { HttpResponseError } from "../lib/retryable-file-search"
import { MISSION_LIFECYCLE_TEXT_LIMIT, recurrenceStartText } from "../../../server/src/missions/lifecycle-input"
import { recurrenceInputBudget } from "../../../server/src/missions/recurrence-read-budget"
import { MISSION_TITLE_MAX, deriveMissionTitle } from "../../../server/src/missions/mission-title"
import { getRootClient } from "../stores/opencode-client"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { createRequestLocation, requestLocationOptions, toRequestLocation } from "../stores/request-locations"
import { MissionConversationPicker } from "./mission-conversation-picker"

export interface MissionEditorAction { kind: "create" | "edit" | "delete"; mission?: MissionMap }
type FieldError = { field: "objective" | "when" | "zone" | "profiles" | "followed"; message: string }

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
  const ids = { zoneError: createUniqueId(), zoneList: createUniqueId(), objective: createUniqueId(), objectiveError: createUniqueId(),
    whenError: createUniqueId(), profilesError: createUniqueId(), followedError: createUniqueId() }
  // The system zone stays the default; the native list only offers suggestions when the runtime has it.
  const timeZones = (Intl as { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf?.("timeZone") ?? []
  const zones = () => timeZones
  const config = useConfig()
  // The revision and draft belong to this editor, not to live snapshot refreshes.
  const action = props.action, original = action.mission, kind = action.kind
  // The UI's physical folder fences the view; it must not replace the server's
  // existing native default location (notably on WSL) in the creation request.
  const identity = () => JSON.stringify([props.instanceId, props.viewDirectory ?? props.directory, props.projectID])
  const captureView = createMissionViewFence(identity, () => props.active?.() ?? true)
  const isActive = () => props.active?.() ?? true
  const held = kind === "create" ? uncertainMissionCreation(identity()) : undefined
  const recurrenceHold = kind === "create" ? uncertainRecurrence(identity()) : undefined
  const [mode, setMode] = createSignal<"once" | "recurring">(recurrenceHold ? "recurring" : "once")
  const [titleOverride, setTitleOverride] = createSignal<string | undefined>(recurrenceHold?.title ?? held?.title)
  const [time, setTime] = createSignal(recurrenceHold?.clock.time ?? "09:00")
  const [zone, setZone] = createSignal(recurrenceHold?.clock.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const zoneValid = createMemo(() => {
    if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(zone().trim())) return false
    try { new Intl.DateTimeFormat(undefined, { timeZone: zone().trim() }); return true } catch { return false }
  })
  const [watched, setWatched] = createSignal<string[]>(recurrenceHold?.watchedConversationIDs ?? [])
  // One shared draft: one-time objective or recurring permanent instructions.
  const [objective, setObjective] = createSignal(recurrenceHold?.instructions ?? held?.objective ?? original?.objective ?? "")
  const derivedTitle = () => deriveMissionTitle(objective())
  const title = () => titleOverride() ?? derivedTitle()
  const submittedTitle = () => title().trim() || derivedTitle()
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
  // Everything beyond the objective, title and schedule lives in one closed disclosure.
  const [optionsOpen, setOptionsOpen] = createSignal(false)
  const [profileDetailsOpen, setProfileDetailsOpen] = createSignal(false)
  let zoneInput: HTMLInputElement | undefined
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
  const [fieldError, setFieldError] = createSignal<FieldError>()
  const fail = (field: FieldError["field"], message: string) => {
    setFieldError({ field, message })
    if (field === "zone" || field === "profiles" || field === "followed") setOptionsOpen(true)
    if (field === "profiles") setProfileDetailsOpen(true)
  }
  const errorFor = (field: FieldError["field"]) => fieldError()?.field === field ? fieldError()!.message : undefined
  const watchedIDs = watched
  const needsSourceLocation = createMemo(() => mode() === "recurring" && watchedIDs().length > 0)
  const sourceIdentity = () => JSON.stringify([identity(), props.directory, getOpenCodeInstanceGeneration(props.instanceId)])
  const [sourceLocation, setSourceLocation] = createSignal<{ key: string; directory: string }>()
  const [sourceLocationFailed, setSourceLocationFailed] = createSignal(false)
  const [sourceLocationRevision, setSourceLocationRevision] = createSignal(0)
  createEffect(() => {
    sourceLocationRevision()
    if (!needsSourceLocation() || !creationReady() || !isActive()) return
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
  const sourceInputBudget = () => recurrenceInputBudget({ consigne: objective().trim(), watchedConversationIDs: watchedIDs(),
    roots: sourceLocation()?.key === sourceIdentity() ? [{ directory: sourceLocation()!.directory }] : [] })
  let requestId = held?.requestId ?? recurrenceHold?.requestID ?? crypto.randomUUID(), lastPayload = ""
  const locked = () => !creationReady() || defaultsRefreshing() || pending() || uncertain()

  async function useSavedDefaults() {
    if (pending() || uncertain() || defaultsRefreshing() || !isActive()) return
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

  // Creation only creates: one-time Missions and schedules start through their explicit Play.
  async function save(event: SubmitEvent) {
    event.preventDefault()
    if (locked() || !isActive()) return
    setFieldError(undefined)
    const recurrence = kind === "create" && mode() === "recurring"
    if (recurrence) {
      try { recurrenceStartText({ consigne: objective().trim(), template: template(), taskMode: taskMode() ?? "native" }) }
      catch { fail("objective", t("missions.recurrence.instructionsTooLong", { limit: MISSION_LIFECYCLE_TEXT_LIMIT })); return }
      const held = uncertainRecurrence(identity())
      if (held || uncertainMissionCreation(identity())) { setUncertain(true); return }
      const selected = copyMissionProfiles(profiles())
      if (!selected?.coordinator?.agent || !selected.coordinator.model?.providerID || !selected.coordinator.model.id
        || missionProfileRoles[template()].some(role => !selected.roles?.[role]?.agent
          || !selected.roles[role].model?.providerID || !selected.roles[role].model?.id)) {
        fail("profiles", t("missions.recurrence.profilesRequired")); return
      }
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time())) { fail("when", t("missions.recurrence.clockInvalid")); return }
      if (!zoneValid()) { fail("zone", t("missions.simple.zoneInvalid")); return }
      const ids = watchedIDs()
      if (ids.length > 32 || new Set(ids).size !== ids.length || ids.some(id => !/^[A-Za-z0-9_.:-]{1,240}$/.test(id))) {
        fail("followed", t("missions.recurrence.watchedInvalid")); return
      }
      if (!sourceLocationReady()) { fail("followed", t("missions.recurrence.sourceLocationUnavailable")); return }
      if (!sourceInputBudget().sufficient) {
        fail("objective", t("missions.recurrence.sourceInputTooLong", { limit: MISSION_LIFECYCLE_TEXT_LIMIT })); return
      }
      const payload = { title: submittedTitle(), instructions: objective().trim(), notes: notes(), template: template(), clock: { time: time(), zone: zone().trim() }, watchedConversationIDs: ids,
        profiles: selected, taskMode: taskMode() ?? "native", directory: props.directory }
      const serialized = JSON.stringify(payload)
      if (lastPayload && lastPayload !== serialized) requestId = crypto.randomUUID()
      lastPayload = serialized
      const scope = identity(), currentView = captureView(), operation = props.captureOperation?.() ?? (() => true)
      const current = () => currentView() && operation() && props.action === action
      const instanceId = props.instanceId
      setPending(true); setError("")
      try {
        await serverApi.createMissionRecurrence(instanceId, { ...payload, requestID: requestId })
        if (current()) props.onRecurrenceSaved?.()
      } catch (error) {
        if (error instanceof HttpResponseError && error.status === 503 && error.code === "recurrence-capacity") {
          if (current()) setError(t("missions.recurrence.capacity"))
          return
        }
        if (error instanceof HttpResponseError && error.status === 400) {
          if (current()) {
            if (error.code === "recurrence-input-capacity") fail("objective", t("missions.recurrence.sourceInputTooLong", { limit: MISSION_LIFECYCLE_TEXT_LIMIT }))
            else setError(t("missions.recurrence.invalid"))
          }
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
      setObjective(existingHold.objective); setTitleOverride(existingHold.title); setNotes(existingHold.notes); setTemplate(existingHold.template)
      setProfiles(copyMissionProfiles(existingHold.profiles)); setCustomProfiles(true)
      setTaskMode(existingHold.taskMode); setCustomTaskMode(true)
      setSelectedModel(submittedMissionModel(existingHold.requestId)); setUncertain(true); return
    }
    const origin = identity(), directory = props.directory, instanceId = props.instanceId
    const viewCurrent = captureView()
    const operationCurrent = props.captureOperation?.() ?? (() => true)
    const current = () => viewCurrent() && operationCurrent() && props.action === action
    const fields = { objective: objective().trim(), notes: notes(), template: template(),
      ...(kind === "create" ? { title: submittedTitle() } : {}),
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

  const inlineError = (field: FieldError["field"], id: string) =>
    <Show when={errorFor(field)}>{message => <span id={id} class="mission-create-field-error" role="alert">{message()}</span>}</Show>

  const createBody = () => <>
    <label for={ids.objective}>{t("missions.create.objective")}</label>
    <textarea id={ids.objective} required maxLength={mode() === "recurring" ? MISSION_LIFECYCLE_TEXT_LIMIT : 20_000} value={objective()}
      placeholder={t("missions.create.objectivePlaceholder")} disabled={pending() || uncertain()}
      aria-invalid={Boolean(errorFor("objective"))} aria-describedby={errorFor("objective") ? ids.objectiveError : undefined}
      onInput={e => setObjective(e.currentTarget.value)} />
    {inlineError("objective", ids.objectiveError)}
    <Show when={mode() === "recurring" && sourceLocationReady() && !sourceInputBudget().sufficient && !errorFor("objective")}>
      <span class="mission-create-field-error" role="alert">{t(watchedIDs().length ? "missions.recurrence.sourceInputTooLong" : "missions.recurrence.instructionsTooLong", { limit: MISSION_LIFECYCLE_TEXT_LIMIT })}</span>
    </Show>
    <label>{t("missions.create.title")}
      <input maxLength={MISSION_TITLE_MAX} value={title()} placeholder={derivedTitle()} disabled={pending() || uncertain()}
        onInput={e => setTitleOverride(e.currentTarget.value)} />
    </label>
    <fieldset class="mission-create-when" disabled={pending() || uncertain()} aria-describedby={errorFor("when") ? ids.whenError : undefined}>
      <legend>{t("missions.create.when")}</legend>
      <label class="mission-create-choice"><input type="radio" name="mission-create-when" value="once" checked={mode() === "once"}
        onChange={() => setMode("once")} />{t("missions.create.once")}</label>
      <label class="mission-create-choice"><input type="radio" name="mission-create-when" value="recurring" checked={mode() === "recurring"}
        onChange={() => setMode("recurring")} />{t("missions.create.daily")}</label>
      <input type="time" class="mission-create-time" required aria-label={t("missions.recurrence.time")} value={time()}
        onFocus={() => setMode("recurring")} onInput={e => { setMode("recurring"); setTime(e.currentTarget.value) }} />
      <Show when={mode() === "recurring"}>
        <small class="mission-create-zone"><bdi>{t("missions.create.zone", { zone: zone().trim() || "—" })}</bdi>
          <button type="button" class="window-text-button" onClick={() => {
            setOptionsOpen(true); queueMicrotask(() => zoneInput?.focus())
          }}>{t("missions.create.zoneChange")}</button></small>
      </Show>
      {inlineError("when", ids.whenError)}
    </fieldset>
    <details class="mission-profile-optional mission-create-options" open={optionsOpen()} onToggle={event => setOptionsOpen(event.currentTarget.open)}>
      <summary>{t("missions.create.options")}</summary>
      {/* Natively hidden while closed so local drafts survive; network demand follows optionsOpen. */}
      <MissionBriefPicker disabled={locked() || !isActive()} active={() => optionsOpen() && isActive()} value={selectedModel()?.id}
        onUse={model => {
          requestId = crypto.randomUUID(); lastPayload = ""; setError(""); setFieldError(undefined)
          setObjective(model.objective); setTitleOverride(undefined); setNotes(model.notes); setTemplate(model.template); setSelectedModel({ id: model.id, name: model.name })
          setCustomProfiles(model.profiles !== undefined)
          setCustomTaskMode(model.taskMode !== undefined); setTaskMode(model.taskMode ?? missionTaskModeFor(defaults(), model.template))
          setProfiles(model.profiles === undefined ? missionDefaultsFor(defaults(), model.template) : copyMissionProfiles(model.profiles))
        }} />
      <label>{t("missions.control.template")}
        <select aria-label={t("missions.control.template")} value={template()} disabled={locked()} onChange={e => {
          const next = e.currentTarget.value as MissionMap["template"]
          setTemplate(next); setProfiles(customProfiles() ? profilesForTemplate(profiles(), next) : missionDefaultsFor(defaults(), next))
          if (!customTaskMode()) setTaskMode(missionTaskModeFor(defaults(), next))
        }}>
          <For each={["custom", "debug", "wayfinder"] as const}>{id => <option value={id}>{t(`missions.control.template.${id}`)}</option>}</For>
        </select>
      </label>
      <MissionTaskModeControls value={taskMode() ?? "native"} disabled={locked()}
        onChange={value => { setTaskMode(value); setCustomTaskMode(true) }} />
      <section class="mission-create-option" aria-label={t("missions.create.agents")} aria-describedby={errorFor("profiles") ? ids.profilesError : undefined}>
        <MissionProfileSummary template={template()} profiles={profiles()} />
        {/* Catalog-backed selectors mount (and read the native catalog) only on demand. */}
        <details class="mission-profile-optional" open={profileDetailsOpen()} onToggle={event => setProfileDetailsOpen(event.currentTarget.open)}>
          <summary>{t("missions.create.agents")}</summary>
          <Show when={profileDetailsOpen()}>
            <MissionProfileControls instanceId={props.instanceId} directory={props.directory} template={template()} profiles={profiles()}
              requireRoleProfiles={mode() === "recurring"} taskMode={taskMode()}
              disabled={locked()} active={() => profileDetailsOpen() && optionsOpen() && isActive()}
              onChange={value => { setCustomProfiles(true); setProfiles(value) }} />
          </Show>
          <div class="mission-create-option-actions">
            <button type="button" class="window-text-button" disabled={pending() || defaultsRefreshing() || uncertain()} onClick={() => void useSavedDefaults()}>{t("missions.defaults.use")}</button>
            <Show when={props.onOpenPreferences}><button type="button" class="window-text-button" title={t("missions.defaults.hint")} onClick={props.onOpenPreferences}>{t("missions.defaults.manage")}</button></Show>
          </div>
        </details>
        {inlineError("profiles", ids.profilesError)}
      </section>
      <label>{t("missions.control.notes")}
        <textarea maxLength={20_000} value={notes()} disabled={pending() || uncertain()} onInput={e => setNotes(e.currentTarget.value)} />
      </label>
      <Show when={mode() === "recurring"}>
        <MissionConversationPicker instanceId={props.instanceId} directory={props.directory} projectID={props.projectID}
          value={watchedIDs()} disabled={pending() || uncertain()} active={() => mode() === "recurring" && optionsOpen() && isActive()} onChange={setWatched} />
        {inlineError("followed", ids.followedError)}
        <Show when={needsSourceLocation() && !sourceLocationReady() && !errorFor("followed")}><p role={sourceLocationFailed() ? "alert" : "status"}>{t(sourceLocationFailed() ? "missions.recurrence.sourceLocationUnavailable" : "missions.control.loading")}</p></Show>
        <label>{t("missions.create.zoneOverride")}
          <input ref={zoneInput} required maxLength={100} value={zone()} aria-label={t("missions.create.zoneOverride")} aria-invalid={!zoneValid()}
            aria-describedby={!zoneValid() ? ids.zoneError : undefined} disabled={pending() || uncertain()} onInput={e => setZone(e.currentTarget.value)}
            list={zones().length ? ids.zoneList : undefined} />
          <Show when={zones().length}><datalist id={ids.zoneList}><For each={zones()}>{value => <option value={value} />}</For></datalist></Show>
          <Show when={!zoneValid()}><span id={ids.zoneError} class="mission-create-field-error" role="alert">{t("missions.simple.zoneInvalid")}</span></Show>
        </label>
      </Show>
    </details>
    <Show when={selectedModel()}>{model => <p>{t("missions.models.current", { name: model().name })}</p>}</Show>
    <Show when={!defaultsReady() || defaultsFailed() || config.isUiConfigLoaded() && !config.missionDefaultsValid()}>
      <p role={config.uiConfigLoadFailed() || defaultsFailed() || config.isUiConfigLoaded() && !config.missionDefaultsValid() ? "alert" : "status"}>
        {t(config.isUiConfigLoaded() && !config.missionDefaultsValid() ? "missions.defaults.invalid"
          : config.uiConfigLoadFailed() || defaultsFailed() ? "missions.defaults.unavailable" : "missions.defaults.loading")}
      </p>
      <button type="button" class="window-action" disabled={defaultsRefreshing() || uncertain()}
        onClick={() => void useSavedDefaults()}>{t("missions.defaults.reload")}</button>
    </Show>
  </>

  const createDisabled = () => locked() || !isActive() || !objective().trim()
    || mode() === "recurring" && (!zoneValid() || !sourceLocationReady() || !sourceInputBudget().sufficient)

  return <form class="mission-editor window-shell" classList={{ "mission-create": kind === "create" }} onSubmit={save} aria-label={t(`missions.control.${kind}`)}>
    {/* Creation is headed by the panel's own Create button; edit/delete keep their title. */}
    <Show when={kind !== "create"}><header class="window-header"><h3 class="window-title">{t(`missions.control.${kind}`)}</h3></header></Show>
    <div class="window-body">
      <Show when={kind === "create"} fallback={<Show when={kind !== "delete"} fallback={<>
        <p>{t("missions.control.delete.detail")}</p>
        <label class="mission-delete-sessions"><input type="checkbox" checked={deleteManagedSessions()} disabled={pending() || deleteAttempted()}
          onChange={event => setDeleteManagedSessions(event.currentTarget.checked)} />{t("missions.control.delete.sessions")}</label>
      </>}>
        <label>{t("missions.control.objective")}
          <textarea required maxLength={20_000} value={objective()} disabled={pending()} onInput={e => setObjective(e.currentTarget.value)} />
        </label>
        <label>{t("missions.control.guidance.notes")}
          <textarea maxLength={20_000} value={notes()} disabled={pending()} onInput={e => setNotes(e.currentTarget.value)} />
        </label>
      </Show>}>{createBody()}</Show>
      <Show when={uncertain()} fallback={<Show when={error()}><p role="alert">{error()}</p></Show>}><p role="alert">{t("missions.control.creation.uncertain")}</p></Show>
    </div>
    <footer class="window-footer">
      <Show when={kind === "create"}>
        <MissionBriefSave disabled={locked() || !isActive()} active={isActive}
          draft={() => ({ objective: objective(), notes: notes(), template: template(), ...(customProfiles() ? { profiles: copyMissionProfiles(profiles()) ?? {} } : {}), ...(customTaskMode() ? { taskMode: taskMode() } : {}) })} />
      </Show>
      <button type="button" class="button-secondary" onClick={props.onCancel}>{t("missions.control.cancel")}</button>
      <Show when={needsSourceLocation() && sourceLocationFailed() && !uncertain()}><button type="button" class="button-secondary"
        onClick={() => setSourceLocationRevision(value => value + 1)}>{t("missions.control.refresh")}</button></Show>
      <Show when={uncertain()}><button type="button" class="button-secondary" onClick={() => {
        if (!isActive()) return
        if (mode() === "recurring") props.onRecurrenceRefresh?.()
        else void missionStore.refresh(props.instanceId)
      }}>{t("missions.control.refresh")}</button></Show>
      <Show when={kind === "create"} fallback={
        <button type="submit" class="button-primary" disabled={locked() || !isActive() || (kind !== "delete" && !objective().trim())}>
          {t(pending() ? "missions.control.mutation.pending" : kind === "delete" ? "missions.control.delete" : "missions.control.save")}
        </button>}>
        <button type="submit" class="button-primary" disabled={createDisabled()}>
          {t(pending() ? "missions.control.mutation.pending" : "missions.create.submit")}
        </button>
      </Show>
    </footer>
  </form>
}
