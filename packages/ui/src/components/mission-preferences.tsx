import { createEffect, createSignal, For, Show } from "solid-js"
import type { MissionTemplateId } from "../../../server/src/missions/model"
import { useI18n } from "../lib/i18n"
import { normalizeMissionDefaults, missionDefaultsFor, missionTaskModeFor, type MissionProfileDefault, type MissionTaskMode } from "../lib/mission-defaults"
import { useConfig } from "../stores/preferences"
import { MissionProfileControls } from "./mission-profile-controls"
import { MissionProfileSummary } from "./mission-profile-summary"
import { MissionTaskModeControls } from "./mission-task-mode-controls"
import { MissionSubagentDepth } from "./mission-subagent-depth"
import { showConfirmDialog } from "../stores/alerts"
import { MissionModelLibrary } from "./mission-model-library"
import { MissionDefaultInheritanceControls, preserveNativeDefaultOverrides } from "./mission-default-inheritance-controls"
import type { MissionPreferenceExpectation } from "../lib/mission-preferences-document"
import { ConfigOwnerReconciliationPendingError } from "../lib/storage"

// Global preference drafts belong to this renderer, not a project/tab mount.
// Keep the original CAS expectation through navigation and owner invalidations.
const [template, setTemplate] = createSignal<MissionTemplateId>("custom")
const [draft, setDraft] = createSignal<MissionProfileDefault[]>([])
const [dirty, setDirty] = createSignal(false), [pending, setPending] = createSignal(false), [failed, setFailed] = createSignal(false)
const [repair, setRepair] = createSignal(false)
const [reconciliationPending, setReconciliationPending] = createSignal(false)
let expected: MissionPreferenceExpectation | undefined

export function MissionPreferences(props: { instanceId: string; directory?: string; active: () => boolean }) {
  const { t } = useI18n(), config = useConfig()
  const disabled = () => !props.active() || !config.isUiConfigLoaded() || pending() || (!config.missionDefaultsValid() && !repair())
  const change = (profiles: ReturnType<typeof missionDefaultsFor>) => {
    setDirty(true); setFailed(false)
    setDraft(previous => {
      const taskMode = previous.find(item => item.template === template())?.taskMode
      return [...previous.filter(item => item.template !== template()), ...(profiles || taskMode ? [{ template: template(), profiles: profiles ?? {}, ...(taskMode ? { taskMode } : {}) }] : [])]
    })
  }
  const changeTaskMode = (taskMode?: MissionTaskMode) => {
    setDirty(true); setFailed(false)
    setDraft(previous => [...previous.filter(item => item.template !== template()), { template: template(),
      profiles: previous.find(item => item.template === template())?.profiles ?? {}, ...(taskMode ? { taskMode } : {}) }])
  }
  createEffect(() => {
    if (!config.isUiConfigLoaded()) return
    const saved = config.preferences().missionProfileDefaults
    if (!dirty()) { setDraft(normalizeMissionDefaults(saved)); expected = config.missionPreferenceSnapshot("missionProfileDefaults") }
  })
  const save = async () => {
    if (disabled() || !dirty() || !expected) return
    setPending(true); setFailed(false); setReconciliationPending(false)
    try { await config.saveMissionDefaults(draft(), expected, repair()); setDirty(false); setRepair(false) }
    catch (error) { if (error instanceof ConfigOwnerReconciliationPendingError) setReconciliationPending(true); else setFailed(true) }
    finally { setPending(false) }
  }
  const reload = async () => {
    if (pending() || !props.active()) return
    if (dirty() && !(await showConfirmDialog(t("settings.configFiles.confirmDiscard.message"), {
      variant: "warning", confirmLabel: t("settings.configFiles.confirmDiscard.confirmLabel"), cancelLabel: t("settings.configFiles.confirmDiscard.cancelLabel"), dismissible: false,
    }))) return
    setDirty(false); setRepair(false); setPending(true); setFailed(false); setReconciliationPending(false)
    try { await config.reloadMissionPreferences() } catch { setFailed(true) }
    finally { setPending(false) }
  }
  return <div class="mission-preferences">
    <header><h4 title={t("missions.defaults.hint")}>{t("missions.defaults.title")}</h4><span>{t("missions.preferences.global")}</span></header>
    <Show when={!config.isUiConfigLoaded() && !pending()}><p role={config.uiConfigLoadFailed() ? "alert" : "status"}>{t(config.uiConfigLoadFailed() ? "missions.defaults.unavailable" : "missions.defaults.loading")}</p></Show>
    <Show when={config.isUiConfigLoaded() && !config.missionDefaultsValid() && !repair()}><p role="alert">{t("missions.defaults.invalid")}</p></Show>
    <label class="mission-preferences-scope">{t("missions.defaults.scope")}<select value={template()} disabled={disabled()}
      onChange={event => setTemplate(event.currentTarget.value as MissionTemplateId)}>
      <option value="custom">{t("missions.defaults.allPlaybooks")}</option>
      <For each={["pocock-fix-bug", "wayfinder"] as const}>{id => <option value={id}>{t(`missions.control.template.${id}`)}</option>}</For>
    </select></label>
    <MissionTaskModeControls value={template() === "custom" ? missionTaskModeFor(draft(), template()) : draft().find(item => item.template === template())?.taskMode}
      onInherit={template() === "custom" ? undefined : () => changeTaskMode()} disabled={disabled()} onChange={changeTaskMode}>
      <MissionSubagentDepth instanceId={props.instanceId} directory={props.directory} active={props.active} />
    </MissionTaskModeControls>
    <MissionProfileSummary template={template()} profiles={missionDefaultsFor(draft(), template())} />
    <Show when={template() !== "custom"}><MissionDefaultInheritanceControls template={template()}
      profiles={draft().find(item => item.template === template())?.profiles} disabled={disabled()} onChange={change} /></Show>
      <MissionProfileControls instanceId={props.instanceId} directory={props.directory} template={template()}
        taskMode={missionTaskModeFor(draft(), template())}
        profiles={draft().find(item => item.template === template())?.profiles} disabled={disabled()} active={props.active}
        onChange={profiles => {
          const previous = draft().find(item => item.template === template())?.profiles
          change(template() === "custom" ? profiles : preserveNativeDefaultOverrides(previous, profiles))
        }} />
    <div class="window-actions mission-preferences-actions"><button type="button" class="window-action button-primary" disabled={disabled() || !dirty()} onClick={() => void save()}>
      {t(pending() ? "missions.control.mutation.pending" : "missions.control.save")}</button>
      <button type="button" class="window-action" aria-label={t("missions.defaults.reset")} title={t("missions.defaults.reset")} disabled={!props.active() || !config.isUiConfigLoaded() || pending()} onClick={() => { setDirty(true); setDraft([]); setRepair(true); setFailed(false) }}>{t("missions.preferences.reset")}</button>
      <button type="button" class="window-action" aria-label={t("missions.defaults.reload")} title={t("missions.defaults.reload")} disabled={!props.active() || pending()} onClick={() => void reload()}>{t("missions.preferences.reload")}</button>
    </div>
    <Show when={dirty()}><p class="mission-preferences-dirty" role="status">{t("missions.preferences.unsaved")}</p></Show>
    <Show when={failed()}><p role="alert">{t("missions.defaults.error")}</p></Show>
    <Show when={reconciliationPending()}><p role="alert">{t("missions.defaults.reconciliationPending")}</p></Show>
    <MissionModelLibrary active={props.active} />
  </div>
}
