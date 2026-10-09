import { createSignal, createUniqueId, For, Show, onCleanup } from "solid-js"
import { useI18n } from "../lib/i18n"
import { MAX_MISSION_MODELS, parseMissionModel, type UserMissionModel } from "../lib/mission-model-library"
import { useConfig } from "../stores/preferences"
import { showConfirmDialog } from "../stores/alerts"
import { ConfigOwnerReconciliationPendingError } from "../lib/storage"
import ActionOverflowMenu from "./action-overflow-menu"

export type MissionModelBrief = Pick<UserMissionModel, "objective" | "notes" | "template" | "profiles" | "taskMode">

interface LibraryProps { disabled?: boolean; active?: () => boolean }

/** Shared saved-brief mutations: CAS-checked writes, explicit reload/reset, no replay. */
function createMissionModelActions(props: LibraryProps) {
  const { t } = useI18n(), config = useConfig()
  const [pending, setPending] = createSignal(false), [failed, setFailed] = createSignal(false)
  const [reconciliationPending, setReconciliationPending] = createSignal(false)
  let alive = true
  onCleanup(() => { alive = false })
  const active = () => props.active?.() ?? true
  const disabled = () => props.disabled || !active() || pending() || !config.missionModelsValid()
  const begin = () => { setPending(true); setFailed(false); setReconciliationPending(false) }
  const settle = (error: unknown) => { if (alive) { if (error instanceof ConfigOwnerReconciliationPendingError) setReconciliationPending(true); else setFailed(true) } }
  /** Resolves the saved ID once acknowledged (including an unreadable-owner acknowledgement), never retrying. */
  const save = async (name: string, draft: MissionModelBrief): Promise<string | undefined> => {
    if (disabled() || !name.trim()) return
    begin()
    let acknowledged: string | undefined
    try {
      const record = parseMissionModel({ version: 1, id: crypto.randomUUID(), name, ...draft })
      try { await config.saveUserMissionModel(record) }
      catch (error) {
        if (error instanceof ConfigOwnerReconciliationPendingError) acknowledged = record.id
        throw error
      }
      acknowledged = record.id
    } catch (error) { settle(error) }
    finally { if (alive) setPending(false) }
    return alive ? acknowledged : undefined
  }
  const remove = async (model: UserMissionModel): Promise<boolean> => {
    if (disabled()) return false
    const expected = config.missionPreferenceSnapshot("missionModels")
    begin()
    try {
      const confirmed = await showConfirmDialog(t("missions.models.removeConfirm", { name: model.name }), {
        variant: "warning", confirmLabel: t("missions.models.remove"), cancelLabel: t("missions.control.cancel"), dismissible: false,
      })
      if (!confirmed || !alive || props.disabled) return false
      await config.removeUserMissionModel(model.id, expected)
      return alive
    } catch (error) { settle(error); return false }
    finally { if (alive) setPending(false) }
  }
  const reload = async () => {
    if (pending() || !active()) return
    begin()
    try { await config.reloadMissionPreferences() } catch { if (alive) setFailed(true) }
    finally { if (alive) setPending(false) }
  }
  const reset = async () => {
    if (pending() || props.disabled || !config.isUiConfigLoaded()) return
    const expected = config.missionPreferenceSnapshot("missionModels")
    begin()
    try {
      const confirmed = await showConfirmDialog(t("missions.models.resetConfirm"), {
        variant: "warning", confirmLabel: t("missions.models.reset"), cancelLabel: t("missions.control.cancel"), dismissible: false,
      })
      if (confirmed && alive && !props.disabled) await config.resetMissionModels(expected)
    } catch (error) { settle(error) }
    finally { if (alive) setPending(false) }
  }
  /** Inline recovery offers only an explicit authoritative reload, never a replayed write. */
  const status = (offerReload = true) => <>
    <Show when={pending()}><p role="status">{t("missions.control.mutation.pending")}</p></Show>
    <Show when={failed()}><p role="alert">{t("missions.models.error")}</p></Show>
    <Show when={reconciliationPending()}><p role="alert">{t("missions.defaults.reconciliationPending")}</p></Show>
    <Show when={offerReload && (failed() || reconciliationPending())}>
      <button type="button" class="window-text-button" aria-label={t("missions.models.reload")} title={t("missions.models.reload")}
        disabled={pending() || !active()} onClick={() => void reload()}>{t("missions.preferences.reload")}</button>
    </Show>
  </>
  return { pending, disabled, save, remove, reload, reset, status }
}

/** Preferences: manage the saved-brief library (select, remove, reload, repair). */
export function MissionModelLibrary(props: LibraryProps) {
  const { t } = useI18n(), config = useConfig(), actions = createMissionModelActions(props)
  const [selected, setSelected] = createSignal("")
  const selection = () => config.preferences().missionModels.find(model => model.id === selected())
  return <section class="mission-model-library" aria-label={t("missions.models.title")}>
    <h4 title={t("missions.models.hint")} aria-description={t("missions.models.hint")}>{t("missions.models.title")}</h4>
    <Show when={config.isUiConfigLoaded() && !config.missionModelsValid()}><p role="alert">{t("missions.models.invalid")}</p>
      <button type="button" class="window-action" disabled={actions.pending() || props.disabled} onClick={() => void actions.reset()}>{t("missions.models.reset")}</button></Show>
    <label>{t("missions.models.select")}<select aria-label={t("missions.models.select")} value={selected()} disabled={actions.disabled()}
      onChange={event => setSelected(event.currentTarget.value)}>
      <option value="">{t("missions.models.none")}</option>
      <For each={config.preferences().missionModels}>{model => <option value={model.id}>{model.name}</option>}</For>
    </select></label>
    <div class="window-actions">
      <button type="button" class="window-action" disabled={actions.disabled() || !selection()} onClick={async () => {
        const model = selection()
        if (model && await actions.remove(model)) setSelected("")
      }}>{t("missions.models.remove")}</button>
      <button type="button" class="window-action" aria-label={t("missions.models.reload")} title={t("missions.models.reload")}
        disabled={actions.pending() || !(props.active?.() ?? true)} onClick={() => void actions.reload()}>{t("missions.preferences.reload")}</button>
    </div>
    {actions.status(false)}
  </section>
}

/** Creation: one "Start from a brief" select that loads on selection; Remove/Reload sit in its small overflow. */
export function MissionBriefPicker(props: LibraryProps & { value?: string; onUse: (model: UserMissionModel) => void }) {
  const { t } = useI18n(), config = useConfig(), actions = createMissionModelActions(props)
  const [selected, setSelected] = createSignal(props.value ?? ""), selectId = createUniqueId()
  const selection = () => config.preferences().missionModels.find(model => model.id === selected())
  return <Show when={config.preferences().missionModels.length > 0 || config.isUiConfigLoaded() && !config.missionModelsValid()}>
    <section class="mission-brief-picker" aria-label={t("missions.models.title")}>
      <label for={selectId} title={t("missions.models.hint")}>{t("missions.create.brief.start")}</label>
      <div class="mission-brief-picker-row">
          <select id={selectId} value={selected()} disabled={actions.disabled()} onChange={event => {
            const model = config.preferences().missionModels.find(item => item.id === event.currentTarget.value)
            setSelected(event.currentTarget.value)
            if (model && !actions.disabled()) props.onUse(parseMissionModel(model))
          }}>
            <option value="">{t("missions.create.brief.none")}</option>
            <For each={config.preferences().missionModels}>{model => <option value={model.id}>{model.name}</option>}</For>
          </select>
          <ActionOverflowMenu label={t("missions.create.brief.more")} items={[
            { key: "remove", label: t("missions.models.remove"), disabled: actions.disabled() || !selection(), onSelect: async () => {
              const model = selection()
              if (model && await actions.remove(model)) setSelected("")
            } },
            { key: "reload", label: t("missions.models.reload"), disabled: actions.pending() || !(props.active?.() ?? true), onSelect: () => actions.reload() },
          ]} />
      </div>
      <Show when={config.isUiConfigLoaded() && !config.missionModelsValid()}><p role="alert">{t("missions.models.invalid")}</p></Show>
      {actions.status()}
    </section>
  </Show>
}

/** Creation footer: a small "Save as brief" text button that asks for a name inline. */
export function MissionBriefSave(props: LibraryProps & { draft: () => MissionModelBrief }) {
  const { t } = useI18n(), config = useConfig(), actions = createMissionModelActions(props)
  const [open, setOpen] = createSignal(false), [name, setName] = createSignal("")
  let input: HTMLInputElement | undefined
  const full = () => config.preferences().missionModels.length >= MAX_MISSION_MODELS
  const save = async () => {
    if (actions.disabled() || !name().trim() || !props.draft().objective.trim() || full()) return
    if (await actions.save(name(), props.draft())) { setName(""); setOpen(false) }
  }
  return <div class="mission-brief-save">
    <Show when={open()} fallback={<button type="button" class="window-text-button" disabled={actions.disabled() || full()}
      onClick={() => { setOpen(true); queueMicrotask(() => input?.focus()) }}>{t("missions.create.brief.saveAs")}</button>}>
      <input ref={input} aria-label={t("missions.models.name")} placeholder={t("missions.models.name")} value={name()} maxLength={80}
        disabled={actions.disabled()} onInput={event => setName(event.currentTarget.value)} onKeyDown={event => {
          // Enter names the brief; it never submits the creation form.
          if (event.key === "Enter") { event.preventDefault(); void save() }
          else if (event.key === "Escape") { event.preventDefault(); setOpen(false) }
        }} />
      <button type="button" class="window-text-button" disabled={actions.disabled() || !name().trim() || !props.draft().objective.trim() || full()}
        onClick={() => void save()}>{t("missions.models.save")}</button>
      <button type="button" class="window-text-button" aria-label={t("missions.create.brief.cancel")} onClick={() => setOpen(false)}>{t("missions.control.cancel")}</button>
    </Show>
    {actions.status()}
  </div>
}
