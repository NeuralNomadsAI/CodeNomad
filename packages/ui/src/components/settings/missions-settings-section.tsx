import { createEffect, createSignal, For, Show, onCleanup } from "solid-js"
import type { LocationRef } from "@opencode/client"
import type { MissionTemplateId } from "../../../../server/src/missions/model"
import { useI18n } from "../../lib/i18n"
import { normalizeMissionDefaults, type MissionProfileDefault } from "../../lib/mission-defaults"
import { useConfig } from "../../stores/preferences"
import { MissionProfileControls } from "../mission-profile-controls"
import { registerSettingsDirtyGuard } from "../../stores/settings-dirty-guard"
import { showConfirmDialog } from "../../stores/alerts"
import { MissionModelLibrary } from "../mission-model-library"
import { MissionDefaultInheritanceControls, preserveNativeDefaultOverrides } from "../mission-default-inheritance-controls"
import { MissionProfileSummary } from "../mission-profile-summary"
import { missionDefaultsFor } from "../../lib/mission-defaults"
import type { MissionPreferenceExpectation } from "../../lib/mission-preferences-document"
import { ConfigOwnerReconciliationPendingError } from "../../lib/storage"

export function MissionsSettingsSection(props: { instanceId?: string; location?: LocationRef }) {
  const { t } = useI18n(), config = useConfig()
  const [template, setTemplate] = createSignal<MissionTemplateId>("custom")
  const [draft, setDraft] = createSignal<MissionProfileDefault[]>([])
  const [dirty, setDirty] = createSignal(false), [pending, setPending] = createSignal(false), [failed, setFailed] = createSignal(false)
  const [repair, setRepair] = createSignal(false)
  const [reconciliationPending, setReconciliationPending] = createSignal(false)
  let expected: MissionPreferenceExpectation = config.missionPreferenceSnapshot("missionProfileDefaults")
  const disabled = () => !config.isUiConfigLoaded() || pending() || (!config.missionDefaultsValid() && !repair())
  const change = (profiles: ReturnType<typeof missionDefaultsFor>) => {
    setDirty(true); setFailed(false)
    setDraft(previous => [...previous.filter(item => item.template !== template()), ...(profiles ? [{ template: template(), profiles }] : [])])
  }
  createEffect(() => {
    if (!config.isUiConfigLoaded()) return
    const saved = config.preferences().missionProfileDefaults
    if (!dirty()) { setDraft(normalizeMissionDefaults(saved)); expected = config.missionPreferenceSnapshot("missionProfileDefaults") }
  })
  const unregister = registerSettingsDirtyGuard(async () => {
    if (pending()) return false
    if (!dirty()) return true
    return showConfirmDialog(t("settings.configFiles.confirmDiscard.message"), {
      variant: "warning", confirmLabel: t("settings.configFiles.confirmDiscard.confirmLabel"),
      cancelLabel: t("settings.configFiles.confirmDiscard.cancelLabel"), dismissible: false,
    })
  })
  onCleanup(unregister)
  const save = async () => {
    if (disabled() || !dirty()) return
    setPending(true); setFailed(false); setReconciliationPending(false)
    try { await config.saveMissionDefaults(draft(), expected, repair()); setDirty(false); setRepair(false) }
    catch (error) { if (error instanceof ConfigOwnerReconciliationPendingError) setReconciliationPending(true); else setFailed(true) }
    finally { setPending(false) }
  }
  const reload = async () => {
    if (pending()) return
    if (dirty() && !(await showConfirmDialog(t("settings.configFiles.confirmDiscard.message"), {
      variant: "warning", confirmLabel: t("settings.configFiles.confirmDiscard.confirmLabel"), cancelLabel: t("settings.configFiles.confirmDiscard.cancelLabel"), dismissible: false,
    }))) return
    setDirty(false); setRepair(false); setPending(true); setFailed(false); setReconciliationPending(false)
    try { await config.reloadMissionPreferences() } catch { setFailed(true) }
    finally { setPending(false) }
  }
  return <div class="settings-section-stack"><div class="settings-card">
    <div class="settings-card-header"><div><h3 class="settings-card-title">{t("missions.defaults.title")}</h3>
      <p class="settings-card-subtitle">{t("missions.defaults.hint")}</p></div></div>
    <button type="button" class="window-action" disabled={pending()} onClick={() => void reload()}>{t("missions.defaults.reload")}</button>
    <Show when={!config.isUiConfigLoaded() && !pending()}><p role={config.uiConfigLoadFailed() ? "alert" : "status"}>{t(config.uiConfigLoadFailed() ? "missions.defaults.unavailable" : "missions.defaults.loading")}</p></Show>
    <Show when={config.isUiConfigLoaded() && !config.missionDefaultsValid() && !repair()}><p role="alert">{t("missions.defaults.invalid")}</p></Show>
    <label>{t("missions.defaults.scope")}<select value={template()} disabled={disabled()}
      onChange={event => setTemplate(event.currentTarget.value as MissionTemplateId)}>
      <option value="custom">{t("missions.defaults.allPlaybooks")}</option>
      <For each={["pocock-fix-bug", "wayfinder"] as const}>{id => <option value={id}>{t(`missions.control.template.${id}`)}</option>}</For>
    </select></label>
    <div class="mission-editor"><MissionProfileSummary template={template()} profiles={missionDefaultsFor(draft(), template())} />
    <Show when={template() !== "custom"}><MissionDefaultInheritanceControls template={template()}
      profiles={draft().find(item => item.template === template())?.profiles} disabled={disabled()} onChange={change} /></Show>
    <Show when={props.instanceId} fallback={<p>{t("missions.defaults.noProject")}</p>}>{id =>
      <MissionProfileControls instanceId={id()} directory={props.location?.directory} template={template()}
        profiles={draft().find(item => item.template === template())?.profiles} disabled={disabled()} active={() => !disabled()}
        onChange={profiles => {
          const previous = draft().find(item => item.template === template())?.profiles
          change(template() === "custom" ? profiles : preserveNativeDefaultOverrides(previous, profiles))
        }} />
    }</Show></div>
    <div class="window-actions"><button type="button" class="window-action button-primary" disabled={disabled() || !dirty()} onClick={() => void save()}>
      {t(pending() ? "missions.control.mutation.pending" : "missions.control.save")}</button>
      <button type="button" class="window-action" disabled={!config.isUiConfigLoaded() || pending()} onClick={() => { setDraft([]); setRepair(true); setDirty(true); setFailed(false) }}>{t("missions.defaults.reset")}</button>
    </div>
    <Show when={failed()}><p role="alert">{t("missions.defaults.error")}</p></Show>
    <Show when={reconciliationPending()}><p role="alert">{t("missions.defaults.reconciliationPending")}</p></Show>
  </div><div class="settings-card"><MissionModelLibrary /></div></div>
}
