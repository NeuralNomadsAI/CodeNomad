import { Show, createEffect, createSignal, createUniqueId, onCleanup } from "solid-js"
import { RefreshCw } from "lucide-solid"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { createMissionViewFence } from "../lib/mission-view-fence"
import { instances } from "../stores/instances"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { showConfirmDialog } from "../stores/alerts"
import { serverEvents } from "../lib/server-events"
import { SettingsInfoTip } from "./settings/settings-info-tip"

type SubagentDepthSnapshot = Awaited<ReturnType<typeof serverApi.getSubagentDepth>>

interface DepthDraft {
  snapshot?: SubagentDepthSnapshot
  draft: string
  dirty: boolean
  phase: "idle" | "confirming" | "reading" | "ready" | "saving" | "uncertain"
  invalidInput?: boolean
  /** A committed value outside the depth contract: kept unsaved and flagged. */
  rejected?: boolean
  error: boolean
  saved: boolean
}
// Location-scoped window memory; navigation never rebases a dirty expectation.
const drafts = new Map<string, { state: ReturnType<typeof createSignal<DepthDraft>>; request: number }>()
function depthDraft(key: string) {
  let value = drafts.get(key)
  if (!value) { value = { state: createSignal<DepthDraft>({ draft: "", dirty: false, phase: "idle", error: false, saved: false }), request: 0 }; drafts.set(key, value) }
  return value
}

export function MissionSubagentDepth(props: { instanceId: string; directory?: string; active: () => boolean }) {
  const { t } = useI18n(), description = createUniqueId()
  const identity = () => JSON.stringify([props.instanceId, props.directory])
  const entry = () => depthDraft(identity()), state = () => entry().state[0]()
  const busy = () => ["confirming", "reading", "saving"].includes(state().phase)
  const capture = createMissionViewFence(identity, props.active)
  const [refreshPending, setRefreshPending] = createSignal(false)
  let readEpoch = 0
  const invalidate = () => { if (props.active()) { readEpoch++; setRefreshPending(true) } }
  const events = serverEvents.on("instance.event", event => {
    if (event.type === "instance.event" && event.instanceId === props.instanceId
      && ["config.updated", "server.connected"].includes(event.event.type)) invalidate()
  })
  const reconnect = serverEvents.onOpen(invalidate)
  let controller: AbortController | undefined, field: HTMLInputElement | undefined
  onCleanup(() => { controller?.abort(); events(); reconnect() })
  const read = async (explicit: boolean) => {
    const target = entry(), previous = target.state[0](), instanceId = props.instanceId, directory = props.directory
    if (!props.active() || !directory || busy()) return
    const current = capture()
    if (previous.dirty || previous.phase === "uncertain") {
      if (!explicit) return
      target.state[1]({ ...previous, phase: "confirming" })
      const discard = await showConfirmDialog(t("settings.configFiles.confirmDiscard.message"), {
        variant: "warning", confirmLabel: t("settings.configFiles.confirmDiscard.confirmLabel"), cancelLabel: t("settings.configFiles.confirmDiscard.cancelLabel"), dismissible: false,
      })
      target.state[1](previous)
      if (!discard || !current() || entry() !== target || busy()) return
    }
    const request = ++target.request, epoch = readEpoch, owner = instances().get(instanceId)?.client, generation = getOpenCodeInstanceGeneration(instanceId)
    const admitted = () => current() && readEpoch === epoch && target.request === request && instances().get(instanceId)?.client === owner && getOpenCodeInstanceGeneration(instanceId) === generation
    controller?.abort(); controller = new AbortController()
    target.state[1]({ ...previous, phase: "reading", error: false })
    try {
      const snapshot = await serverApi.getSubagentDepth(instanceId, directory, controller.signal)
      if (!admitted()) return
      if (!snapshot.location || typeof snapshot.location.directory !== "string" || snapshot.capability === undefined || snapshot.project === undefined) throw new Error("Unconfirmed depth contract")
      target.state[1]({ snapshot, draft: snapshot.project?.depth == null ? "" : String(snapshot.project.depth), dirty: false, phase: "ready", error: false, saved: previous.saved })
      // The recovery button leaves with the problem it fixed; keep keyboard focus in the group.
      if (explicit) queueMicrotask(() => { if (!document.activeElement || document.activeElement === document.body) field?.focus() })
    } catch { if (admitted()) target.state[1]({ ...previous, phase: "ready", error: true }) }
    finally { if (target.request === request && target.state[0]().phase === "reading") target.state[1]({ ...target.state[0](), phase: previous.phase }) }
  }
  createEffect(() => {
    identity()
    instances().get(props.instanceId)?.client
    const active = props.active()
    readEpoch++
    controller?.abort()
    setRefreshPending(active)
  })
  createEffect(() => {
    if (!refreshPending() || !props.active() || busy()) return
    if (state().dirty || state().phase === "uncertain") { setRefreshPending(false); return }
    const timer = setTimeout(() => { setRefreshPending(false); void read(false) }, 50)
    onCleanup(() => clearTimeout(timer))
  })
  const depth = () => state().draft.trim() === "" ? null : Number(state().draft)
  const valid = () => {
    const value = depth(), capability = state().snapshot?.capability
    return Boolean(!state().invalidInput && capability && (value === null || Number.isSafeInteger(value) && value >= capability.minimum && (capability.maximum === undefined || value <= capability.maximum)))
  }
  // Reads and writes only lock the field (read-only keeps keyboard focus); it is disabled when unusable.
  const locked = () => busy() || refreshPending()
  const disabled = () => !props.active() || state().phase === "uncertain" || state().error || !state().snapshot?.capability || !state().snapshot?.project
  /** Enter or leaving the field saves a changed value; an invalid one is flagged, never written. */
  const commit = () => {
    if (disabled() || locked() || !state().dirty) return
    if (!valid()) { entry().state[1]({ ...state(), rejected: true }); return }
    void save()
  }
  const inherit = () => {
    if (locked()) return
    entry().state[1]({ ...state(), draft: "", invalidInput: false, rejected: false, dirty: true, saved: false }); commit()
  }
  /** Escape discards an unsaved value without writing anything. */
  const discard = () => {
    const saved = state().snapshot?.project?.depth
    entry().state[1]({ ...state(), draft: saved == null ? "" : String(saved), invalidInput: false, rejected: false, dirty: false })
  }
  const save = async () => {
    if (disabled() || locked() || !state().dirty || !valid()) return
    const target = entry(), previous = target.state[0](), project = previous.snapshot!.project!, instanceId = props.instanceId
    const location = previous.snapshot!.location, value = depth(), current = capture(), request = ++target.request
    const owner = instances().get(instanceId)?.client, generation = getOpenCodeInstanceGeneration(instanceId)
    // The reply belongs to this Location's state even if the view changed meanwhile; only another runtime makes it unknown.
    const admitted = () => target.request === request && instances().get(instanceId)?.client === owner && getOpenCodeInstanceGeneration(instanceId) === generation
    target.state[1]({ ...previous, phase: "saving", error: false, saved: false })
    try {
      await serverApi.setSubagentDepth(instanceId, { location: { directory: location.directory }, depth: value, expectation: project.expectation })
      if (!admitted()) { target.state[1]({ ...previous, phase: "uncertain" }); return }
      target.state[1]({ ...previous, dirty: false, phase: "ready", saved: true })
      // An acknowledged write is followed only by a bounded read, never replay. A hidden
      // view reads on its next activation, which keeps the field locked until then.
      if (current()) await read(false)
    } catch { if (target.request === request) target.state[1]({ ...previous, phase: "uncertain" }) }
  }
  return <section class="mission-depth" aria-label={t("missions.depth.title")}>
    <header><h4>{t("missions.depth.title")}</h4><SettingsInfoTip text={t("missions.depth.hint")} /></header>
    <Show when={state().snapshot?.project}>{project => <code class="mission-depth-path" title={project().path}>{project().path}</code>}</Show>
    <p class="mission-depth-effective">{state().snapshot?.effectiveDepth == null ? t("missions.depth.unknown") : t("missions.depth.effective", { depth: state().snapshot!.effectiveDepth! })}</p>
    <label>{t("missions.depth.label")}<input type="number" step="1" min={state().snapshot?.capability?.minimum} max={state().snapshot?.capability?.maximum}
      placeholder={t("missions.depth.inherit")} aria-describedby={description} value={state().draft} disabled={disabled()} readOnly={locked()}
      onInput={event => entry().state[1]({ ...state(), draft: event.currentTarget.value, invalidInput: event.currentTarget.validity.badInput, rejected: false, dirty: true, saved: false })}
      onChange={commit} onKeyDown={event => {
        if (event.key === "Enter") commit()
        else if (event.key === "Escape" && state().dirty && !locked()) { event.preventDefault(); event.stopPropagation(); discard() }
      }} ref={field} /></label>
    <span id={description} class="sr-only">{t("missions.depth.hint")}</span>
    <div class="window-actions">
      {/* Pressing the button keeps focus in the field, so leaving it cannot first save the typed value.
          While a read or write runs it stays focusable and inert rather than disabled. */}
      <button type="button" class="window-action" disabled={disabled() || state().draft === "" && !state().dirty} aria-disabled={locked() ? "true" : undefined}
        onPointerDown={event => event.preventDefault()} onClick={inherit}>{t("missions.depth.inherit")}</button>
      {/* Clean values revalidate by themselves; refreshing is only a recovery step. */}
      <Show when={state().error || ["uncertain", "confirming"].includes(state().phase)}>
        <button type="button" class="window-action mission-icon-action" aria-label={t("missions.depth.refresh")} title={t("missions.depth.refresh")} disabled={!props.active() || busy() || !props.directory} onClick={() => void read(true)}><RefreshCw aria-hidden="true" /></button>
      </Show></div>
    <Show when={busy()}><p role="status">{t("missions.control.mutation.pending")}</p></Show>
    <Show when={state().snapshot && !state().snapshot?.capability}><p role="status">{t("missions.depth.unsupported")}</p></Show>
    <Show when={state().rejected}><p role="alert">{t("missions.depth.invalidValue")}</p></Show>
    <Show when={state().error}><p role="alert">{t("missions.depth.error")}</p></Show>
    <Show when={state().phase === "uncertain"}><p role="alert">{t("missions.depth.uncertain")}</p></Show>
    <Show when={state().saved}><p role="status">{t("missions.depth.saved")}</p></Show>
  </section>
}
