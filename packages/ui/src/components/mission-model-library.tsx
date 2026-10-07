import { createSignal, For, Show, onCleanup } from "solid-js"
import { useI18n } from "../lib/i18n"
import { MAX_MISSION_MODELS, parseMissionModel, type UserMissionModel } from "../lib/mission-model-library"
import { useConfig } from "../stores/preferences"
import { showConfirmDialog } from "../stores/alerts"
import { ConfigOwnerReconciliationPendingError } from "../lib/storage"

export type MissionModelBrief = Pick<UserMissionModel, "objective" | "notes" | "template" | "profiles" | "taskMode">

export function MissionModelLibrary(props: {
  disabled?: boolean
  active?: () => boolean
  draft?: () => MissionModelBrief
  onUse?: (model: UserMissionModel) => void
}) {
  const { t } = useI18n(), config = useConfig()
  const [selected, setSelected] = createSignal("")
  const [name, setName] = createSignal("")
  const [pending, setPending] = createSignal(false), [failed, setFailed] = createSignal(false)
  const [reconciliationPending, setReconciliationPending] = createSignal(false)
  let alive = true
  onCleanup(() => { alive = false })
  const disabled = () => props.disabled || !(props.active?.() ?? true) || pending() || !config.missionModelsValid()
  const selection = () => config.preferences().missionModels.find(model => model.id === selected())
  const save = async () => {
    if (disabled() || !props.draft || !name().trim()) return
    setPending(true); setFailed(false); setReconciliationPending(false)
    try {
      const record = parseMissionModel({ version: 1, id: crypto.randomUUID(), name: name(), ...props.draft() })
      try { await config.saveUserMissionModel(record) }
      catch (error) {
        if (alive && error instanceof ConfigOwnerReconciliationPendingError) { setName(""); setSelected(record.id) }
        throw error
      }
      if (alive) { setSelected(record.id); setName("") }
    } catch (error) { if (alive) { if (error instanceof ConfigOwnerReconciliationPendingError) setReconciliationPending(true); else setFailed(true) } }
    finally { if (alive) setPending(false) }
  }
  const remove = async () => {
    const model = selection()
    if (!model || disabled()) return
    const expected = config.missionPreferenceSnapshot("missionModels")
    setPending(true); setFailed(false); setReconciliationPending(false)
    try {
      const confirmed = await showConfirmDialog(t("missions.models.removeConfirm", { name: model.name }), {
        variant: "warning", confirmLabel: t("missions.models.remove"), cancelLabel: t("missions.control.cancel"), dismissible: false,
      })
      if (!confirmed || !alive || props.disabled) return
      await config.removeUserMissionModel(model.id, expected)
      if (alive) setSelected("")
    } catch (error) { if (alive) { if (error instanceof ConfigOwnerReconciliationPendingError) setReconciliationPending(true); else setFailed(true) } }
    finally { if (alive) setPending(false) }
  }
  const reload = async () => {
    if (pending() || !(props.active?.() ?? true)) return
    setPending(true); setFailed(false); setReconciliationPending(false)
    try { await config.reloadMissionPreferences() } catch { if (alive) setFailed(true) }
    finally { if (alive) setPending(false) }
  }
  const reset = async () => {
    if (pending() || props.disabled || !config.isUiConfigLoaded()) return
    const expected = config.missionPreferenceSnapshot("missionModels")
    setPending(true); setFailed(false); setReconciliationPending(false)
    try {
      const confirmed = await showConfirmDialog(t("missions.models.resetConfirm"), {
        variant: "warning", confirmLabel: t("missions.models.reset"), cancelLabel: t("missions.control.cancel"), dismissible: false,
      })
      if (confirmed && alive && !props.disabled) await config.resetMissionModels(expected)
    } catch (error) { if (alive) { if (error instanceof ConfigOwnerReconciliationPendingError) setReconciliationPending(true); else setFailed(true) } }
    finally { if (alive) setPending(false) }
  }
  return <section class="mission-model-library" aria-label={t("missions.models.title")}>
    <h4 title={t("missions.models.hint")} aria-description={t("missions.models.hint")}>{t("missions.models.title")}</h4>
    <Show when={config.isUiConfigLoaded() && !config.missionModelsValid()}><p role="alert">{t("missions.models.invalid")}</p>
      <button type="button" class="window-action" disabled={pending() || props.disabled} onClick={() => void reset()}>{t("missions.models.reset")}</button></Show>
    <label>{t("missions.models.select")}<select aria-label={t("missions.models.select")} value={selected()} disabled={disabled()}
      onChange={event => { setSelected(event.currentTarget.value); setFailed(false) }}>
      <option value="">{t("missions.models.none")}</option>
      <For each={config.preferences().missionModels}>{model => <option value={model.id}>{model.name}</option>}</For>
    </select></label>
    <div class="window-actions">
      <Show when={props.onUse}><button type="button" class="window-action" disabled={disabled() || !selection()} onClick={() => {
        const model = selection()
        if (!disabled() && model) props.onUse?.(parseMissionModel(model))
      }}>{t("missions.models.use")}</button></Show>
      <button type="button" class="window-action" disabled={disabled() || !selection()} onClick={() => void remove()}>{t("missions.models.remove")}</button>
      <button type="button" class="window-action" aria-label={t("missions.models.reload")} title={t("missions.models.reload")} disabled={pending() || !(props.active?.() ?? true)} onClick={() => void reload()}>{t("missions.preferences.reload")}</button>
    </div>
    <Show when={props.draft}>
      <label>{t("missions.models.name")}<input aria-label={t("missions.models.name")} value={name()} maxLength={80} disabled={disabled()} onInput={event => setName(event.currentTarget.value)} /></label>
      <button type="button" class="window-action" disabled={disabled() || !name().trim() || !props.draft?.().objective.trim()
        || config.preferences().missionModels.length >= MAX_MISSION_MODELS} onClick={() => void save()}>{t("missions.models.save")}</button>
    </Show>
    <Show when={pending()}><p role="status">{t("missions.control.mutation.pending")}</p></Show>
    <Show when={failed()}><p role="alert">{t("missions.models.error")}</p></Show>
    <Show when={reconciliationPending()}><p role="alert">{t("missions.defaults.reconciliationPending")}</p></Show>
  </section>
}
