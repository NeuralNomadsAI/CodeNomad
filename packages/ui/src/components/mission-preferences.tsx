import { createSignal, For, Show } from "solid-js"
import type { MissionTemplateId } from "../../../server/src/missions/model"
import type { MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import { sameExecution, type MissionExecution } from "../../../server/src/missions/execution"
import { changeMissionProfile, setMissionProfileRole } from "./mission-profile-controls-data"
import { useI18n } from "../lib/i18n"
import { globalMissionTaskMode, normalizeMissionDefaults, missionDefaultsFor, missionTaskModeFor, type MissionDefaultScope, type MissionProfileDefault, type MissionTaskMode } from "../lib/mission-defaults"
import { useConfig, preferencesOf } from "../stores/preferences"
import { backendEvents } from "../lib/backend-events"
import { MissionProfileControls } from "./mission-profile-controls"
import { MissionProfileSummary } from "./mission-profile-summary"
import { MissionTaskModeControls } from "./mission-task-mode-controls"
import { MissionSubagentDepth } from "./mission-subagent-depth"
import { showConfirmDialog } from "../stores/alerts"
import { MissionModelLibrary } from "./mission-model-library"
import { ConfigOwnerReconciliationPendingError } from "../lib/storage"
import { captureBackendOperation } from "../lib/backend-operation"
import { SettingsInfoTip } from "./settings/settings-info-tip"

/** The next document, or undefined when the stored value this edit was made from has changed. */
type DefaultsEdit = (defaults: MissionProfileDefault[]) => MissionProfileDefault[] | undefined

/** Sets one scope's agents/models (none removes them); its task-session policy is kept. */
const withProfiles = (scope: MissionDefaultScope, profiles?: MissionProfiles): DefaultsEdit => defaults => {
  const taskMode = defaults.find(item => item.template === scope)?.taskMode
  return [...defaults.filter(item => item.template !== scope), ...(profiles || taskMode ? [{ template: scope, profiles: profiles ?? {}, ...(taskMode ? { taskMode } : {}) }] : [])]
}
const roleChoice = (profiles: MissionProfiles | undefined, role: string) => role === "coordinator" ? profiles?.coordinator : profiles?.roles?.[role]
// Omission (inherit) and an explicit all-native `{}` are different choices.
const sameChoice = (left?: MissionExecution, right?: MissionExecution) => (left === undefined) === (right === undefined) && sameExecution(left, right)
/** One role of one scope, applied to the value stored at its turn and refused if that role changed since it was edited. */
const withRole = (scope: MissionDefaultScope, role: string, basis: MissionExecution | undefined, execution: MissionExecution | undefined): DefaultsEdit => defaults => {
  const profiles = defaults.find(item => item.template === scope)?.profiles
  if (!sameChoice(roleChoice(profiles, role), basis)) return undefined
  return withProfiles(scope, scope === "all" ? changeMissionProfile(profiles, role, execution ?? {}) : setMissionProfileRole(profiles, role, execution))(defaults)
}
const withTaskMode = (scope: MissionDefaultScope, basis: MissionTaskMode | undefined, taskMode?: MissionTaskMode): DefaultsEdit => defaults => {
  const entry = defaults.find(item => item.template === scope)
  if (entry?.taskMode !== basis) return undefined
  return [...defaults.filter(item => item.template !== scope), { template: scope, profiles: entry?.profiles ?? {}, ...(taskMode ? { taskMode } : {}) }]
}
const hasProfiles = (profiles?: MissionProfiles) => Boolean(profiles?.coordinator || Object.keys(profiles?.roles ?? {}).length)

// Global preferences belong to this renderer, not a project/tab mount: the scope,
// the fold and edits still being written survive Settings navigation and remounts.
const [template, setTemplate] = createSignal<MissionDefaultScope>("all")
const [profilesOpen, setProfilesOpen] = createSignal(false)
function createPreferenceEdits() {
  const [queued, setQueued] = createSignal<DefaultsEdit[]>([])
  const [failed, setFailed] = createSignal(false), [reloading, setReloading] = createSignal(false)
  return { queued, setQueued, failed, setFailed, reloading, setReloading, writes: Promise.resolve(), writeSignal: undefined as AbortSignal | undefined }
}
const preferenceEdits = new WeakMap<AbortSignal, ReturnType<typeof createPreferenceEdits>>()

export function MissionPreferences(props: { instanceId: string; directory?: string; active: () => boolean }) {
  const { t } = useI18n(), config = useConfig(() => props.instanceId)
  const editState = () => {
    const attachment = backendEvents.signalForInstance(props.instanceId)
    let edits = preferenceEdits.get(attachment)
    if (!edits) { edits = createPreferenceEdits(); preferenceEdits.set(attachment, edits) }
    return edits
  }
  const queued = () => editState().queued(), failed = () => editState().failed(), reloading = () => editState().reloading()
  /** Every choice is written at once. Edits still queued show immediately, on top of the saved value. */
  const shown = () => queued().reduce((defaults, edit) => edit(defaults) ?? defaults, normalizeMissionDefaults(config.preferences().missionProfileDefaults))
  let scopeSelect: HTMLSelectElement | undefined, profilesFold: HTMLDetailsElement | undefined
  const entry = () => shown().find(item => item.template === template())
  const exception = (): MissionTemplateId | undefined => { const scope = template(); return scope === "all" ? undefined : scope }
  const writing = () => queued().length > 0
  // A write reads the owner as unloaded; controls stay enabled (disabling drops keyboard focus) and queue behind it.
  const disabled = () => !props.active() || reloading() || (!writing() && (!config.isUiConfigLoaded() || !config.missionDefaultsValid()))
  /** Applies the edit to the value stored at its turn, compare-and-swapped against that value; never replayed. */
  const commit = (edit: DefaultsEdit, repair = false) => {
    const state = editState(), { setFailed, setQueued } = state
    const instanceId = props.instanceId, target = preferencesOf(instanceId)
    const operation = captureBackendOperation(instanceId, undefined, () => props.instanceId === instanceId)
    if (!operation.current()) return
    setFailed(false); setQueued(edits => [...edits, edit])
    const previous = state.writeSignal === operation.signal ? state.writes : Promise.resolve()
    state.writeSignal = operation.signal
    state.writes = previous.then(async () => {
      try {
        operation.signal.throwIfAborted()
        const next = edit(normalizeMissionDefaults(target.preferences().missionProfileDefaults))
        if (!next) throw new Error("Mission defaults changed since this edit")
        await target.saveMissionDefaults(next, target.missionPreferenceSnapshot("missionProfileDefaults"), repair)
      } catch (error) {
        if (!operation.current()) return
        // Show what is actually stored (read-only). Later edits recheck what they were made from.
        if (!(error instanceof ConfigOwnerReconciliationPendingError)) setFailed(true)
        await target.reloadMissionPreferences().catch(() => {})
      } finally { setQueued(edits => edits.filter(queued => queued !== edit)) }
    })
  }
  // A recovery or reset button may disappear or turn disabled once it worked; keep focus in the form.
  const refocus = (target: () => HTMLElement | null | undefined) => queueMicrotask(() => {
    if (!document.activeElement || document.activeElement === document.body) target()?.focus()
  })
  const reload = async () => {
    const { setReloading, setFailed } = editState()
    const instanceId = props.instanceId, target = preferencesOf(instanceId)
    const operation = captureBackendOperation(instanceId, undefined, () => props.instanceId === instanceId)
    if (!operation.current()) return
    if (writing() || reloading() || !props.active()) return
    setReloading(true); setFailed(false)
    try { await target.reloadMissionPreferences() } catch {} finally { setReloading(false); if (operation.current()) refocus(() => scopeSelect) }
  }
  const confirm = (message: string, confirmLabel: string) => showConfirmDialog(message, {
    variant: "warning", confirmLabel, cancelLabel: t("missions.control.cancel"), dismissible: false,
  })
  const scopeLabel = (scope: MissionDefaultScope) => t(scope === "all" ? "missions.defaults.allPlaybooks" : `missions.control.template.${scope}`)
  const resetProfiles = async () => {
    const instanceId = props.instanceId
    const operation = captureBackendOperation(instanceId, undefined, () => props.instanceId === instanceId)
    const scope = template()
    if (!(await confirm(t("missions.defaults.resetProfilesConfirm", { scope: scopeLabel(scope) }), t("missions.preferences.reset")))) return
    if (!operation.current()) return
    commit(withProfiles(scope)); refocus(() => profilesFold?.querySelector("select"))
  }
  const repair = async () => {
    const instanceId = props.instanceId
    const operation = captureBackendOperation(instanceId, undefined, () => props.instanceId === instanceId)
    if (!(await confirm(t("missions.defaults.repairConfirm"), t("missions.defaults.reset")))) return
    if (!operation.current()) return
    commit(() => [], true); refocus(() => scopeSelect)
  }
  return <div class="mission-preferences">
    <header><h4 title={t("missions.defaults.hint")}>{t("missions.defaults.title")}</h4></header>
    <Show when={!config.isUiConfigLoaded() && !writing()}>
      <p role={config.uiConfigLoadFailed() ? "alert" : "status"}>{t(config.uiConfigLoadFailed() ? "missions.defaults.unavailable" : "missions.defaults.loading")}</p>
      <Show when={config.uiConfigLoadFailed()}><div class="mission-preferences-actions">
        <button type="button" class="window-action" aria-label={t("missions.defaults.reload")} disabled={reloading() || !props.active()} onClick={() => void reload()}>{t("missions.preferences.reload")}</button>
      </div></Show>
    </Show>
    <Show when={config.isUiConfigLoaded() && !config.missionDefaultsValid() && !writing()}>
      <p role="alert">{t("missions.defaults.invalid")}</p>
      <div class="mission-preferences-actions">
        <button type="button" class="window-action" disabled={!props.active() || reloading()} onClick={() => void repair()}>{t("missions.defaults.reset")}</button>
        <button type="button" class="window-action" aria-label={t("missions.defaults.reload")} disabled={!props.active() || reloading()} onClick={() => void reload()}>{t("missions.preferences.reload")}</button>
      </div>
    </Show>
    <label class="mission-preferences-scope"><span>{t("missions.defaults.scope")}<SettingsInfoTip text={t("missions.defaults.priority")} /></span>
      <select ref={scopeSelect} aria-label={t("missions.defaults.scope")} value={template()} disabled={disabled()}
      onChange={event => setTemplate(event.currentTarget.value as MissionDefaultScope)}>
      <option value="all">{t("missions.defaults.allPlaybooks")}</option>
      <For each={["custom", "debug", "wayfinder", "delivery", "compare"] as const}>{id => <option value={id}>{t(`missions.control.template.${id}`)}</option>}</For>
    </select></label>
    <MissionTaskModeControls value={exception() ? entry()?.taskMode : globalMissionTaskMode(shown())}
      onInherit={exception() ? () => commit(withTaskMode(template(), entry()?.taskMode)) : undefined} disabled={disabled()}
      onChange={taskMode => commit(withTaskMode(template(), entry()?.taskMode, taskMode))}
      inheritLabel={t("missions.defaults.inheritGlobal", { value: t(`missions.taskMode.${globalMissionTaskMode(shown())}`) })} />
    {/* Every agent/model choice in one fold; its summary keeps the current choice visible. */}
    <details ref={profilesFold} class="settings-disclosure mission-profiles-disclosure" open={profilesOpen()} onToggle={event => setProfilesOpen(event.currentTarget.open)}>
      <summary>{t("missions.create.agents")}
        <MissionProfileSummary inline instanceId={props.instanceId} directory={props.directory} template={exception() ?? "custom"} profiles={exception() ? missionDefaultsFor(shown(), exception()!) : entry()?.profiles} /></summary>
      {/* A mission type shows the global choices its roles inherit until one is customized. */}
      <MissionProfileControls instanceId={props.instanceId} directory={props.directory} template={exception() ?? "custom"}
        inherited={exception() ? missionDefaultsFor(shown(), exception()!, false) ?? {} : undefined}
        taskMode={exception() ? missionTaskModeFor(shown(), exception()!) : globalMissionTaskMode(shown())}
        profiles={entry()?.profiles} disabled={disabled() || !props.instanceId} active={props.active}
        onRoleChange={(role, execution) => commit(withRole(template(), role, roleChoice(entry()?.profiles, role), execution))} />
      <div class="mission-preferences-actions">
        <button type="button" class="window-action" aria-label={t("missions.defaults.resetProfiles")} title={t("missions.defaults.resetProfiles")}
          disabled={disabled() || !hasProfiles(entry()?.profiles)} onClick={() => void resetProfiles()}>{t("missions.preferences.reset")}</button>
      </div>
    </details>
    <Show when={failed()}><p role="alert">{t("missions.defaults.error")}</p></Show>
    <label class="mission-preferences-check"><input type="checkbox" checked={config.preferences().missionDeleteSessions}
      disabled={!config.isUiConfigLoaded()} onChange={event => void config.updatePreferences({ missionDeleteSessions: event.currentTarget.checked })} />
      {t("missions.preferences.deleteSessions")}</label>
    {/* Location depth writes OpenCode configuration; it is a separate row, not part of these defaults. */}
    <MissionSubagentDepth instanceId={props.instanceId} directory={props.directory} active={props.active} />
    <MissionModelLibrary instanceId={props.instanceId} active={props.active} />
  </div>
}
