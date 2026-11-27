import { For, Index, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, untrack } from "solid-js"
import type { MissionPanelMap } from "../../../server/src/api-types"
import { compareModelError, freezeCompareProfiles, type MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import { backendOf } from "../lib/backend-client"
import { generateUUID } from "../lib/client-identity"
import { useI18n } from "../lib/i18n"
import { deletionErrorKey, missionCleanupPending, MissionDeletionError } from "../lib/mission-cleanup"
import { missionStore } from "../stores/missions"
import { createMissionViewFence } from "../lib/mission-view-fence"
import { captureBackendOperation } from "../lib/backend-operation"
import { isDefinitiveCreationRejection, missionMutationErrorKey } from "../lib/mission-mutation"
import { HttpResponseError } from "../lib/retryable-file-search"
import { copyMissionProfiles, holdMissionCreation, missionCreationHold, missionCreationPayloadIdentity, releaseMissionCreation,
  consumeMissionCreation, reconcileMissionCreation, retainUncertainMissionCreation, uncertainMissionCreation } from "../stores/mission-creation-drafts"
import { MissionProfileControls } from "./mission-profile-controls"
import { MissionProfileSummary } from "./mission-profile-summary"
import { missionProfileRoles, profilesForTemplate } from "./mission-profile-controls-data"
import { useConfig } from "../stores/preferences"
import { missionDefaultsFor, missionTaskModeFor, normalizeMissionDefaults, type MissionTaskMode } from "../lib/mission-defaults"
import type { MissionProfileDefault } from "../lib/mission-defaults"
import { missionConfigurationTitle, retainSubmittedMissionModel, submittedMissionModel, type UserMissionModel } from "../lib/mission-model-library"
import { MissionBriefPicker, MissionBriefSave } from "./mission-model-library"
import { MissionTaskModeControls } from "./mission-task-mode-controls"
import { MissionSubagentDepth } from "./mission-subagent-depth"
import { missionPanelScroll } from "./mission-panel-scroll"
import { MISSION_LIFECYCLE_TEXT_LIMIT, recurrenceStartText } from "../../../server/src/missions/lifecycle-input"
import { recurrenceInputBudget } from "../../../server/src/missions/recurrence-read-budget"
import { MISSION_TITLE_MAX, deriveMissionTitle } from "../../../server/src/missions/mission-title"
import { getRootClient } from "../stores/opencode-client"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { instances } from "../stores/instances"
import { createRequestLocation, requestLocationOptions, toRequestLocation } from "../stores/request-locations"
import { recordMissionDraftBaseline, registerMissionDraftBaseline, type MissionEditorAction, type MissionEditorDraft } from "../stores/mission-editor-state"
import { MissionBodyPending } from "./mission-reader-body"
import { missionTargetState, retryMissionTarget, useTargetBody } from "./mission-target-bodies"
import { missionScheduleEditorHold } from "../stores/mission-schedule-editor-holds"
import { createMissionEditorScheduling } from "./mission-editor-schedule"
import { isMissionEventKind, isMissionPickerSource, isRepositoryCriterion, missionSchedulingPolicy } from "./mission-scheduling-data"
import { MissionScheduling, type MissionSchedulingLock } from "./mission-scheduling"
import { createMissionEditorSources } from "./mission-editor-sources"
import { requiresMissionCalendar } from "../../../server/src/missions/mission-launch-kind"
import { createMissionCreationStart } from "./mission-creation-start"
import { SettingsInfoTip } from "./settings/settings-info-tip"
import { MissionSourceSelect } from "./mission-source-select"
import { createMissionEditorRepository } from "./mission-editor-repository"
import { X } from "lucide-solid"

export type { MissionEditorAction }
type FieldError = { field: "objective" | "profiles" | "followed" | "coordinator"; message: string }

export function MissionEditor(props: {
  instanceId: string; directory?: string; viewDirectory?: string; projectID?: string; action: MissionEditorAction
  active?: () => boolean
  captureOperation?: () => (() => boolean)
  /** `missionID`: the Mission a saved programming is right now. */
  onSaved: (mission?: MissionPanelMap, scheduleID?: string, missionID?: string) => void; onCancel: () => void
  onOpenPreferences?: () => void
  /** Opens the selected playbook's details under the chosen task-session policy. */
  onShowPlaybook?: (template: MissionPanelMap["template"], taskMode: MissionTaskMode) => void
  onRecurrenceRefresh?: () => void
  /** On unmount: the idle draft to reopen, null to reopen as opened (an edit still reading
   * its fields), or undefined while a request is in flight or held. */
  onDispose?: (draft?: MissionEditorDraft | null) => void
  /** Opens this edit again on the current map (its fields changed since it opened); settles
   * once it did, or chose not to, and rejects when the current map could not be read. */
  onReopen?: () => Promise<void>
}) {
  const { t } = useI18n()
  const ids = { objective: createUniqueId(), objectiveError: createUniqueId(), profilesError: createUniqueId(), followedError: createUniqueId() }
  const config = useConfig(() => props.instanceId)
  // The revision and draft belong to this editor, not to live snapshot refreshes.
  const action = props.action, original = action.mission, kind = action.kind
  // The UI's physical folder fences the view; it must not replace the server's
  // existing native default location (notably on WSL) in the creation request.
  const identity = () => JSON.stringify([props.instanceId, props.viewDirectory ?? props.directory, props.projectID])
  const captureEditorView = createMissionViewFence(identity, () => props.active?.() ?? true)
  const captureView = () => captureBackendOperation(props.instanceId, undefined, captureEditorView()).current
  const isActive = () => props.active?.() ?? true
  const scheduleScope = () => JSON.stringify([identity(), kind === "create" ? "create" : action.scheduleID ?? original?.id])
  const scheduleHold = missionScheduleEditorHold(scheduleScope())
  const held = kind === "create" ? uncertainMissionCreation(identity()) : undefined
  // An exact held contract wins over the draft this editor left when its panel unmounted.
  const draft = scheduleHold?.draft ?? (held ? undefined : action.draft)
  const [titleOverride, setTitleOverride] = createSignal<string | undefined>(held?.title ?? draft?.titleOverride ?? original?.title)
  const [watched, setWatched] = createSignal<string[]>([...held?.watchedConversationIDs ?? draft?.watched ?? []])
  const [coordinatorSessionID, setCoordinatorSessionID] = createSignal<string | undefined>(draft?.coordinatorSessionID
    ?? draft?.scheduleDocument?.configuration.coordinatorSessionID)
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
  const [objective, setObjective] = createSignal(held?.objective ?? draft?.objective ?? "")
  const derivedTitle = () => deriveMissionTitle(objective())
  const title = () => titleOverride() ?? derivedTitle()
  const submittedTitle = () => title().trim() || derivedTitle()
  const [notes, setNotes] = createSignal(held?.notes ?? draft?.notes ?? "")
  createEffect(() => {
    const objectiveField = editedObjective(), notesField = editedNotes()
    if (!prefilling() || reopen() === "pending" || objectiveField.state !== "ready" || notesField.state !== "ready") return
    setObjective(objectiveField.value ?? ""); setNotes(notesField.value ?? "")
    setPrefilling(false)
  })
  const [template, setTemplate] = createSignal<MissionPanelMap["template"]>(held?.template ?? draft?.template ?? original?.template ?? "custom")
  const [profiles, setProfiles] = createSignal<MissionProfiles | undefined>(copyMissionProfiles(held?.profiles ?? draft?.profiles ?? original?.profiles))
  const [customProfiles, setCustomProfiles] = createSignal(Boolean(held || draft?.customProfiles))
  const [profilesOpen, setProfilesOpen] = createSignal(draft?.profileDetailsOpen ?? false)
  let profilesFold: HTMLDetailsElement | undefined
  const [taskMode, setTaskMode] = createSignal<MissionTaskMode | undefined>(draft ? draft.taskMode : held?.taskMode ?? original?.taskMode ?? "native")
  const [customTaskMode, setCustomTaskMode] = createSignal(Boolean(held || draft?.customTaskMode))
  const [defaults, setDefaults] = createSignal<MissionProfileDefault[]>(draft?.defaults ?? [])
  const [defaultsReady, setDefaultsReady] = createSignal(kind !== "create" || Boolean(held || draft?.defaultsReady))
  const [defaultsRefreshing, setDefaultsRefreshing] = createSignal(false)
  const [defaultsFailed, setDefaultsFailed] = createSignal(false)
  const creationReady = () => defaultsReady() && (kind !== "create" || Boolean(held) || config.isUiConfigLoaded())
  const effectiveProfiles = () => freezeCompareProfiles(template(), profiles())
  const compareError = () => template() === "compare" ? compareModelError(profiles()) : undefined
  const [selectedModel, setSelectedModel] = createSignal<UserMissionModel | undefined>(held ? submittedMissionModel(held.requestId)
    : draft?.selectedModel)
  let draftId = held ? generateUUID() : draft?.draftId ?? generateUUID()
  const [savedBaselines, setSavedBaselines] = createSignal<UserMissionModel[]>(
    held ? (selectedModel() ? [selectedModel()!] : [])
      : draft?.savedBaselines ? [...draft.savedBaselines] : selectedModel() ? [selectedModel()!] : [],
  )
  const applySavedBaseline = (saved: UserMissionModel) => {
    setSavedBaselines(current => [...current.filter(item => item.id !== saved.id), saved])
    if (selectedModel()?.id === saved.id) setSelectedModel(saved)
  }
  let unregisterDraftBaseline = registerMissionDraftBaseline(draftId, applySavedBaseline)
  onCleanup(() => unregisterDraftBaseline())
  const resetDraftBaselines = (model?: UserMissionModel) => {
    unregisterDraftBaseline()
    draftId = generateUUID()
    unregisterDraftBaseline = registerMissionDraftBaseline(draftId, applySavedBaseline)
    setSavedBaselines(model ? [model] : [])
  }
  const captureDraftCommit = () => {
    const originatingDraftId = draftId
    return (saved: UserMissionModel) => recordMissionDraftBaseline(originatingDraftId, saved)
  }
  const initialConfigurationName = () => {
    const loaded = selectedModel(), current = submittedTitle()
    return loaded && missionConfigurationTitle(loaded.name) === current ? loaded.name : current
  }
  // One creation-time snapshot only, after the owned preference document loads.
  // Refreshes and other windows' preference edits never replace this draft.
  createEffect(() => {
    if (defaultsReady() || !config.isUiConfigLoaded() || !config.missionDefaultsValid()) return
    const loaded = normalizeMissionDefaults(config.preferences().missionProfileDefaults)
    setDefaults(loaded); setProfiles(missionDefaultsFor(loaded, template())); setTaskMode(missionTaskModeFor(loaded, template()))
    setDefaultsReady(true)
  })
  // A one-time hold is adopted when it is unknown at mount or met at submission;
  // a newer editor keeps its own draft while another request is merely pending.
  const [adopted, setAdopted] = createSignal(Boolean(held))
  const creationHold = () => kind === "create" && adopted() ? missionCreationHold(identity()) : undefined
  const creationPending = () => creationHold()?.state === "pending"
  const [creationReading, setCreationReading] = createSignal(false)
  const reconcileCreation = async () => {
    const scope = identity(), instanceId = props.instanceId, view = captureView()
    const operation = props.captureOperation?.() ?? (() => true)
    const current = () => view() && operation() && props.action === action
    const owner = { client: instances().get(instanceId)?.client, generation: getOpenCodeInstanceGeneration(instanceId) }
    const ownerCurrent = () => instances().get(instanceId)?.client === owner.client && getOpenCodeInstanceGeneration(instanceId) === owner.generation
    setCreationReading(true)
    try {
      const receipt = await reconcileMissionCreation(scope, instanceId, owner, ownerCurrent)
      if (!current() || !ownerCurrent() || !receipt || !consumeMissionCreation(scope, receipt, owner)) return
      if (receipt.state === "created") props.onSaved(receipt.mission)
    } finally { if (current() && ownerCurrent()) setCreationReading(false) }
  }
  createEffect(on([() => creationHold()?.state, isActive, identity, () => instances().get(props.instanceId)?.client, () => getOpenCodeInstanceGeneration(props.instanceId)], () => {
    if (isActive() && creationHold()?.state === "uncertain") void reconcileCreation()
  }))
  const uncertain = () => creationHold()?.state === "uncertain" || schedule.held()?.state === "uncertain"
  // The request whose exact draft this editor shows. An adopted hold from another
  // editor leaves this draft unsent; its wording must not claim otherwise.
  const [shownRequestId, setShownRequestId] = createSignal(held?.requestId)
  const otherUncertain = () => creationHold()?.state === "uncertain"
    && creationHold()!.operation.requestId !== shownRequestId() || schedule.held()?.state === "uncertain"
      && JSON.parse(schedule.held()!.payload).requestID !== requestId
  const busy = () => pending() || uncertain() || creationPending() || !!schedule.held()
  // Deletion asks nothing: it takes the Preferences' choice for task conversations, fixed for its one request.
  const deleteManagedSessions = () => deleteSessions
  const deleteSessions = draft?.deleteManagedSessions ?? untrack(() => config.preferences().missionDeleteSessions)
  const [startOnCreation, setStartOnCreation] = createSignal(Boolean(held?.startOnCreation ?? draft?.startOnCreation))
  const [coordinatorGoal, setCoordinatorGoal] = createSignal(Boolean(held?.coordinatorGoal ?? draft?.coordinatorGoal ?? original?.coordinatorGoal))
  const [deleteAttempted, setDeleteAttempted] = createSignal(Boolean(draft?.deleteAttempted))
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal("")
  const [fieldError, setFieldError] = createSignal<FieldError>()
  const fail = (field: FieldError["field"], message: string) => {
    if (field === "profiles") setProfilesOpen(true)
    setFieldError({ field, message })
  }
  const errorFor = (field: FieldError["field"]) => fieldError()?.field === field ? fieldError()!.message : undefined
  const schedule = createMissionEditorScheduling({ instanceId: props.instanceId, directory: props.directory, action, draft,
    scope: scheduleScope, owner: identity, active: isActive, captureView: () => {
      const view = captureView(), operation = props.captureOperation?.() ?? (() => true)
      const generation = getOpenCodeInstanceGeneration(props.instanceId)
      return () => view() && operation() && props.action === action && getOpenCodeInstanceGeneration(props.instanceId) === generation
    },
    onLoad: config => {
      setTitleOverride(config.title); setObjective(config.objective); setNotes(config.notes ?? ""); setTemplate(config.template)
      setProfiles(copyMissionProfiles(config.profiles)); setTaskMode(config.taskMode); setWatched(config.watchedConversationIDs)
      setCoordinatorSessionID(config.coordinatorSessionID)
      setCoordinatorGoal(Boolean(config.coordinatorGoal))
      setCustomProfiles(true); setCustomTaskMode(true)
    }, captureDraft: () => captureDraft(), onSaved: (mission, scheduleID) => props.onSaved(mission, scheduleID) })
  const policy = createMemo(() => { try { return missionSchedulingPolicy(schedule.scheduling(), schedule.directory()) } catch { return undefined } })
  const mode = () => policy() && !requiresMissionCalendar(policy()!) ? "once" : "recurring"
  const captureStart = createMissionCreationStart({ instanceId: props.instanceId, get projectID() { return props.projectID },
    get directory() { return props.viewDirectory ?? props.directory ?? props.instanceId }, active: isActive,
    captureView: () => {
      const view = captureView(), operation = props.captureOperation?.() ?? (() => true)
      return () => view() && operation() && props.action === action
    }, refresh: () => { void missionStore.refresh(props.instanceId); props.onRecurrenceRefresh?.() } })
  const time = () => schedule.scheduling().criteria.find(row => row.kind === "daily")?.time ?? "09:00", zone = () => schedule.scheduling().zone
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
  const [policyReady, setPolicyReady] = createSignal(false)
  const sourceChoices = createMissionEditorSources({ instanceId: props.instanceId, projectID: props.projectID,
    target: action.scheduleID ?? original?.id, directory: schedule.directory,
    kinds: () => [...schedule.scheduling().criteria.flatMap(row => isMissionEventKind(row.kind) ? [row.kind] : []),
      ...(watched().length ? ["conversation-message" as const] : []),
      ...(coordinatorSessionID() !== undefined && mode() === "recurring" ? ["coordinator-session" as const] : [])],
     selected: () => [...schedule.scheduling().criteria.flatMap(row => isMissionPickerSource(row.kind) && row.source
      ? [{ kind: row.kind, id: row.source }] : []), ...watched().filter(Boolean).map(id => ({ kind: "conversation-message" as const, id })),
      ...(coordinatorSessionID() ? [{ kind: "coordinator-session" as const, id: coordinatorSessionID()! }] : [])],
    active: isActive, captureView })
  const repository = createMissionEditorRepository({ instanceId: props.instanceId, directory: schedule.directory, captureView,
    active: () => isActive() && schedule.scheduling().criteria.some(row => isRepositoryCriterion(row.kind)) })
  const watchedIDs = watched
  const needsSourceLocation = createMemo(() => watchedIDs().length > 0)
  const watchedValid = () => watchedIDs().length <= 32 && new Set(watchedIDs()).size === watchedIDs().length
    && watchedIDs().every(id => /^[A-Za-z0-9_.:-]{1,240}$/.test(id))
  const sourceIdentity = createMemo(() => JSON.stringify([identity(), props.directory, getOpenCodeInstanceGeneration(props.instanceId)]))
  const [sourceLocation, setSourceLocation] = createSignal<{ key: string; directory: string }>()
  const [sourceLocationFailed, setSourceLocationFailed] = createSignal(false)
  const [sourceLocationRevision, setSourceLocationRevision] = createSignal(0)
  const sourceLocationActive = createMemo(() => needsSourceLocation() && creationReady() && isActive())
  createEffect(on([sourceIdentity, sourceLocationRevision, sourceLocationActive], () => {
    if (!sourceLocationActive()) return
    const key = sourceIdentity(), viewCurrent = captureView(), controller = new AbortController()
    const operation = captureBackendOperation(props.instanceId, controller.signal)
    let alive = true
    setSourceLocation(undefined); setSourceLocationFailed(false)
    const location = createRequestLocation(props.directory)
    const current = () => operation.current() && alive && viewCurrent() && sourceIdentity() === key
    void getRootClient(props.instanceId).location.get({ location: toRequestLocation(location) }, {
      ...requestLocationOptions(location), signal: AbortSignal.any([operation.signal, AbortSignal.timeout(10_000)]),
    }).then(value => {
      if (!current()) return
      if (!value.directory || value.directory.length > 4096 || value.directory.includes("\0")
        || props.projectID && value.project.id !== props.projectID) throw new Error("Native source Location differs")
      setSourceLocation({ key, directory: value.directory })
    }).catch(() => { if (current()) setSourceLocationFailed(true) })
    onCleanup(() => { alive = false; controller.abort() })
  }))
  const sourceLocationReady = () => !needsSourceLocation() || sourceLocation()?.key === sourceIdentity()
  const coordinatorReady = () => coordinatorSessionID() === undefined || mode() === "recurring"
    && !watchedIDs().includes(coordinatorSessionID()!)
    && !schedule.scheduling().criteria.some(row => row.kind === "conversation-message" && row.source === coordinatorSessionID())
    && !!sourceChoices.sources()["coordinator-session"]?.some(row => row.id === coordinatorSessionID())
  const sourceInputBudget = () => recurrenceInputBudget({ consigne: objective().trim(), watchedConversationIDs: watchedIDs(),
    roots: sourceLocation()?.key === sourceIdentity() ? [{ directory: sourceLocation()!.directory }] : [] })
  let requestId = held?.requestId ?? draft?.requestId ?? generateUUID(), lastPayload = draft?.lastPayload ?? ""
  const calendarID = action.calendar ?? draft?.calendarID ?? `cal_${generateUUID().replaceAll("-", "")}`
  const locked = () => !creationReady() || defaultsRefreshing() || busy() || prefilling() || !schedule.ready() || schedule.conflict() || schedule.reading()
  // Only an idle draft is kept: a request in flight or held settles through its own hold.
  const captureDraft = (): MissionEditorDraft => ({ mode: mode(), titleOverride: titleOverride(), time: time(), zone: zone(),
    watched: watched(), objective: objective(), notes: notes(), template: template(), profiles: copyMissionProfiles(profiles()),
    customProfiles: customProfiles(), taskMode: taskMode(), customTaskMode: customTaskMode(), defaults: defaults(),
    defaultsReady: defaultsReady(), draftId, selectedModel: selectedModel(), savedBaselines: savedBaselines(), optionsOpen: true, profileDetailsOpen: profilesFold?.open ?? profilesOpen(),
    requestId, lastPayload, calendarID, deleteManagedSessions: deleteManagedSessions(), deleteAttempted: deleteAttempted(), startOnCreation: startOnCreation(),
    coordinatorGoal: coordinatorGoal(),
    ...(coordinatorSessionID() !== undefined ? { coordinatorSessionID: coordinatorSessionID() } : {}),
    deleteAutoSubmitted: kind === "delete" && !autoSubmit(), deleteError: kind === "delete" ? error() : undefined,
    scheduling: structuredClone(schedule.scheduling()), scheduleDocument: schedule.document(),
    previousDraft: schedule.previousDraft(), journalMission: schedule.journal() })
  onCleanup(() => props.onDispose?.(kind === "delete" ? captureDraft() : busy() ? undefined : prefilling() ? null : captureDraft()))

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
    finally { setDefaultsRefreshing(false) }
  }

  // A direct creation ACK may continue the captured opt-in through guarded Play.
  async function save(event: SubmitEvent) {
    event.preventDefault()
    if (locked() || !isActive()) return
    setFieldError(undefined)
    if (kind !== "delete" && !structuralLocked() && compareError()) return
    if (!structuralLocked()) {
      if (!watchedValid()) { fail("followed", t("missions.recurrence.watchedInvalid")); return }
      if (!sourceLocationReady()) { fail("followed", t("missions.recurrence.sourceLocationUnavailable")); return }
      if ((mode() === "recurring" || watchedIDs().length) && !sourceInputBudget().sufficient) {
        fail("objective", t("missions.recurrence.sourceInputTooLong", { limit: MISSION_LIFECYCLE_TEXT_LIMIT })); return
      }
    }
    if (!coordinatorReady()) { fail("coordinator", t("missions.scheduling.coordinatorUnavailable")); return }
    const scheduledWrite = kind === "create" && mode() === "recurring" || kind === "edit" && schedule.unified
      && (schedule.document()?.kind === "schedule" || journalPreparation())
    if (scheduledWrite) {
      if (textLocked() || !structuralLocked() && (!policy() || !policyReady())) return
      if (!structuralLocked()) {
        try { recurrenceStartText({ consigne: objective().trim() }) }
        catch { fail("objective", t("missions.recurrence.instructionsTooLong", { limit: MISSION_LIFECYCLE_TEXT_LIMIT })); return }
      }
      if (missionCreationHold(identity())) { setAdopted(true); return }
      const selected = copyMissionProfiles(effectiveProfiles())
       if (mode() === "recurring" && !structuralLocked() && (!selected?.coordinator?.agent || !selected.coordinator.model?.providerID || !selected.coordinator.model.id
        || missionProfileRoles[template()].some(role => !selected.roles?.[role]?.agent
          || !selected.roles[role].model?.providerID || !selected.roles[role].model?.id))) {
        fail("profiles", t("missions.recurrence.profilesRequired")); return
      }
      const ids = watchedIDs()
      const { roots: _roots, profileID: _profile, executionHost: _host, ...stored } = schedule.document()?.configuration ?? {} as NonNullable<ReturnType<typeof schedule.document>>["configuration"]
      const payload = structuralLocked() ? { ...stored, objective: objective().trim(), notes: notes() }
        : { title: submittedTitle(), objective: objective().trim(), notes: notes(), template: template(),
        watchedConversationIDs: ids, profiles: selected, taskMode: taskMode() ?? "native", launch: policy()!,
        ...(mode() === "once" && coordinatorGoal() ? { coordinatorGoal: true } : {}),
        ...(coordinatorSessionID() ? { coordinatorSessionID: coordinatorSessionID() } : {}) }
      const serialized = JSON.stringify(payload)
      if (lastPayload && lastPayload !== serialized) requestId = generateUUID()
      lastPayload = serialized
      const currentView = captureView(), operation = props.captureOperation?.() ?? (() => true)
      const current = () => currentView() && operation() && props.action === action
      setPending(true); setError("")
      try {
        if (kind === "create") {
          // A programmed Mission: saving it again, whatever happened to the answer, saves the same one.
          const saved = await backendOf(props.instanceId).api.missionCalendars(props.instanceId, { directory: props.directory, calendar: calendarID,
            configuration: payload, paused: !action.calendar && !startOnCreation() })
          if (current()) props.onSaved(undefined, undefined, saved.calendars.find(item => item.id === calendarID)?.missionID)
        } else await schedule.save(payload, requestId)
      } catch (error) {
        if (current() && error instanceof HttpResponseError && error.code === "calendar-unsupported") setError(t("missions.scheduling.error.unsupported"))
        else
        if (current()) setError(t("missions.control.mutation.error"))
      } finally { setPending(false) }
      return
    }
    if (kind === "edit") {
      if (textLocked()) return
      const payload = JSON.stringify({ objective: objective().trim(), notes: notes(), revision: schedule.journal()?.revision })
      if (lastPayload && lastPayload !== payload) requestId = generateUUID()
      lastPayload = payload
      const view = captureView(), operation = props.captureOperation?.() ?? (() => true)
      const current = () => view() && operation() && props.action === action
      setPending(true); setError("")
      try { await schedule.saveJournalEdit({ objective: objective().trim(), notes: notes(), requestID: requestId }) }
      catch (error) { if (current()) setError(t(missionMutationErrorKey(error))) }
      finally { setPending(false) }
      return
    }
    // A hold learned after this editor opened still cannot become a new logical
    // creation merely because the user submits another draft in the same scope.
    if (kind === "create" && missionCreationHold(identity())) {
      // Show an unknown contract exactly; a merely pending one leaves this draft alone.
      const existingHold = uncertainMissionCreation(identity())
      if (existingHold) {
        setObjective(existingHold.objective); setTitleOverride(existingHold.title); setNotes(existingHold.notes); setTemplate(existingHold.template)
        setProfiles(copyMissionProfiles(existingHold.profiles)); setCustomProfiles(true)
        setTaskMode(existingHold.taskMode); setCustomTaskMode(true)
        const heldModel = submittedMissionModel(existingHold.requestId)
        setSelectedModel(heldModel); resetDraftBaselines(heldModel)
        setStartOnCreation(!!existingHold.startOnCreation)
        setCoordinatorGoal(!!existingHold.coordinatorGoal)
        setWatched([...(existingHold.watchedConversationIDs ?? [])])
        setShownRequestId(existingHold.requestId)
      }
      setAdopted(true); return
    }
    const origin = identity(), directory = props.directory, instanceId = props.instanceId
    const viewCurrent = captureView()
    const operationCurrent = props.captureOperation?.() ?? (() => true)
    const current = () => viewCurrent() && operationCurrent() && props.action === action
    if (!current()) return
    const fields = { objective: objective().trim(), notes: notes(), template: template(),
      ...(kind === "create" ? { title: submittedTitle(), watchedConversationIDs: [...watchedIDs()] } : {}),
      ...(kind === "create" && coordinatorGoal() ? { coordinatorGoal: true } : {}),
      ...(kind === "create" && taskMode() !== undefined ? { taskMode: taskMode() } : {}),
      ...(kind === "create" && effectiveProfiles() !== undefined ? { profiles: copyMissionProfiles(effectiveProfiles()) } : {}) }
    const payload = kind === "create" ? missionCreationPayloadIdentity({ ...fields, directory })
      : JSON.stringify(kind === "delete" ? { deleteManagedSessions: deleteManagedSessions() } : fields)
    if (lastPayload && lastPayload !== payload) requestId = generateUUID()
    lastPayload = payload
    const creation = { ...fields, requestId, directory, startOnCreation: startOnCreation() }
    const modelIdentity = selectedModel()
    const start = captureStart(kind === "create" && startOnCreation())
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
          const snapshot = await backendOf(instanceId).api.fetchMission(instanceId, original.id)
          if (!current()) return
          if (!snapshot.available || snapshot.cleanupUnavailable) throw new MissionDeletionError(503)
          const intent = snapshot.cleanups.find(item => item.missionID === original.id && item.requestID === requestId
            && item.expectedRevision === original.revision && item.deleteManagedSessions === deleteManagedSessions())
          if (intent && !missionCleanupPending(intent)) { props.onSaved(); return }
          const live = snapshot.mission
          if (!intent && live && live.revision !== original.revision) throw new MissionDeletionError(409, "revision-conflict")
          // Neither the map nor its cleanup: capacity may have purged a committed
          // deletion's history. Its durable record answers this exact original request.
        }
        setDeleteAttempted(true)
        await backendOf(instanceId).api.deleteMission(instanceId, original.id, { expectedRevision: original.revision, requestId, deleteManagedSessions: deleteManagedSessions() })
        if (current()) props.onSaved()
      } else {
        const result = await backendOf(instanceId).api.createMission(instanceId, { ...fields, directory, requestId })
        if (kind === "create") releaseMissionCreation(origin, creation.requestId)
        if (kind === "create" && result.acknowledgement === "fresh" && current()) await start(result.mission)
        if (current()) props.onSaved(result.mission)
        else if (viewCurrent() && identity() === origin && missionStore.demandedInstanceIds().includes(instanceId)) void missionStore.refresh(instanceId)
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
          const snapshot = await backendOf(instanceId).api.fetchMission(instanceId, original.id)
          if (!current()) return
          const intent = snapshot.available && !snapshot.cleanupUnavailable && snapshot.cleanups.find(item => item.missionID === original.id && item.requestID === requestId
            && item.expectedRevision === original.revision && item.deleteManagedSessions === deleteManagedSessions())
          if (intent && !missionCleanupPending(intent)) { props.onSaved(); return }
          if (intent && !(error instanceof MissionDeletionError && error.status === 409))
            key = intent.documentPending ? "missions.cleanup.documentPending" : "missions.cleanup.error.pending"
        } catch { /* Unknown observation is not permission to change the intent. */ }
        if (current()) { setError(t(key)); void missionStore.refresh(instanceId) }
      } else {
        // An unknown create stays visible through its adopted hold, never as a retryable error.
        if (definitive) setError(t(missionMutationErrorKey(error)))
      }
    } finally { setPending(false) }
  }

  const inlineError = (field: FieldError["field"], id: string) =>
    <Show when={errorFor(field)}>{message => <span id={id} class="mission-create-field-error" role="alert">{message()}</span>}</Show>

  const createBody = () => <>
    <Show when={kind === "create"}><MissionBriefPicker instanceId={props.instanceId} disabled={locked() || !isActive()} active={isActive} value={selectedModel()?.id}
      onClear={() => { setSelectedModel(undefined); resetDraftBaselines() }}
      onUse={model => {
        requestId = generateUUID(); lastPayload = ""; setError(""); setFieldError(undefined)
        const configurationTitle = missionConfigurationTitle(model.name)
        setObjective(model.objective); setTitleOverride(configurationTitle); setNotes(model.notes); setTemplate(model.template); setSelectedModel(model); resetDraftBaselines(model)
        setCustomProfiles(model.profiles !== undefined)
        setCustomTaskMode(model.taskMode !== undefined); setTaskMode(model.taskMode ?? missionTaskModeFor(defaults(), model.template))
        setProfiles(model.profiles === undefined ? missionDefaultsFor(defaults(), model.template) : copyMissionProfiles(model.profiles))
      }} /></Show>
    <section class="mission-create-group">
    <label class="mission-create-field" for={ids.objective}><span>{t("missions.create.objective")}</span>
    <textarea id={ids.objective} rows={1} required maxLength={mode() === "recurring" ? MISSION_LIFECYCLE_TEXT_LIMIT : 20_000} value={objective()}
      placeholder={t("missions.create.objectivePlaceholder")} disabled={textLocked()}
      aria-invalid={Boolean(errorFor("objective"))} aria-describedby={errorFor("objective") ? ids.objectiveError : undefined}
      onInput={e => setObjective(e.currentTarget.value)} /></label>
    {inlineError("objective", ids.objectiveError)}
    <Show when={(mode() === "recurring" || watchedIDs().length > 0) && sourceLocationReady() && !sourceInputBudget().sufficient && !errorFor("objective")}>
      <span class="mission-create-field-error" role="alert">{t(watchedIDs().length ? "missions.recurrence.sourceInputTooLong" : "missions.recurrence.instructionsTooLong", { limit: MISSION_LIFECYCLE_TEXT_LIMIT })}</span>
    </Show>
    <label class="mission-create-field"><span>{t("missions.create.title")}</span>
      <input maxLength={MISSION_TITLE_MAX} value={title()} placeholder={derivedTitle()} disabled={structuralLocked()}
        onInput={e => setTitleOverride(e.currentTarget.value)} />
    </label>
    <Show when={kind === "edit" && structuralReason()}>{reason => <p role="status">{t(`missions.scheduling.lock.${reason()}`)}</p>}</Show>
    <label class="mission-create-field"><span>{t("missions.control.notes")}</span>
      <textarea rows={1} maxLength={20_000} value={notes()} disabled={textLocked()} onInput={e => setNotes(e.currentTarget.value)} />
    </label>
    </section>
    <section class="mission-create-group" aria-label={t("missions.create.options")}>
      <h4>{t("missions.create.options")}</h4>
      <div class="mission-create-template">
        <label class="mission-create-field"><span>{t("missions.control.template")}
          <SettingsInfoTip text={t(`missions.control.template.${template()}.description`)} help={{ page: "playbooks", anchor: template() }} />
        </span>
          <select aria-label={t("missions.control.template")} value={template()} disabled={structuralLocked() || kind === "edit" && !schedule.document()?.edit.template} onChange={e => {
            const next = e.currentTarget.value as MissionPanelMap["template"]
            setTemplate(next); setProfiles(customProfiles() ? profilesForTemplate(profiles(), next) : missionDefaultsFor(defaults(), next))
            if (!customTaskMode()) setTaskMode(missionTaskModeFor(defaults(), next))
          }}>
            <For each={["custom", "debug", "wayfinder", "delivery", "compare"] as const}>{id => <option value={id}>{t(`missions.control.template.${id}`)}</option>}</For>
          </select>
          <Show when={schedule.document()?.edit.templateReason === "ever-created-task"}><small>{t("missions.scheduling.lock.ever-created-task")}</small></Show>
        </label>
      </div>
      <MissionTaskModeControls value={taskMode() ?? "native"} disabled={structuralLocked()}
        onChange={value => { setTaskMode(value); setCustomTaskMode(true) }}>
        {/* Native nesting depth is project configuration, shared with every conversation there. */}
        <Show when={kind === "create"}><MissionSubagentDepth instanceId={props.instanceId} directory={props.directory ?? props.viewDirectory} active={isActive} /></Show>
      </MissionTaskModeControls>
    </section>
      <section class="mission-create-option" aria-label={t("missions.create.agents")} aria-describedby={errorFor("profiles") || compareError() ? ids.profilesError : undefined}>
        <details ref={profilesFold} class="settings-disclosure mission-profiles-disclosure" open={profilesOpen()} onToggle={event => setProfilesOpen(event.currentTarget.open)}>
          <summary>{t("missions.create.agents")}
            <MissionProfileSummary inline instanceId={props.instanceId} directory={props.directory} template={template()} profiles={effectiveProfiles()} />
          </summary>
            <MissionProfileControls instanceId={props.instanceId} directory={props.directory} template={template()} profiles={profiles()}
              taskMode={taskMode()}
              disabled={structuralLocked()} active={() => isActive() && profilesOpen()}
              onChange={value => { setCustomProfiles(true); setProfiles(value) }} />
        </details>
        <Show when={compareError()} fallback={inlineError("profiles", ids.profilesError)}>{error =>
          <span id={ids.profilesError} role="alert" class="mission-create-field-error">{t(`missions.compare.${error()}`)}</span>
        }</Show>
      </section>
    <Show when={kind === "create" && !action.calendar}><label class="mission-create-autostart">
      <input type="checkbox" checked={startOnCreation()} disabled={structuralLocked()}
        onChange={event => setStartOnCreation(event.currentTarget.checked)} />{t("missions.scheduling.startOnCreation")}
    </label></Show>
    <Show when={mode() === "once" && (kind === "create" || !structuralLocked())}><label class="mission-create-coordinator-goal">
      <input type="checkbox" checked={coordinatorGoal()} disabled={structuralLocked()}
        onChange={event => setCoordinatorGoal(event.currentTarget.checked)} />
      <span>{t("missions.scheduling.coordinatorGoal")}<SettingsInfoTip text={t("missions.scheduling.coordinatorGoalHint")} /></span>
    </label></Show>
    <MissionScheduling draft={schedule.scheduling()} directory={schedule.directory()} sources={sourceChoices.sources()} repository={repository()} paging={sourceChoices.reader} active={isActive}
      capability={schedule.capability()} lockReason={structuralReason()} disabled={structuralLocked()} onChange={schedule.setScheduling} onPolicy={value => setPolicyReady(!!value)} />
    <Show when={mode() === "recurring" || coordinatorSessionID() !== undefined}>
      <section class="mission-create-group">
        <label class="mission-create-field"><span>{t("missions.scheduling.coordinatorMode")}<SettingsInfoTip text={t("missions.scheduling.coordinatorHint")} /></span>
          <select aria-label={t("missions.scheduling.coordinatorMode")} value={coordinatorSessionID() === undefined ? "new" : "existing"}
            disabled={structuralLocked()} onChange={event => setCoordinatorSessionID(event.currentTarget.value === "new" ? undefined : "")}>
            <option value="new">{t("missions.scheduling.coordinatorNew")}</option>
            <option value="existing" disabled={mode() !== "recurring"}>{t("missions.scheduling.coordinatorExisting")}</option>
          </select>
        </label>
        <Show when={coordinatorSessionID() !== undefined}>
          <MissionSourceSelect label={t("missions.scheduling.coordinatorSelect")} value={coordinatorSessionID() ?? ""}
            choices={sourceChoices.sources()["coordinator-session"]} disabled={structuralLocked() || mode() !== "recurring"}
            paging={sourceChoices.reader("coordinator-session", coordinatorSessionID())} onChange={setCoordinatorSessionID} />
          <Show when={mode() !== "recurring"}><p role="alert">{t("missions.scheduling.coordinatorRequiresSchedule")}</p></Show>
        </Show>
        <Show when={errorFor("coordinator")}><p role="alert">{errorFor("coordinator")}</p></Show>
      </section>
    </Show>
    <section class="mission-create-group" aria-label={t("missions.followed.title")}>
      <h4>{t("missions.followed.title")}</h4>
      <Index each={watched()}>{(id, index) => <div class="flex items-center gap-2">
        <MissionSourceSelect label={t("missions.followed.source", { number: index + 1 })} value={id()}
          choices={sourceChoices.sources()["conversation-message"]?.filter(row => row.id === id()
            || !watched().includes(row.id) && row.id !== coordinatorSessionID())}
          paging={sourceChoices.reader("conversation-message", id())} disabled={structuralLocked() || !isActive()}
          errorID={errorFor("followed") ? ids.followedError : undefined}
          onChange={value => setWatched(rows => rows.map((row, position) => position === index ? value : row))} />
        <button type="button" class="window-icon-button" disabled={structuralLocked() || !isActive()}
          aria-label={t("missions.followed.remove", { number: index + 1 })}
          title={t("missions.followed.remove", { number: index + 1 })}
          onClick={() => setWatched(rows => rows.filter((_, position) => position !== index))}><X class="h-4 w-4" aria-hidden="true" /></button>
      </div>}</Index>
      <button type="button" class="window-action" disabled={structuralLocked() || !isActive() || watched().length >= 32}
        onClick={() => setWatched(rows => [...rows, ""])}>{t("missions.followed.add")}</button>
      {inlineError("followed", ids.followedError)}
    </section>
    <Show when={needsSourceLocation() && sourceLocationFailed() && !errorFor("followed")}>
      <p role="alert">{t("missions.recurrence.sourceLocationUnavailable")}</p>
    </Show>
    <Show when={schedule.capability() === "missing"}><button type="button" class="window-action" disabled={busy() || schedule.reading()}
      onClick={schedule.retryRead}>{t("missions.control.retry")}</button></Show>
    <Show when={(observationUnknown() || schedule.document()?.edit.reason === "uncertain") && !schedule.held() && !schedule.conflict()}>
      <button type="button" class="window-action" disabled={pending() || schedule.reading()} onClick={schedule.retryRead}>{t("missions.scheduling.reload")}</button>
    </Show>
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
    || !coordinatorReady()
    || !watchedValid() || !sourceLocationReady()
    || (mode() === "recurring" || watchedIDs().length > 0) && !sourceInputBudget().sufficient
  // In the panel, creation's body scrolls above a fixed footer unless the panel is too short (mission-create.css).
  let body: HTMLDivElement | undefined
  const panelScrolls = kind === "create" ? missionPanelScroll(() => body, isActive) : () => false

  // The trash button deletes at once: the form shows only when the deletion failed or is
  // unconfirmed. Only a freshly opened deletion submits by itself; a restored one (any
  // saved draft, a refused attempt included) waits for its explicit button.
  let form!: HTMLFormElement
  const [autoSubmit, setAutoSubmit] = createSignal(kind === "delete" && !(draft?.deleteAutoSubmitted ?? draft?.deleteAttempted))
  if (kind === "delete" && draft?.deleteError) setError(draft.deleteError)
  createEffect(() => {
    if (!autoSubmit() || deleteAttempted() || locked() || !isActive()) return
    queueMicrotask(() => {
      if (!autoSubmit() || locked() || !isActive()) return
      setAutoSubmit(false)
      form.requestSubmit()
    })
  })
  return <form ref={form} class="mission-editor window-shell" classList={{ "mission-create": kind === "create" }} onSubmit={save} aria-label={t(`missions.control.${kind}`)}
    hidden={kind === "delete" && !error() && !uncertain() && (pending() || autoSubmit())}
    data-scroller={panelScrolls() ? "panel" : undefined}>
    {/* Creation is headed by the panel's own Create button; edit/delete keep their title. */}
    <Show when={kind !== "create"}><header class="window-header"><h3 class="window-title">{t(`missions.control.${kind}`)}</h3></header></Show>
    <div class="window-body" ref={body}>
      <Show when={kind !== "delete"}>{createBody()}</Show>
      {/* A field changed since this edit opened is never prefilled: reopen it on the current map. */}
      <Show when={prefilling()}><MissionBodyPending failed={reopen() === "failed" || reopen() === "idle" && prefillState() === "failed"}
        changed={reopen() === "idle" && prefillState() === "changed"} actionLabel={offersReopen() ? "missions.control.reopen" : undefined}
        onRetry={() => offersReopen() ? reopenEdit() : retryMissionTarget([editedObjective(), editedNotes()])} /></Show>
      <Show when={!schedule.ready()}><p role={schedule.failed() ? "alert" : "status"}>{t(schedule.failed() ? "missions.scheduling.loadFailed" : "missions.control.form.loading")}</p>
        <Show when={schedule.failed()}><button type="button" class="window-action" onClick={schedule.retryRead}>{t("missions.control.refresh")}</button></Show></Show>
      <Show when={schedule.conflict()}><p role="alert">{t("missions.control.mutation.conflict")}</p>
        <button type="button" class="window-action" disabled={schedule.reading() || !!schedule.held()} onClick={() => void schedule.reload()}>{t("missions.scheduling.reload")}</button></Show>
      <Show when={schedule.previousDraft()}>{previous => <details class="mission-profile-optional"><summary>{t("missions.scheduling.previousDraft")}</summary>
        <textarea readOnly rows={8} value={previous()} aria-label={t("missions.scheduling.previousDraft")} /></details>}</Show>
      <Show when={!uncertain() && error()}><p role="alert">{error()}</p></Show>
      <Show when={schedule.held()?.state === "uncertain"}><p role="alert">{t(otherUncertain()
        ? "missions.scheduling.uncertainOther" : "missions.scheduling.uncertain")}</p></Show>
    </div>
    <footer class="window-footer">
      <Show when={kind === "create"}>
        {/* An unsent draft beside another request's hold may still be kept as a brief. */}
        <MissionBriefSave instanceId={props.instanceId} buttonClass="button-secondary" disabled={(otherUncertain() ? !creationReady() || defaultsRefreshing() : locked()) || !isActive()} active={isActive}
          initialName={initialConfigurationName} baselines={savedBaselines()} captureCommit={captureDraftCommit}
          draft={() => ({ objective: objective(), notes: notes(), template: template(), ...(customProfiles() ? { profiles: copyMissionProfiles(profiles()) ?? {} } : {}), ...(customTaskMode() ? { taskMode: taskMode() } : {}) })} />
      </Show>
      <button type="button" class="button-secondary" onClick={props.onCancel}>{t("missions.control.cancel")}</button>
      <Show when={needsSourceLocation() && sourceLocationFailed() && !uncertain()}><button type="button" class="button-secondary"
        onClick={() => setSourceLocationRevision(value => value + 1)}>{t("missions.control.refresh")}</button></Show>
      <Show when={uncertain() && !schedule.held()}><button type="button" class="button-secondary" disabled={creationReading()} onClick={() => {
        if (!isActive()) return
        if (mode() === "recurring") props.onRecurrenceRefresh?.()
        else void reconcileCreation()
      }}>{t("missions.control.refresh")}</button></Show>
      <Show when={kind === "create"} fallback={
          <button type="submit" class="button-primary" disabled={locked() || !isActive() || (kind !== "delete" && (textLocked() || !objective().trim() || !structuralLocked() && !policyReady()))}>
          {t(pending() ? "missions.control.mutation.pending" : kind === "delete"
             ? !autoSubmit() ? "missions.control.retry" : "missions.control.delete" : "missions.control.save")}
        </button>}>
        <button type="submit" class="button-primary" disabled={createDisabled()}>
          {t(pending() || creationPending() ? "missions.control.mutation.pending" : action.calendar ? "missions.control.save" : "missions.create.submit")}
        </button>
      </Show>
    </footer>
  </form>
}
