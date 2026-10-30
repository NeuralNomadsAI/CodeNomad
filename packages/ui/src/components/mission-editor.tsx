import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup } from "solid-js"
import type { MissionPanelMap } from "../../../server/src/api-types"
import { compareModelError, freezeCompareProfiles, sameCompareModel, type MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { deletionErrorKey, missionCleanupPending, MissionDeletionError } from "../lib/mission-cleanup"
import { missionStore } from "../stores/missions"
import { createMissionViewFence } from "../lib/mission-view-fence"
import { isDefinitiveCreationRejection, missionMutationErrorKey } from "../lib/mission-mutation"
import { copyMissionProfiles, holdMissionCreation, missionCreationHold, missionCreationPayloadIdentity, releaseMissionCreation,
  retainUncertainMissionCreation, uncertainMissionCreation } from "../stores/mission-creation-drafts"
import { MissionProfileControls } from "./mission-profile-controls"
import { missionProfileRoles, profilesForTemplate } from "./mission-profile-controls-data"
import { useConfig } from "../stores/preferences"
import { missionDefaultsFor, missionTaskModeFor, normalizeMissionDefaults, type MissionTaskMode } from "../lib/mission-defaults"
import type { MissionProfileDefault } from "../lib/mission-defaults"
import { retainSubmittedMissionModel, submittedMissionModel, type UserMissionModel } from "../lib/mission-model-library"
import { MissionBriefPicker, MissionBriefSave } from "./mission-model-library"
import { MissionProfileSummary } from "./mission-profile-summary"
import { MissionTaskModeControls } from "./mission-task-mode-controls"
import { MissionSubagentDepth } from "./mission-subagent-depth"
import { missionPanelScroll } from "./mission-panel-scroll"
import { uncertainRecurrence } from "../stores/mission-recurrence"
import { MISSION_LIFECYCLE_TEXT_LIMIT, recurrenceStartText } from "../../../server/src/missions/lifecycle-input"
import { recurrenceInputBudget } from "../../../server/src/missions/recurrence-read-budget"
import { MISSION_TITLE_MAX, deriveMissionTitle } from "../../../server/src/missions/mission-title"
import { getRootClient } from "../stores/opencode-client"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { createRequestLocation, requestLocationOptions, toRequestLocation } from "../stores/request-locations"
import { MissionConversationPicker } from "./mission-conversation-picker"
import type { MissionEditorAction, MissionEditorDraft } from "../stores/mission-editor-state"
import { MissionBodyPending } from "./mission-reader-body"
import { missionTargetState, retryMissionTarget, useTargetBody } from "./mission-target-bodies"
import { missionScheduleEditorHold } from "../stores/mission-schedule-editor-holds"
import { createMissionEditorScheduling } from "./mission-editor-schedule"
import { missionSchedulingPolicy } from "./mission-scheduling-data"
import { MissionScheduling, type MissionSchedulingLock } from "./mission-scheduling"
import { createMissionEditorSources } from "./mission-editor-sources"

export type { MissionEditorAction }
type FieldError = { field: "objective" | "profiles" | "followed"; message: string }

export function MissionEditor(props: {
  instanceId: string; directory?: string; viewDirectory?: string; projectID?: string; action: MissionEditorAction
  active?: () => boolean
  captureOperation?: () => (() => boolean)
  onSaved: (mission?: MissionPanelMap, scheduleID?: string) => void; onCancel: () => void
  onOpenPreferences?: () => void
  /** Opens the selected playbook's details under the chosen task-session policy. */
  onShowPlaybook?: (template: MissionPanelMap["template"], taskMode: MissionTaskMode) => void
  onRecurrenceSaved?: () => void
  onRecurrenceRefresh?: () => void
  /** On unmount: the idle draft to reopen, null to reopen as opened (an edit still reading
   * its fields), or undefined while a request is in flight or held. */
  onDispose?: (draft?: MissionEditorDraft | null) => void
  /** Opens this edit again on the current map (its fields changed since it opened); settles
   * once it did, or chose not to, and rejects when the current map could not be read. */
  onReopen?: () => Promise<void>
}) {
  const { t } = useI18n()
  const ids = { objective: createUniqueId(), objectiveError: createUniqueId(), profilesError: createUniqueId(), followedError: createUniqueId(), templateDescription: createUniqueId() }
  const config = useConfig()
  // The revision and draft belong to this editor, not to live snapshot refreshes.
  const action = props.action, original = action.mission, kind = action.kind
  // The UI's physical folder fences the view; it must not replace the server's
  // existing native default location (notably on WSL) in the creation request.
  const identity = () => JSON.stringify([props.instanceId, props.viewDirectory ?? props.directory, props.projectID])
  const captureView = createMissionViewFence(identity, () => props.active?.() ?? true)
  const isActive = () => props.active?.() ?? true
  const scheduleScope = () => JSON.stringify([identity(), kind === "create" ? "create" : action.scheduleID ?? original?.id])
  const scheduleHold = missionScheduleEditorHold(scheduleScope())
  const held = kind === "create" ? uncertainMissionCreation(identity()) : undefined
  const recurrenceHold = kind === "create" ? uncertainRecurrence(identity()) : undefined
  // An exact held contract wins over the draft this editor left when its panel unmounted.
  const draft = scheduleHold?.draft ?? (held || recurrenceHold ? undefined : action.draft)
  const [titleOverride, setTitleOverride] = createSignal<string | undefined>(recurrenceHold?.title ?? held?.title ?? draft?.titleOverride ?? original?.title)
  const [watched, setWatched] = createSignal<string[]>(recurrenceHold?.watchedConversationIDs ?? draft?.watched ?? [])
  // An edit starts from the objective and notes of exactly the map it opened (its CAS
  // revision): content reads count only when their digests are that map's descriptors.
  const prefill = kind === "edit" && original !== undefined && !original.document && !action.scheduleID && !draft
  const opened = () => prefill ? original : undefined
  const editedObjective = useTargetBody(() => props.instanceId, opened, "objective"), editedNotes = useTargetBody(() => props.instanceId, opened, "notes")
  const prefillState = () => missionTargetState([editedObjective(), editedNotes()])
  const [prefilling, setPrefilling] = createSignal(prefill)
  // While a Reopen runs, this form stays read-only as it opened (its CAS revision too): a
  // field matching again meanwhile never makes it editable, so no draft typed here is
  // replaced by the reopened edit. It settles back when the parent declines or fails.
  const [reopen, setReopen] = createSignal<"idle" | "pending" | "failed">("idle")
  const reopenEdit = () => {
    if (reopen() === "pending" || !props.onReopen) return
    setReopen("pending")
    props.onReopen().then(() => setReopen("idle"), () => setReopen("failed"))
  }
  // Reading while a Reopen runs; a changed field, or a failed Reopen, offers Reopen.
  const offersReopen = () => reopen() === "failed" || reopen() === "idle" && prefillState() === "changed"
  // One shared draft: one-time objective or recurring permanent instructions.
  const [objective, setObjective] = createSignal(recurrenceHold?.instructions ?? held?.objective ?? draft?.objective ?? "")
  const derivedTitle = () => deriveMissionTitle(objective())
  const title = () => titleOverride() ?? derivedTitle()
  const submittedTitle = () => title().trim() || derivedTitle()
  const [notes, setNotes] = createSignal(recurrenceHold?.notes ?? held?.notes ?? draft?.notes ?? "")
  createEffect(() => {
    const objectiveField = editedObjective(), notesField = editedNotes()
    if (!prefilling() || reopen() === "pending" || objectiveField.state !== "ready" || notesField.state !== "ready") return
    setObjective(objectiveField.value ?? ""); setNotes(notesField.value ?? "")
    setPrefilling(false)
  })
  const [template, setTemplate] = createSignal<MissionPanelMap["template"]>(recurrenceHold?.template ?? held?.template ?? draft?.template ?? original?.template ?? "custom")
  const [profiles, setProfiles] = createSignal<MissionProfiles | undefined>(copyMissionProfiles(recurrenceHold?.profiles ?? held?.profiles ?? draft?.profiles ?? original?.profiles))
  const [customProfiles, setCustomProfiles] = createSignal(Boolean(held || recurrenceHold || draft?.customProfiles))
  const [taskMode, setTaskMode] = createSignal<MissionTaskMode | undefined>(draft ? draft.taskMode : recurrenceHold?.taskMode ?? held?.taskMode ?? original?.taskMode ?? "native")
  const [customTaskMode, setCustomTaskMode] = createSignal(Boolean(held || recurrenceHold || draft?.customTaskMode))
  const [defaults, setDefaults] = createSignal<MissionProfileDefault[]>(draft?.defaults ?? [])
  const [defaultsReady, setDefaultsReady] = createSignal(kind !== "create" || Boolean(held || recurrenceHold || draft?.defaultsReady))
  const [defaultsRefreshing, setDefaultsRefreshing] = createSignal(false)
  const [defaultsFailed, setDefaultsFailed] = createSignal(false)
  const creationReady = () => defaultsReady() && (kind !== "create" || Boolean(held || recurrenceHold) || config.isUiConfigLoaded())
  const effectiveProfiles = () => freezeCompareProfiles(template(), profiles())
  const compareError = () => template() === "compare" ? compareModelError(profiles()) : undefined
  const judgeWarning = () => template() === "compare" && ["model-a", "model-b"].some(role =>
    sameCompareModel(effectiveProfiles()?.roles?.comparator?.model, profiles()?.roles?.[role]?.model))
  const [optionsOpen, setOptionsOpen] = createSignal(Boolean(draft?.optionsOpen))
  const [profileDetailsOpen, setProfileDetailsOpen] = createSignal(Boolean(draft?.profileDetailsOpen))
  const [selectedModel, setSelectedModel] = createSignal<Pick<UserMissionModel, "id" | "name"> | undefined>(held ? submittedMissionModel(held.requestId)
    : recurrenceHold ? submittedMissionModel(recurrenceHold.requestID) : draft?.selectedModel)
  // One creation-time snapshot only, after the owned preference document loads.
  // Refreshes and other windows' preference edits never replace this draft.
  createEffect(() => {
    if (defaultsReady() || !config.isUiConfigLoaded() || !config.missionDefaultsValid()) return
    const loaded = normalizeMissionDefaults(config.preferences().missionProfileDefaults)
    setDefaults(loaded); setProfiles(missionDefaultsFor(loaded, template())); setTaskMode(missionTaskModeFor(loaded, template()))
    setDefaultsReady(true)
  })
  const [recurrenceUncertain, setUncertain] = createSignal(Boolean(recurrenceHold))
  // A one-time hold is adopted when it is unknown at mount or met at submission;
  // a newer editor keeps its own draft while another request is merely pending.
  const [adopted, setAdopted] = createSignal(Boolean(held))
  const creationHold = () => kind === "create" && adopted() ? missionCreationHold(identity()) : undefined
  const creationPending = () => creationHold()?.state === "pending"
  const uncertain = () => recurrenceUncertain() || creationHold()?.state === "uncertain" || schedule.held()?.state === "uncertain"
  // The request whose exact draft this editor shows. An adopted hold from another
  // editor leaves this draft unsent; its wording must not claim otherwise.
  const [shownRequestId, setShownRequestId] = createSignal(held?.requestId)
  const otherUncertain = () => !recurrenceUncertain() && creationHold()?.state === "uncertain"
    && creationHold()!.operation.requestId !== shownRequestId() || schedule.held()?.state === "uncertain"
      && JSON.parse(schedule.held()!.payload).requestID !== requestId
  const busy = () => pending() || uncertain() || creationPending() || !!schedule.held()
  const [deleteManagedSessions, setDeleteManagedSessions] = createSignal(Boolean(draft?.deleteManagedSessions))
  const [deleteAttempted, setDeleteAttempted] = createSignal(Boolean(draft?.deleteAttempted))
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal("")
  const [fieldError, setFieldError] = createSignal<FieldError>()
  const fail = (field: FieldError["field"], message: string) => {
    setFieldError({ field, message })
    if (field === "profiles" || field === "followed") setOptionsOpen(true)
    if (field === "profiles") setProfileDetailsOpen(true)
  }
  const errorFor = (field: FieldError["field"]) => fieldError()?.field === field ? fieldError()!.message : undefined
  const schedule = createMissionEditorScheduling({ instanceId: props.instanceId, directory: props.directory, action, draft,
    scope: scheduleScope, active: isActive, captureView: () => {
      const view = captureView(), operation = props.captureOperation?.() ?? (() => true)
      const generation = getOpenCodeInstanceGeneration(props.instanceId)
      return () => view() && operation() && props.action === action && getOpenCodeInstanceGeneration(props.instanceId) === generation
    },
    onLoad: config => {
      setTitleOverride(config.title); setObjective(config.objective); setNotes(config.notes ?? ""); setTemplate(config.template)
      setProfiles(copyMissionProfiles(config.profiles)); setTaskMode(config.taskMode); setWatched(config.watchedConversationIDs)
      setCustomProfiles(true); setCustomTaskMode(true)
    }, captureDraft: () => captureDraft(), onSaved: (mission, scheduleID) => props.onSaved(mission, scheduleID) })
  const mode = () => schedule.scheduling().frequency === "immediate" && schedule.scheduling().condition === "none" ? "once" : "recurring"
  const immediateFollowed = () => mode() === "once" && watched().length > 0
  const immediateCreationFollowed = () => kind === "create" && immediateFollowed()
  const time = () => schedule.scheduling().times[0] ?? "09:00", zone = () => schedule.scheduling().zone
  const journalLocked = () => kind === "edit" && !schedule.unified
  const journalPreparation = () => kind === "edit" && schedule.document()?.kind === "one-time" && schedule.document()?.edit.structural
  const observationUnknown = () => schedule.document()?.kind === "schedule" && schedule.document()?.observation.state === "unknown"
  const scopeUnsupported = () => !!schedule.document() && (schedule.document()!.configuration.roots.length !== 1
    || schedule.document()!.configuration.roots[0].mode !== "directory-only"
    || schedule.document()!.configuration.roots[0].directory !== schedule.directory())
  const structuralReason = () => (scopeUnsupported() ? "scope" : observationUnknown() ? "uncertain" : schedule.document()?.edit.reason ?? (journalLocked() ? "journal" : null)) as MissionSchedulingLock | null
  const structuralLocked = () => locked() || observationUnknown() || scopeUnsupported() || kind === "edit" && (journalLocked() || !schedule.document()?.edit.structural)
  const textLocked = () => busy() || prefilling() || !schedule.ready() || schedule.conflict()
    || observationUnknown() || scopeUnsupported()
    || kind === "edit" && !!original && (original.status !== "active" || original.runState === "stopped")
    || schedule.unified && !schedule.document()?.edit.structural && !["passage", "launched-once", "journal"].includes(schedule.document()?.edit.reason ?? "")
  const policy = () => { try { return missionSchedulingPolicy(schedule.scheduling(), schedule.directory()) } catch { return undefined } }
  const [policyReady, setPolicyReady] = createSignal(false)
  const sourceChoices = createMissionEditorSources({ instanceId: props.instanceId, projectID: props.projectID,
    target: action.scheduleID ?? original?.id, directory: schedule.directory, condition: () => schedule.scheduling().condition,
    active: isActive, captureView })
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
  let requestId = held?.requestId ?? recurrenceHold?.requestID ?? draft?.requestId ?? crypto.randomUUID(), lastPayload = draft?.lastPayload ?? ""
  const locked = () => !creationReady() || defaultsRefreshing() || busy() || prefilling() || !schedule.ready() || schedule.conflict() || schedule.reading()
  // Only an idle draft is kept: a request in flight or held settles through its own hold.
  const captureDraft = (): MissionEditorDraft => ({ mode: mode(), titleOverride: titleOverride(), time: time(), zone: zone(),
    watched: watched(), objective: objective(), notes: notes(), template: template(), profiles: copyMissionProfiles(profiles()),
    customProfiles: customProfiles(), taskMode: taskMode(), customTaskMode: customTaskMode(), defaults: defaults(),
    defaultsReady: defaultsReady(), selectedModel: selectedModel(), optionsOpen: optionsOpen(), profileDetailsOpen: profileDetailsOpen(),
    requestId, lastPayload, deleteManagedSessions: deleteManagedSessions(), deleteAttempted: deleteAttempted(),
    scheduling: structuredClone(schedule.scheduling()), scheduleDocument: schedule.document(), scheduleAnchorAt: schedule.anchorAt(),
    previousDraft: schedule.previousDraft(), journalMission: schedule.journal() })
  onCleanup(() => props.onDispose?.(busy() ? undefined : prefilling() ? null : captureDraft()))

  async function useSavedDefaults() {
    if (busy() || defaultsRefreshing() || !isActive()) return
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
    if (kind !== "delete" && !structuralLocked() && compareError()) return
    if (immediateCreationFollowed()) return
    const scheduledWrite = kind === "create" && mode() === "recurring" || kind === "edit" && schedule.unified
      && (schedule.document()?.kind === "schedule" || journalPreparation())
    if (scheduledWrite) {
      if (textLocked() || !structuralLocked() && (!policy() || !policyReady())) return
      if (!structuralLocked()) {
        try { recurrenceStartText({ consigne: objective().trim(), template: template(), taskMode: taskMode() ?? "native" }) }
        catch { fail("objective", t("missions.recurrence.instructionsTooLong", { limit: MISSION_LIFECYCLE_TEXT_LIMIT })); return }
      }
      if (uncertainRecurrence(identity())) { setUncertain(true); return }
      if (missionCreationHold(identity())) { setAdopted(true); return }
      const selected = copyMissionProfiles(effectiveProfiles())
       if (mode() === "recurring" && !structuralLocked() && (!selected?.coordinator?.agent || !selected.coordinator.model?.providerID || !selected.coordinator.model.id
        || missionProfileRoles[template()].some(role => !selected.roles?.[role]?.agent
          || !selected.roles[role].model?.providerID || !selected.roles[role].model?.id))) {
        fail("profiles", t("missions.recurrence.profilesRequired")); return
      }
      const ids = watchedIDs()
      if (!structuralLocked() && (ids.length > 32 || new Set(ids).size !== ids.length || ids.some(id => !/^[A-Za-z0-9_.:-]{1,240}$/.test(id)))) {
        fail("followed", t("missions.recurrence.watchedInvalid")); return
      }
      if (!structuralLocked() && !sourceLocationReady()) { fail("followed", t("missions.recurrence.sourceLocationUnavailable")); return }
      if (!structuralLocked() && !sourceInputBudget().sufficient) {
        fail("objective", t("missions.recurrence.sourceInputTooLong", { limit: MISSION_LIFECYCLE_TEXT_LIMIT })); return
      }
      const { roots: _roots, profileID: _profile, executionHost: _host, ...stored } = schedule.document()?.configuration ?? {} as NonNullable<ReturnType<typeof schedule.document>>["configuration"]
      const payload = structuralLocked() ? { ...stored, objective: objective().trim(), notes: notes() }
        : { title: submittedTitle(), objective: objective().trim(), notes: notes(), template: template(),
        watchedConversationIDs: ids, profiles: selected, taskMode: taskMode() ?? "native", launch: policy()! }
      const serialized = JSON.stringify(payload)
      if (lastPayload && lastPayload !== serialized) requestId = crypto.randomUUID()
      lastPayload = serialized
      const currentView = captureView(), operation = props.captureOperation?.() ?? (() => true)
      const current = () => currentView() && operation() && props.action === action
      setPending(true); setError("")
      try {
        await schedule.save(payload, requestId)
      } catch (error) {
        if (current()) setError(t("missions.control.mutation.error"))
      } finally { if (current()) setPending(false) }
      return
    }
    if (kind === "edit") {
      if (textLocked()) return
      const payload = JSON.stringify({ objective: objective().trim(), notes: notes(), revision: schedule.journal()?.revision })
      if (lastPayload && lastPayload !== payload) requestId = crypto.randomUUID()
      lastPayload = payload
      const view = captureView(), operation = props.captureOperation?.() ?? (() => true)
      const current = () => view() && operation() && props.action === action
      setPending(true); setError("")
      try { await schedule.saveJournalEdit({ objective: objective().trim(), notes: notes(), requestID: requestId }) }
      catch (error) { if (current()) setError(t(missionMutationErrorKey(error))) }
      finally { if (current()) setPending(false) }
      return
    }
    // A hold learned after this editor opened still cannot become a new logical
    // creation merely because the user submits another draft in the same scope.
    if (kind === "create" && uncertainRecurrence(identity())) { setUncertain(true); return }
    if (kind === "create" && missionCreationHold(identity())) {
      // Show an unknown contract exactly; a merely pending one leaves this draft alone.
      const existingHold = uncertainMissionCreation(identity())
      if (existingHold) {
        setObjective(existingHold.objective); setTitleOverride(existingHold.title); setNotes(existingHold.notes); setTemplate(existingHold.template)
        setProfiles(copyMissionProfiles(existingHold.profiles)); setCustomProfiles(true)
        setTaskMode(existingHold.taskMode); setCustomTaskMode(true)
        setSelectedModel(submittedMissionModel(existingHold.requestId))
        setShownRequestId(existingHold.requestId)
      }
      setAdopted(true); return
    }
    const origin = identity(), directory = props.directory, instanceId = props.instanceId
    const viewCurrent = captureView()
    const operationCurrent = props.captureOperation?.() ?? (() => true)
    const current = () => viewCurrent() && operationCurrent() && props.action === action
    const fields = { objective: objective().trim(), notes: notes(), template: template(),
      ...(kind === "create" ? { title: submittedTitle() } : {}),
      ...(kind === "create" && taskMode() !== undefined ? { taskMode: taskMode() } : {}),
      ...(kind === "create" && effectiveProfiles() !== undefined ? { profiles: copyMissionProfiles(effectiveProfiles()) } : {}) }
    const payload = kind === "create" ? missionCreationPayloadIdentity({ ...fields, directory })
      : JSON.stringify(kind === "delete" ? { deleteManagedSessions: deleteManagedSessions() } : fields)
    if (lastPayload && lastPayload !== payload) requestId = crypto.randomUUID()
    lastPayload = payload
    const creation = { ...fields, requestId, directory }
    const modelIdentity = selectedModel()
    if (kind === "create") {
      if (!holdMissionCreation(origin, creation)) { setAdopted(true); return }
      setShownRequestId(creation.requestId)
      setAdopted(true)
    }
    setPending(true)
    setError("")
    try {
      if (kind === "delete" && original) {
        // A failed acknowledgement may follow a committed tombstone. Keep its
        // immutable request available for retry even after the list refreshes.
        if (deleteAttempted()) {
          const snapshot = await serverApi.fetchMission(instanceId, original.id)
          if (!current()) return
          if (!snapshot.available || snapshot.cleanupUnavailable) throw new MissionDeletionError(503)
          const intent = snapshot.cleanups.find(item => item.missionID === original.id && item.requestID === requestId
            && item.expectedRevision === original.revision && item.deleteManagedSessions === deleteManagedSessions())
          if (intent && !missionCleanupPending(intent)) { props.onSaved(); return }
          const live = snapshot.mission
          if (!intent && live && live.revision !== original.revision) throw new MissionDeletionError(404)
          // Neither the map nor its cleanup: capacity may have purged a committed
          // deletion's history. Its durable record answers this exact original request.
        }
        setDeleteAttempted(true)
        await serverApi.deleteMission(instanceId, original.id, { expectedRevision: original.revision, requestId, deleteManagedSessions: deleteManagedSessions() })
        if (current()) props.onSaved()
      } else {
        const result = await serverApi.createMission(instanceId, { ...fields, directory, requestId })
        if (kind === "create") releaseMissionCreation(origin, creation.requestId)
        if (current()) props.onSaved(result.mission)
        else if (identity() === origin && missionStore.demandedInstanceIds().includes(instanceId)) void missionStore.refresh(instanceId)
      }
    } catch (error) {
      const definitive = kind !== "create" || isDefinitiveCreationRejection(error)
      if (kind === "create") {
        if (definitive) releaseMissionCreation(origin, creation.requestId)
        else {
          retainUncertainMissionCreation(origin, creation)
          retainSubmittedMissionModel(creation.requestId, modelIdentity)
        }
      }
      if (!current()) return
      if (kind === "delete" && original) {
        // Reads can settle a lost HTTP acknowledgement, but never replay a write.
        // Unknown intent keeps the original option/request fenced until verified.
        let key = deletionErrorKey(error)
        try {
          const snapshot = await serverApi.fetchMission(instanceId, original.id)
          if (!current()) return
          const intent = snapshot.available && !snapshot.cleanupUnavailable && snapshot.cleanups.find(item => item.missionID === original.id && item.requestID === requestId
            && item.expectedRevision === original.revision && item.deleteManagedSessions === deleteManagedSessions())
          if (intent && !missionCleanupPending(intent)) { props.onSaved(); return }
          if (intent) key = intent.documentPending ? "missions.cleanup.documentPending" : "missions.cleanup.error.pending"
          else if (snapshot.available && !snapshot.cleanupUnavailable && snapshot.mission
            && error instanceof MissionDeletionError && [400, 403, 409].includes(error.status)) setDeleteAttempted(false)
        } catch { /* Unknown observation is not permission to change the intent. */ }
        if (current()) { setError(t(key)); void missionStore.refresh(instanceId) }
      } else {
        // An unknown create stays visible through its adopted hold, never as a retryable error.
        if (definitive) setError(t(missionMutationErrorKey(error)))
      }
    } finally { if (current()) setPending(false) }
  }

  const inlineError = (field: FieldError["field"], id: string) =>
    <Show when={errorFor(field)}>{message => <span id={id} class="mission-create-field-error" role="alert">{message()}</span>}</Show>

  const createBody = () => <>
    <label for={ids.objective}>{t("missions.create.objective")}</label>
    <textarea id={ids.objective} required maxLength={mode() === "recurring" ? MISSION_LIFECYCLE_TEXT_LIMIT : 20_000} value={objective()}
      placeholder={t("missions.create.objectivePlaceholder")} disabled={textLocked()}
      aria-invalid={Boolean(errorFor("objective"))} aria-describedby={errorFor("objective") ? ids.objectiveError : undefined}
      onInput={e => setObjective(e.currentTarget.value)} />
    {inlineError("objective", ids.objectiveError)}
    <Show when={mode() === "recurring" && sourceLocationReady() && !sourceInputBudget().sufficient && !errorFor("objective")}>
      <span class="mission-create-field-error" role="alert">{t(watchedIDs().length ? "missions.recurrence.sourceInputTooLong" : "missions.recurrence.instructionsTooLong", { limit: MISSION_LIFECYCLE_TEXT_LIMIT })}</span>
    </Show>
    <label>{t("missions.create.title")}
      <input maxLength={MISSION_TITLE_MAX} value={title()} placeholder={derivedTitle()} disabled={structuralLocked()}
        onInput={e => setTitleOverride(e.currentTarget.value)} />
    </label>
    <Show when={kind === "edit" && structuralReason()}>{reason => <p role="status">{t(`missions.scheduling.lock.${reason()}`)}</p>}</Show>
    <Show when={template() === "compare"}>
      <MissionProfileControls instanceId={props.instanceId} directory={props.directory} template="compare" profiles={profiles()}
        roles={["model-a", "model-b"]} taskMode={taskMode()} disabled={structuralLocked()} active={isActive}
        onChange={value => { setCustomProfiles(true); setProfiles(value) }} />
      <Show when={compareError()}>{error => <p role="alert" class="mission-create-field-error">{t(`missions.compare.${error()}`)}</p>}</Show>
      <Show when={judgeWarning()}><p role="status">{t("missions.compare.judgeWarning")}</p></Show>
    </Show>
    <details class="mission-profile-optional mission-create-options" open={optionsOpen()} onToggle={event => setOptionsOpen(event.currentTarget.open)}>
      <summary>{t("missions.create.options")}</summary>
      {/* Natively hidden while closed so local drafts survive; network demand follows optionsOpen. */}
      <Show when={kind === "create"}><MissionBriefPicker disabled={locked() || !isActive()} active={() => optionsOpen() && isActive()} value={selectedModel()?.id}
        onUse={model => {
          requestId = crypto.randomUUID(); lastPayload = ""; setError(""); setFieldError(undefined)
          setObjective(model.objective); setTitleOverride(undefined); setNotes(model.notes); setTemplate(model.template); setSelectedModel({ id: model.id, name: model.name })
          setCustomProfiles(model.profiles !== undefined)
          setCustomTaskMode(model.taskMode !== undefined); setTaskMode(model.taskMode ?? missionTaskModeFor(defaults(), model.template))
          setProfiles(model.profiles === undefined ? missionDefaultsFor(defaults(), model.template) : copyMissionProfiles(model.profiles))
        }} /></Show>
      {/* The selected playbook's one-sentence description stays visible under its selector. */}
      <div class="mission-create-template">
        <label>{t("missions.control.template")}
          <select aria-label={t("missions.control.template")} aria-describedby={ids.templateDescription} value={template()} disabled={structuralLocked() || kind === "edit" && !schedule.document()?.edit.template} onChange={e => {
            const next = e.currentTarget.value as MissionPanelMap["template"]
            setTemplate(next); setProfiles(customProfiles() ? profilesForTemplate(profiles(), next) : missionDefaultsFor(defaults(), next))
            if (!customTaskMode()) setTaskMode(missionTaskModeFor(defaults(), next))
          }}>
            <For each={["custom", "debug", "wayfinder", "delivery", "compare"] as const}>{id => <option value={id}>{t(`missions.control.template.${id}`)}</option>}</For>
          </select>
          <Show when={schedule.document()?.edit.templateReason === "ever-created-task"}><small>{t("missions.scheduling.lock.ever-created-task")}</small></Show>
        </label>
        <p id={ids.templateDescription}>{t(`missions.control.template.${template()}.description`)}</p>
        {/* Steps, roles and the exact instructions open in the central reader. On narrow layouts that
            closes the panel, ending the view a request in flight completes in, so wait for it. */}
        <Show when={props.onShowPlaybook}>
          <button type="button" class="window-text-button" aria-describedby={ids.templateDescription} disabled={pending() || creationPending()}
            onClick={() => props.onShowPlaybook?.(template(), taskMode() ?? "native")}>{t("missions.playbook.details")}</button>
        </Show>
      </div>
      <MissionTaskModeControls value={taskMode() ?? "native"} disabled={structuralLocked()}
        onChange={value => { setTaskMode(value); setCustomTaskMode(true) }} />
      {/* Native nesting depth is project configuration, shared with every conversation there. */}
      <Show when={kind === "create"}><MissionSubagentDepth instanceId={props.instanceId} directory={props.directory ?? props.viewDirectory} active={() => optionsOpen() && isActive()} /></Show>
      <section class="mission-create-option" aria-label={t("missions.create.agents")} aria-describedby={errorFor("profiles") ? ids.profilesError : undefined}>
        <MissionProfileSummary instanceId={props.instanceId} directory={props.directory} template={template()} profiles={profiles()} />
        {/* Catalog-backed selectors mount (and read the native catalog) only on demand. */}
        <details class="mission-profile-optional" open={profileDetailsOpen()} onToggle={event => setProfileDetailsOpen(event.currentTarget.open)}>
          <summary>{t("missions.create.agents")}</summary>
          <Show when={profileDetailsOpen()}>
            <MissionProfileControls instanceId={props.instanceId} directory={props.directory} template={template()} profiles={profiles()}
              roles={template() === "compare" ? ["coordinator", "comparator"] : undefined}
              taskMode={taskMode()}
              disabled={structuralLocked()} active={() => profileDetailsOpen() && optionsOpen() && isActive()}
              onChange={value => { setCustomProfiles(true); setProfiles(value) }} />
          </Show>
          <div class="mission-create-option-actions">
            <button type="button" class="window-text-button" disabled={structuralLocked()} onClick={() => void useSavedDefaults()}>{t("missions.defaults.use")}</button>
            <Show when={props.onOpenPreferences}><button type="button" class="window-text-button" title={t("missions.defaults.hint")} onClick={props.onOpenPreferences}>{t("missions.defaults.manage")}</button></Show>
          </div>
        </details>
        {inlineError("profiles", ids.profilesError)}
      </section>
      <label>{t("missions.control.notes")}
        <textarea maxLength={20_000} value={notes()} disabled={textLocked()} onInput={e => setNotes(e.currentTarget.value)} />
      </label>
      <Show when={mode() === "recurring" || watchedIDs().length > 0}>
        <MissionConversationPicker instanceId={props.instanceId} directory={props.directory} projectID={props.projectID}
          value={watchedIDs()} disabled={structuralLocked()} active={() => mode() === "recurring" && optionsOpen() && isActive()} onChange={setWatched} />
        {inlineError("followed", ids.followedError)}
        <Show when={needsSourceLocation() && !sourceLocationReady() && !errorFor("followed")}><p role={sourceLocationFailed() ? "alert" : "status"}>{t(sourceLocationFailed() ? "missions.recurrence.sourceLocationUnavailable" : "missions.control.loading")}</p></Show>
      </Show>
    </details>
    <MissionScheduling draft={schedule.scheduling()} directory={schedule.directory()} sources={sourceChoices.sources()}
      capability={schedule.capability()} lockReason={structuralReason()} disabled={structuralLocked()}
      persisted={schedule.document()?.firstPlayedAt != null ? { firstPlayedAt: schedule.document()!.firstPlayedAt!,
        oneShotAt: schedule.document()!.oneShotAt, slotEndsAt: schedule.document()!.slotEndsAt,
        nextDueAt: schedule.document()!.observation.nextDueAt, launchedCount: schedule.document()!.launchedCount } : undefined}
      anchorAt={schedule.anchorAt()} onChange={schedule.setScheduling} onPolicy={value => setPolicyReady(!!value)} />
    <Show when={immediateFollowed()}><p role="status">{t(immediateCreationFollowed() ? "missions.scheduling.immediateCreationFollowed" : "missions.scheduling.immediateFollowed")}</p></Show>
    <Show when={schedule.capability() === "missing"}><button type="button" class="window-action" disabled={busy() || schedule.reading()}
      onClick={schedule.retryRead}>{t("missions.control.retry")}</button></Show>
    <Show when={(observationUnknown() || schedule.document()?.edit.reason === "uncertain") && !schedule.held() && !schedule.conflict()}>
      <button type="button" class="window-action" disabled={pending() || schedule.reading()} onClick={schedule.retryRead}>{t("missions.scheduling.reload")}</button>
    </Show>
    <Show when={sourceChoices.next()}><button type="button" class="window-action" disabled={sourceChoices.loading() || structuralLocked()}
      onClick={sourceChoices.more}>{t("missions.scheduling.moreSources")}</button></Show>
    <Show when={sourceChoices.failed()}><button type="button" class="window-action" disabled={sourceChoices.loading() || structuralLocked()}
      onClick={sourceChoices.reload}>{t("missions.control.refresh")}</button></Show>
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

  const createDisabled = () => locked() || !isActive() || !objective().trim() || Boolean(compareError()) || !policyReady()
    || immediateCreationFollowed()
    || mode() === "recurring" && (!sourceLocationReady() || !sourceInputBudget().sufficient)
  // In the panel, creation's body scrolls above a fixed footer unless the panel is too short (mission-create.css).
  let body: HTMLDivElement | undefined
  const panelScrolls = kind === "create" ? missionPanelScroll(() => body) : () => false

  return <form class="mission-editor window-shell" classList={{ "mission-create": kind === "create" }} onSubmit={save} aria-label={t(`missions.control.${kind}`)}
    data-scroller={panelScrolls() ? "panel" : undefined}>
    {/* Creation is headed by the panel's own Create button; edit/delete keep their title. */}
    <Show when={kind !== "create"}><header class="window-header"><h3 class="window-title">{t(`missions.control.${kind}`)}</h3></header></Show>
    <div class="window-body" ref={body}>
      <Show when={kind !== "delete"} fallback={<>
        <p>{t("missions.control.delete.detail")}</p>
        <label class="mission-delete-sessions"><input type="checkbox" checked={deleteManagedSessions()} disabled={pending() || deleteAttempted()}
          onChange={event => setDeleteManagedSessions(event.currentTarget.checked)} />{t("missions.control.delete.sessions")}</label>
      </>}>{createBody()}</Show>
      {/* A field changed since this edit opened is never prefilled: reopen it on the current map. */}
      <Show when={prefilling()}><MissionBodyPending failed={reopen() === "failed" || reopen() === "idle" && prefillState() === "failed"}
        changed={reopen() === "idle" && prefillState() === "changed"} actionLabel={offersReopen() ? "missions.control.reopen" : undefined}
        onRetry={() => offersReopen() ? reopenEdit() : retryMissionTarget([editedObjective(), editedNotes()])} /></Show>
      <Show when={!schedule.ready()}><p role={schedule.failed() ? "alert" : "status"}>{t(schedule.failed() ? "missions.scheduling.loadFailed" : "missions.control.loading")}</p>
        <Show when={schedule.failed()}><button type="button" class="window-action" onClick={schedule.retryRead}>{t("missions.control.refresh")}</button></Show></Show>
      <Show when={schedule.conflict()}><p role="alert">{t("missions.control.mutation.conflict")}</p>
        <button type="button" class="window-action" disabled={schedule.reading() || !!schedule.held()} onClick={() => void schedule.reload()}>{t("missions.scheduling.reload")}</button></Show>
      <Show when={schedule.previousDraft()}>{previous => <details class="mission-profile-optional"><summary>{t("missions.scheduling.previousDraft")}</summary>
        <textarea readOnly rows={8} value={previous()} aria-label={t("missions.scheduling.previousDraft")} /></details>}</Show>
      <Show when={uncertain()} fallback={<Show when={error()}><p role="alert">{error()}</p></Show>}><p role="alert">{t(schedule.held()
        ? otherUncertain() ? "missions.scheduling.uncertainOther" : "missions.scheduling.uncertain"
        : otherUncertain() ? "missions.control.creation.uncertainOther" : "missions.control.creation.uncertain")}</p></Show>
    </div>
    <footer class="window-footer">
      <Show when={kind === "create"}>
        {/* An unsent draft beside another request's hold may still be kept as a brief. */}
        <MissionBriefSave buttonClass="button-secondary" disabled={(otherUncertain() ? !creationReady() || defaultsRefreshing() : locked()) || !isActive()} active={isActive}
          draft={() => ({ objective: objective(), notes: notes(), template: template(), ...(customProfiles() ? { profiles: copyMissionProfiles(profiles()) ?? {} } : {}), ...(customTaskMode() ? { taskMode: taskMode() } : {}) })} />
      </Show>
      <button type="button" class="button-secondary" onClick={props.onCancel}>{t("missions.control.cancel")}</button>
      <Show when={needsSourceLocation() && sourceLocationFailed() && !uncertain()}><button type="button" class="button-secondary"
        onClick={() => setSourceLocationRevision(value => value + 1)}>{t("missions.control.refresh")}</button></Show>
      <Show when={uncertain()}><button type="button" class="button-secondary" disabled={schedule.reading()} onClick={() => {
        if (!isActive()) return
        if (schedule.held()) void schedule.reconcile()
        else if (mode() === "recurring") props.onRecurrenceRefresh?.()
        else void missionStore.refresh(props.instanceId)
      }}>{t(schedule.held() ? "missions.scheduling.readReceipt" : "missions.control.refresh")}</button></Show>
      <Show when={uncertain() && schedule.retryable()}><button type="button" class="button-secondary" disabled={schedule.reading()}
        onClick={() => void schedule.retryPreparation()}>{t("missions.control.retry")}</button></Show>
      <Show when={kind === "create"} fallback={
          <button type="submit" class="button-primary" disabled={locked() || !isActive() || (kind !== "delete" && (textLocked() || !objective().trim() || !structuralLocked() && !policyReady()))}>
          {t(pending() ? "missions.control.mutation.pending" : kind === "delete"
            ? deleteAttempted() ? "missions.control.retry" : "missions.control.delete" : "missions.control.save")}
        </button>}>
        <button type="submit" class="button-primary" disabled={createDisabled()}>
          {t(pending() || creationPending() ? "missions.control.mutation.pending" : "missions.create.submit")}
        </button>
      </Show>
    </footer>
  </form>
}
