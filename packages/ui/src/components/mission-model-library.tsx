import { createEffect, createMemo, createSignal, createUniqueId, For, Show, on, onCleanup } from "solid-js"
import { generateUUID } from "../lib/client-identity"
import { Bookmark } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { MAX_MISSION_MODELS, parseMissionModel, sameMissionModel, type UserMissionModel } from "../lib/mission-model-library"
import { useConfig, preferencesOf } from "../stores/preferences"
import { showConfirmDialog } from "../stores/alerts"
import { ConfigOwnerReconciliationPendingError } from "../lib/storage"
import { captureBackendOperation } from "../lib/backend-operation"
import { parseInstanceKey } from "../lib/backend-identity"
import { backendEvents } from "../lib/backend-events"
import ActionOverflowMenu from "./action-overflow-menu"
import { MissionBodyPending } from "./mission-reader-body"

export type MissionModelBrief = Pick<UserMissionModel, "objective" | "notes" | "template" | "profiles" | "taskMode">

interface LibraryProps { instanceId?: string; disabled?: boolean; active?: () => boolean }

/** Shared saved-brief mutations: CAS-checked writes, explicit reload/reset, no replay. */
function createMissionModelActions(props: LibraryProps) {
  const { t } = useI18n(), config = useConfig(() => props.instanceId)
  const [pending, setPending] = createSignal(false), [failed, setFailed] = createSignal(false)
  const [pendingLabel, setPendingLabel] = createSignal("")
  const [reconciliationPending, setReconciliationPending] = createSignal(false)
  const owner = () => parseInstanceKey(props.instanceId ?? "").backendId
  let generation = 0
  createEffect(on(() => [owner(), backendEvents.signal(owner())], () => {
    generation++; setPending(false); setFailed(false); setReconciliationPending(false)
  }, { defer: true }))
  const capture = () => {
    const instanceId = props.instanceId ?? "", backendId = owner(), admitted = generation
    return { target: preferencesOf(instanceId), operation: captureBackendOperation(instanceId, undefined, () => owner() === backendId && admitted === generation) }
  }
  let alive = true
  const lifetime = new AbortController()
  onCleanup(() => { alive = false; lifetime.abort() })
  const active = () => props.active?.() ?? true
  const disabled = () => props.disabled || !active() || pending() || !config.missionModelsValid()
  const begin = (label = "") => { setPendingLabel(label); setPending(true); setFailed(false); setReconciliationPending(false) }
  const settle = (error: unknown) => { if (alive) { if (error instanceof ConfigOwnerReconciliationPendingError) setReconciliationPending(true); else setFailed(true) } }
  /** Resolves the saved record once acknowledged (including an unreadable-owner acknowledgement), never retrying. */
  const save = async (name: string, draft: MissionModelBrief, replacement?: UserMissionModel,
    baseline?: UserMissionModel, returnFocus?: () => void, onCommitted?: (saved: UserMissionModel) => void): Promise<UserMissionModel | undefined> => {
    const { target, operation } = capture()
    if (!operation.current()) return
    if (disabled() || !name.trim()) return
    const expected = target.missionPreferenceSnapshot("missionModels")
    const baselineCurrent = () => !baseline || sameMissionModel(target.preferences().missionModels.find(model => model.id === baseline.id), baseline)
    if (!baselineCurrent()) { setFailed(true); setReconciliationPending(false); return }
    const inherited = expected.present ? undefined : JSON.stringify(target.preferences().missionModels)
    begin()
    let acknowledged: UserMissionModel | undefined
    try {
      const record = parseMissionModel({ version: 1, id: replacement?.id ?? generateUUID(), name, ...draft })
      if (replacement) {
        const confirmed = await showConfirmDialog(t("missions.models.replaceConfirm", { name: replacement.name }), {
          variant: "warning", confirmLabel: t("missions.models.replace"), returnFocus,
        }, AbortSignal.any([operation.signal, lifetime.signal]))
        if (!confirmed || !operation.current() || !alive || !active() || props.disabled) return
        if (!baselineCurrent() || (inherited !== undefined && inherited !== JSON.stringify(target.preferences().missionModels))) {
          setFailed(true); return
        }
      }
      setPendingLabel("missions.models.saving")
      try { await target.saveUserMissionModel(record, expected) }
      catch (error) {
        if (error instanceof ConfigOwnerReconciliationPendingError) acknowledged = record
        throw error
      }
      acknowledged = record
    } catch (error) { if (operation.current()) settle(error) }
    finally { if (operation.current() && alive) setPending(false) }
    if (operation.current() && acknowledged) onCommitted?.(acknowledged)
    return operation.current() && alive ? acknowledged : undefined
  }
  const remove = async (model: UserMissionModel): Promise<boolean> => {
    const { target, operation } = capture()
    if (!operation.current()) return false
    if (disabled()) return false
    const expected = target.missionPreferenceSnapshot("missionModels")
    begin()
    try {
      const confirmed = await showConfirmDialog(t("missions.models.removeConfirm", { name: model.name }), {
        variant: "warning", confirmLabel: t("missions.models.remove"), cancelLabel: t("missions.control.cancel"), dismissible: false,
      })
      if (!confirmed || !operation.current() || !alive || props.disabled) return false
      setPendingLabel("missions.models.removing")
      await target.removeUserMissionModel(model.id, expected)
      return operation.current() && alive
    } catch (error) { if (operation.current()) settle(error); return false }
    finally { if (operation.current() && alive) setPending(false) }
  }
  const reload = async () => {
    const { target, operation } = capture()
    if (!operation.current()) return
    if (pending() || !active()) return
    begin("missions.models.reloading")
    try { await target.reloadMissionPreferences() } catch { if (operation.current() && alive) setFailed(true) }
    finally { if (operation.current() && alive) setPending(false) }
  }
  const reset = async () => {
    const { target, operation } = capture()
    if (!operation.current()) return
    if (pending() || props.disabled || !config.isUiConfigLoaded()) return
    const expected = target.missionPreferenceSnapshot("missionModels")
    begin()
    try {
      const confirmed = await showConfirmDialog(t("missions.models.resetConfirm"), {
        variant: "warning", confirmLabel: t("missions.models.reset"), cancelLabel: t("missions.control.cancel"), dismissible: false,
      })
      if (operation.current() && confirmed && alive && !props.disabled) {
        setPendingLabel("missions.models.resetting")
        await target.resetMissionModels(expected)
      }
    } catch (error) { if (operation.current()) settle(error) }
    finally { if (operation.current() && alive) setPending(false) }
  }
  /** Inline recovery offers only an explicit authoritative reload, never a replayed write. */
  const status = () => <>
    <Show when={pending() && pendingLabel()}><p role="status">{t(pendingLabel())}</p></Show>
    <Show when={failed()}><p role="alert">{t("missions.models.error")}</p></Show>
    <Show when={reconciliationPending()}><p role="alert">{t("missions.defaults.reconciliationPending")}</p></Show>
    {/* An unreadable library already offers its own Reload beside the repair. */}
    <Show when={(failed() || reconciliationPending()) && !(config.isUiConfigLoaded() && !config.missionModelsValid())}>
      <button type="button" class="window-action" aria-label={t("missions.models.reload")} title={t("missions.models.reload")}
        disabled={pending() || !active()} onClick={() => void reload()}>{t("missions.preferences.reload")}</button>
    </Show>
  </>
  return { pending, disabled, save, remove, reload, reset, status }
}

/** Preferences: manage the saved-brief library (select, remove, repair); reloading is offered only after a failure. */
export function MissionModelLibrary(props: LibraryProps) {
  const { t } = useI18n(), config = useConfig(() => props.instanceId), actions = createMissionModelActions(props)
  const [selected, setSelected] = createSignal("")
  const selection = () => config.preferences().missionModels.find(model => model.id === selected())
  return <section class="mission-model-library" aria-label={t("missions.models.title")}>
    {/* The group title names the list; the select needs no second visible label. */}
    <header><h4>{t("missions.models.title")}</h4>
      <select aria-label={t("missions.models.select")} value={selected()} disabled={actions.disabled()}
        onChange={event => setSelected(event.currentTarget.value)}>
        <option value="">{t("missions.models.none")}</option>
        <For each={config.preferences().missionModels}>{model => <option value={model.id}>{model.name}</option>}</For>
      </select></header>
    <Show when={config.isUiConfigLoaded() && !config.missionModelsValid()}><p role="alert">{t("missions.models.invalid")}</p>
      <div class="window-actions">
        <button type="button" class="window-action" disabled={actions.pending() || props.disabled} onClick={() => void actions.reset()}>{t("missions.models.reset")}</button>
        <button type="button" class="window-action" aria-label={t("missions.models.reload")} title={t("missions.models.reload")}
          disabled={actions.pending() || !(props.active?.() ?? true)} onClick={() => void actions.reload()}>{t("missions.preferences.reload")}</button>
      </div></Show>
    <div class="window-actions">
      <button type="button" class="window-action" disabled={actions.disabled() || !selection()} onClick={async () => {
        const model = selection()
        if (model && await actions.remove(model)) setSelected("")
      }}>{t("missions.models.remove")}</button>
    </div>
    {actions.status()}
  </section>
}

/** Creation: one "Start from a brief" select that loads on selection; Remove/Reload sit in its small overflow. */
export function MissionBriefPicker(props: LibraryProps & { value?: string; onUse: (model: UserMissionModel) => void; onClear?: () => void }) {
  const { t } = useI18n(), config = useConfig(() => props.instanceId), actions = createMissionModelActions(props)
  const [selected, setSelected] = createSignal(props.value ?? ""), selectId = createUniqueId()
  const selection = () => config.preferences().missionModels.find(model => model.id === selected())
  const items = createMemo(() => [
    { key: "remove", label: t("missions.models.remove"), disabled: actions.disabled() || !selection(), onSelect: async () => {
      const model = selection()
      if (model && await actions.remove(model)) { setSelected(""); props.onClear?.() }
    } },
    { key: "reload", label: t("missions.models.reload"), disabled: actions.pending() || !(props.active?.() ?? true), onSelect: () => actions.reload() },
  ])
  return <>
    <section class="mission-brief-picker" aria-label={t("missions.models.title")}>
      <label for={selectId}><Bookmark aria-hidden="true" />{t("missions.create.brief.start")}
      </label>
      <div class="mission-brief-picker-row">
          <select id={selectId} value={selected()} disabled={actions.disabled()} onChange={event => {
            const model = config.preferences().missionModels.find(item => item.id === event.currentTarget.value)
            setSelected(event.currentTarget.value)
            if (model && !actions.disabled()) props.onUse(parseMissionModel(model))
            else if (!model) props.onClear?.()
          }}>
            <option value="">{t("missions.create.brief.none")}</option>
            <For each={config.preferences().missionModels}>{model => <option value={model.id}>{model.name}</option>}</For>
          </select>
          <ActionOverflowMenu label={t("missions.create.brief.more")} items={items()} />
      </div>
      <Show when={config.isUiConfigLoaded() && !config.missionModelsValid()}><p role="alert">{t("missions.models.invalid")}</p></Show>
      {actions.status()}
    </section>
  </>
}

/** The command that opens a brief's inline name field from elsewhere (a menu item). */
export interface MissionBriefSaveTrigger {
  /** Opens the name field; closing it gives focus back to `returnFocus()` (the menu's trigger, or a fallback). */
  open: (returnFocus?: () => HTMLElement | undefined) => void; disabled: () => boolean
}

/** "Save as brief" asking for a name inline: the creation footer's draft, or a
 * selected Mission's recorded brief inputs (`initialName` prefills). `onOpen` follows
 * the name field, which shows `reading` while the draft is still read. With `trigger`
 * the command lives elsewhere (the selected toolbar's overflow menu) and only the name
  * field shows here; otherwise a labelled button opens it (a window
 * footer passes its own template for the field's buttons). */
export function MissionBriefSave(props: LibraryProps & { draft: () => MissionModelBrief; initialName?: () => string; baselines?: readonly UserMissionModel[]; buttonClass?: string
  captureCommit?: () => (saved: UserMissionModel) => void
  onOpen?: (open: boolean) => void
  reading?: () => { failed: boolean; changed?: boolean; onRetry: () => void } | undefined
  trigger?: (trigger: MissionBriefSaveTrigger) => void }) {
  const { t } = useI18n(), config = useConfig(() => props.instanceId), actions = createMissionModelActions(props)
  const active = () => props.active?.() ?? true
  const buttonClass = () => props.buttonClass ?? "window-action"
  const [open, setOpen] = createSignal(false), [name, setName] = createSignal("")
  createEffect(() => props.onOpen?.(open()))
  let input: HTMLInputElement | undefined, triggerButton: HTMLButtonElement | undefined, root!: HTMLDivElement
  // Opened from a menu or button, the field gives focus back to that trigger when it closes.
  let returnTo: (() => HTMLElement | undefined) | undefined
  const focusTrigger = (hadFocus: boolean, target?: () => HTMLElement | undefined) => {
    if (!active()) return
    const activeElement = document.activeElement
    const free = !activeElement || activeElement === document.body || root.contains(activeElement)
    if (!hadFocus || !free || !target) return
    const element = target()
    if (element?.isConnected && !("disabled" in element && (element as HTMLButtonElement).disabled)) element.focus({ preventScroll: true })
  }
  const close = (hadFocus = root.contains(document.activeElement)) => {
    // Unless the user has moved focus elsewhere meanwhile (a save is asynchronous and
    // disables the focused control, dropping focus to the body).
    const activeElement = document.activeElement
    const free = !activeElement || activeElement === document.body || root.contains(activeElement)
    setOpen(false)
    const target = returnTo; returnTo = undefined
    // Once the closing (and a save's preference update) has re-rendered the trigger.
    if (hadFocus && free && target && active()) queueMicrotask(() => focusTrigger(true, target))
  }
  const models = () => config.preferences().missionModels
  const trimmed = () => name().trim()
  const baselines = () => props.baselines ?? []
  const bound = () => baselines().find(model => model.name === trimmed())
  const matches = createMemo(() => models().filter(model => model.name === trimmed()))
  const replacement = () => bound() ?? (matches().length === 1 ? matches()[0] : undefined)
  const baseline = () => {
    const target = replacement()
    return target ? baselines().find(model => model.id === target.id) : undefined
  }
  const nameProblem = () => replacement() || !trimmed() ? undefined
    : matches().length > 1 ? "missions.models.ambiguousName"
    : models().length >= MAX_MISSION_MODELS ? "missions.models.existingNameRequired" : undefined
  const saveDisabled = () => actions.disabled() || !trimmed() || !props.draft().objective.trim() || Boolean(nameProblem())
  const save = async () => {
    if (saveDisabled()) return
    const hadFocus = root.contains(document.activeElement), target = returnTo
    const commit = props.captureCommit?.()
    let closed = false
    const saved = await actions.save(name(), props.draft(), replacement(), baseline(), () => {
      // Runs on Kobalte's unmount timer; restore the open field on cancel/failure,
      // or the trigger if a fast save closed the field before FocusScope exited.
      queueMicrotask(() => {
        if (!active()) return
        if (input?.isConnected && !input.disabled) input.focus({ preventScroll: true })
        else if (closed) focusTrigger(hadFocus, target)
      })
    }, commit)
    if (saved) {
      closed = true; setName(""); close(hadFocus && active())
    }
  }
  const begin = (fromMenu: boolean, returnFocus?: () => HTMLElement | undefined) => {
    if (actions.disabled()) return
    returnTo = returnFocus
    setName(props.initialName?.().slice(0, 80) ?? ""); setOpen(true)
    // A closing menu returns focus to its trigger first: take it back on the next frames.
    if (fromMenu) requestAnimationFrame(() => requestAnimationFrame(() => input?.select()))
    else queueMicrotask(() => input?.select())
  }
  props.trigger?.({ open: returnFocus => begin(true, returnFocus), disabled: actions.disabled })
  return <div ref={root} class="mission-brief-save">
    <Show when={open()} fallback={props.trigger ? undefined : <button ref={triggerButton} type="button" class={buttonClass()} disabled={actions.disabled()}
      onClick={() => begin(false, () => triggerButton)}>{t("missions.create.brief.saveAs")}</button>}>
      <input ref={input} aria-label={t("missions.models.name")} placeholder={t("missions.models.name")} value={name()} maxLength={80}
        disabled={actions.disabled()} onInput={event => setName(event.currentTarget.value)} onKeyDown={event => {
          // Enter names the brief; it never submits the creation form.
          if (event.key === "Enter") { event.preventDefault(); void save() }
          else if (event.key === "Escape") { event.preventDefault(); close() }
        }} />
      <button type="button" class={buttonClass()} disabled={saveDisabled()}
        onClick={() => void save()}>{t("missions.models.save")}</button>
      <button type="button" class={buttonClass()} aria-label={t("missions.create.brief.cancel")} onClick={() => close()}>{t("missions.control.cancel")}</button>
      <Show when={props.reading?.()}>{reading => <MissionBodyPending failed={reading().failed} changed={reading().changed} onRetry={() => reading().onRetry()} />}</Show>
      <Show when={nameProblem()}>{problem => <p role="status">{t(problem())}</p>}</Show>
    </Show>
    {actions.status()}
  </div>
}
