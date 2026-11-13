import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { RefreshCw } from "lucide-solid"
import { backendOf } from "../lib/backend-client"
import { captureBackendOperation } from "../lib/backend-operation"
import { useI18n } from "../lib/i18n"
import { createMissionViewFence } from "../lib/mission-view-fence"
import { instances } from "../stores/instances"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { showConfirmDialog } from "../stores/alerts"
import { backendEvents as serverEvents } from "../lib/server-events"
import { SettingsInfoTip } from "./settings/settings-info-tip"

type SubagentDepthSnapshot = Awaited<ReturnType<ReturnType<typeof backendOf>["api"]["getSubagentDepth"]>>

interface DepthDraft {
  snapshot?: SubagentDepthSnapshot
  draft: string
  dirty: boolean
  phase: "idle" | "confirming" | "reading" | "ready" | "saving" | "uncertain"
  error: boolean
  saved: boolean
  /** A choice made while a read or write locked the menu, with the depth it was made
   * against (the value being written, during a save): applied once a read settles on that
   * same depth, dropped when the depth changed elsewhere meanwhile. */
  queued?: { value: string; base: string }
}
// Location-scoped window memory; navigation never rebases a dirty expectation.
const drafts = new Map<string, { state: ReturnType<typeof createSignal<DepthDraft>>; request: number }>()
function depthDraft(key: string) {
  let value = drafts.get(key)
  if (!value) { value = { state: createSignal<DepthDraft>({ draft: "", dirty: false, phase: "idle", error: false, saved: false }), request: 0 }; drafts.set(key, value) }
  return value
}

export function MissionSubagentDepth(props: { instanceId: string; directory?: string; active: () => boolean }) {
  const { t } = useI18n()
  const identity = () => JSON.stringify([props.instanceId, props.directory])
  const entry = () => depthDraft(identity()), state = () => entry().state[0]()
  const busy = () => ["confirming", "reading", "saving"].includes(state().phase)
  const captureView = createMissionViewFence(identity, props.active)
  const capture = () => captureBackendOperation(props.instanceId, undefined, captureView()).current
  const [refreshPending, setRefreshPending] = createSignal(false)
  let readEpoch = 0
  const invalidate = () => { if (props.active()) { readEpoch++; setRefreshPending(true) } }
  const events = serverEvents.on("instance.event", event => {
    if (event.type === "instance.event" && event.instanceId === props.instanceId
      && ["config.updated", "server.connected"].includes(event.event.type)) invalidate()
  })
  const reconnect = serverEvents.forInstance(() => props.instanceId).onOpen(invalidate)
  let controller: AbortController | undefined, menu: HTMLSelectElement | undefined
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
      const snapshot = await backendOf(instanceId).api.getSubagentDepth(instanceId, directory, controller.signal)
      if (!admitted()) return
      if (!snapshot.location || typeof snapshot.location.directory !== "string" || snapshot.capability === undefined || snapshot.project === undefined) throw new Error("Unconfirmed depth contract")
      const fresh = snapshot.project?.depth == null ? "" : String(snapshot.project.depth)
      // The latest choice made meanwhile is written against this fresh expectation only if
      // the depth it was chosen against is unchanged; another writer's depth wins.
      const queued = target.state[0]().queued?.base === fresh ? target.state[0]().queued : undefined
      target.state[1]({ snapshot, draft: fresh, dirty: false, phase: "ready", error: false, saved: previous.saved, queued })
      if (queued && entry() === target) apply(queued.value)
      // The recovery button leaves with the problem it fixed; keep keyboard focus in the group.
      if (explicit) queueMicrotask(() => { if (admitted() && (!document.activeElement || document.activeElement === document.body)) menu?.focus() })
    } catch { if (admitted()) target.state[1]({ ...previous, phase: "ready", error: true, queued: undefined }) }
    finally { if (target.request === request && target.state[0]().phase === "reading") target.state[1]({ ...target.state[0](), phase: previous.phase }) }
  }
  createEffect(() => {
    identity()
    captureBackendOperation(props.instanceId)
    instances().get(props.instanceId)?.client
    const active = props.active()
    readEpoch++
    controller?.abort()
    setRefreshPending(active)
  })
  createEffect(() => {
    if (!refreshPending() || !props.active() || busy()) return
    if (state().dirty || state().phase === "uncertain") { setRefreshPending(false); return }
    const operation = captureBackendOperation(props.instanceId)
    const timer = setTimeout(() => { if (operation.current()) { setRefreshPending(false); void read(false) } }, 50)
    onCleanup(() => clearTimeout(timer))
  })
  const depth = () => state().draft === "" ? null : Number(state().draft)
  const valid = () => {
    const value = depth(), capability = state().snapshot?.capability
    return Boolean(capability && (value === null || Number.isSafeInteger(value) && value >= capability.minimum && (capability.maximum === undefined || value <= capability.maximum)))
  }
  /** 1 to 10 within the contract, plus a saved value outside that range so it stays shown. */
  const choices = () => {
    const maximum = Math.min(10, state().snapshot?.capability?.maximum ?? 10), values = new Set<number>()
    for (let value = 1; value <= maximum; value++) values.add(value)
    if (state().draft !== "") values.add(Number(state().draft))
    return [...values].sort((a, b) => a - b)
  }
  /** An empty project `experimental` block hides the inherited depth: shown as OpenCode's default until Inherit repairs it. */
  const masked = () => state().draft === "" && !state().dirty && Boolean(state().snapshot?.project?.emptyExperimental)
  const saved = () => masked() ? "masked" : state().draft
  const selected = () => state().queued?.value ?? saved()
  const effective = () => state().snapshot?.effectiveDepth
  const inheritLabel = () => state().snapshot?.project?.depth == null && !masked() && effective() != null
    ? t("missions.depth.inheritValue", { depth: effective()! }) : t("missions.depth.inherit")
  /** Whether General subagents can nest here, per OpenCode's resolved rules and the effective depth. */
  const nesting = () => {
    const snapshot = state().snapshot, nesting = snapshot?.nesting, effective = snapshot?.effectiveDepth
    if (!nesting || effective == null) return undefined
    // Below 2, OpenCode's own depth limit stops nesting whatever General may do.
    if (effective < 2) return t("missions.depth.nesting.limited")
    // The effect concerns General launching General; a visible tool leaves other targets to their own rules.
    if (nesting.hidden) return t("missions.depth.nesting.blocked")
    return t(nesting.effect === "allow" ? "missions.depth.nesting.allowed" : nesting.effect === "ask" ? "missions.depth.nesting.ask" : "missions.depth.nesting.generalDenied")
  }
  // Reads and writes only lock the menu (it stays focusable, aria-disabled); it is disabled when unusable.
  const locked = () => busy() || refreshPending()
  const disabled = () => !props.active() || state().phase === "uncertain" || state().error || !state().snapshot?.capability || !state().snapshot?.project
  /** Choosing a value saves it at once. While a read or write locks the menu, the latest
   * choice waits, shown, for the next settled read (see `queued`); an error or an
   * unconfirmed write drops it. */
  const apply = (value: string) => {
    if (disabled() || !locked() && value === saved()) { entry().state[1]({ ...state(), queued: undefined }); return }
    if (locked()) { entry().state[1]({ ...state(), queued: { value, base: state().queued?.base ?? state().draft } }); return }
    entry().state[1]({ ...state(), draft: value, queued: undefined, dirty: true, saved: false })
    void save()
  }
  const choose = (menu: HTMLSelectElement) => {
    if (disabled() || menu.value === "masked") { menu.value = selected(); return }
    apply(menu.value)
  }
  const save = async () => {
    if (disabled() || locked() || !state().dirty || !valid()) return
    const target = entry(), previous = target.state[0](), project = previous.snapshot!.project!, instanceId = props.instanceId
    const location = previous.snapshot!.location, value = depth(), current = capture(), request = ++target.request
    const operation = captureBackendOperation(instanceId)
    if (!current() || !operation.current()) return
    const owner = instances().get(instanceId)?.client, generation = getOpenCodeInstanceGeneration(instanceId)
    // The reply belongs to this Location's state even if the view changed meanwhile; only another runtime makes it unknown.
    const admitted = () => operation.current() && target.request === request && instances().get(instanceId)?.client === owner && getOpenCodeInstanceGeneration(instanceId) === generation
    target.state[1]({ ...previous, phase: "saving", error: false, saved: false })
    try {
      await backendOf(instanceId).api.setSubagentDepth(instanceId, { location: { directory: location.directory }, depth: value, expectation: project.expectation })
      if (!admitted()) { target.state[1]({ ...previous, phase: "uncertain" }); return }
      target.state[1]({ ...previous, queued: target.state[0]().queued, dirty: false, phase: "ready", saved: true })
      // An acknowledged write is followed only by a bounded read, never replay. A hidden
      // view reads on its next activation, which keeps the menu locked until then.
      if (current()) await read(false)
    } catch { if (target.request === request) target.state[1]({ ...previous, phase: "uncertain" }) }
  }
  /** Everything beyond the label and the menu, one part per line, revealed by the info tip.
   * Paths are isolated left-to-right (U+2066…U+2069) inside right-to-left text. */
  const details = () => {
    const snapshot = state().snapshot, path = (value: string) => `\u2066${value}\u2069`
    return [t("missions.depth.hint"), t("missions.depth.nesting.rule"),
      effective() == null ? t("missions.depth.unknown") : t("missions.depth.effective", { depth: effective()! }), nesting(),
      snapshot?.project && `${t("missions.settings.projectTarget")}: ${path(snapshot.project.path)}`,
      snapshot && `${t("missions.settings.effectiveOrigin")} ${snapshot.origin ? path(snapshot.origin) : t("missions.settings.noOrigin")}`,
    ].filter(Boolean).join("\n")
  }
  return <div class="mission-depth">
    <label><span>{t("missions.depth.label")}<SettingsInfoTip text={details()} help={{ page: "missions", anchor: "profiles" }} /></span>
      <select ref={menu} aria-label={t("missions.depth.label")} value={selected()} disabled={disabled()} aria-disabled={locked() ? "true" : undefined}
        onChange={event => choose(event.currentTarget)}>
        <option value="">{inheritLabel()}</option>
        <Show when={masked()}><option value="masked">{t("missions.depth.masked", { depth: effective() ?? "?" })}</option></Show>
        <For each={choices()}>{value => <option value={String(value)}>{value}</option>}</For>
      </select></label>
    <Show when={state().snapshot?.project?.depth != null && state().snapshot?.project?.nestingSkipped}><p role="alert">{t("missions.depth.nesting.skipped")}</p></Show>
    {/* Clean values revalidate by themselves; refreshing is only a recovery step. */}
    <Show when={state().error || ["uncertain", "confirming"].includes(state().phase)}><div class="window-actions">
      <button type="button" class="window-action mission-icon-action" aria-label={t("missions.depth.refresh")} title={t("missions.depth.refresh")} disabled={!props.active() || busy() || !props.directory} onClick={() => void read(true)}><RefreshCw aria-hidden="true" /></button>
    </div></Show>
    {/* A confirmation, a write and its result are announced, not shown: the row stays one line. */}
    <Show when={["confirming", "saving"].includes(state().phase)}><p role="status" class="sr-only">{t("missions.control.mutation.pending")}</p></Show>
    <Show when={state().saved}><p role="status" class="sr-only">{t("missions.depth.saved")}</p></Show>
    <Show when={state().snapshot && !state().snapshot?.capability}><p role="status">{t("missions.depth.unsupported")}</p></Show>
    <Show when={state().error}><p role="alert">{t("missions.depth.error")}</p></Show>
    <Show when={state().phase === "uncertain"}><p role="alert">{t("missions.depth.uncertain")}</p></Show>
  </div>
}
