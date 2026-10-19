import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { MissionExecution } from "../../../server/src/missions/execution"
import { missionRoleProfile, type MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import type { MissionTemplateId } from "../../../server/src/missions/model"
import type { MissionTaskMode } from "../lib/mission-defaults"
import { useI18n } from "../lib/i18n"
import { serverEvents } from "../lib/server-events"
import { runtimeEnv } from "../lib/runtime-env"
import { instances } from "../stores/instances"
import { getRootClient } from "../stores/opencode-client"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { createRequestLocation, requestLocationOptions, toRequestLocation } from "../stores/request-locations"
import { RotateCcw } from "lucide-solid"
import { changeMissionProfile, changeProfileModel, legalProfileAgents, missionProfileRoles, modelSelectionKey, setMissionProfileRole, type ProfileAgent, type ProfileModel } from "./mission-profile-controls-data"

/** One Agent / Model / Reasoning row per role (coordinator, then the type's roles), the same
 *  in creation and in every Settings scope. Rows show what a new mission will use. */
export function MissionProfileControls(props: {
  instanceId: string; directory?: string; template: MissionTemplateId
  profiles?: MissionProfiles; disabled: boolean; active: () => boolean
  taskMode?: MissionTaskMode
  roles?: readonly string[]
  /** Settings, mission type scope: the global choices each role inherits until it is customized. */
  inherited?: MissionProfiles
  /** Creation: the whole edited request. */
  onChange?: (profiles: MissionProfiles | undefined) => void
  /** Settings: one role's new choice (`undefined` inherits again), so each saved edit touches only that role. */
  onRoleChange?: (role: string, execution: MissionExecution | undefined) => void
}) {
  const { t } = useI18n()
  const [catalog, setCatalog] = createSignal<{ key: string; agents: ProfileAgent[]; models: ProfileModel[] }>()
  const [failed, setFailed] = createSignal(false), [loading, setLoading] = createSignal(false)
  const [refresh, setRefresh] = createSignal(0)
  // Technical cause for the failure notice's tooltip; the notice itself stays plain.
  const [failure, setFailure] = createSignal("")
  const instanceClient = createMemo(() => instances().get(props.instanceId)?.client)
  const identity = () => JSON.stringify([props.instanceId, props.directory])
  const demanded = () => props.active() && !props.disabled
  const invalidate = () => { if (demanded()) setRefresh(value => value + 1) }
  const events = serverEvents.on("instance.event", event => {
    if (event.type === "instance.event" && event.instanceId === props.instanceId
      && ["config.updated", "plugin.updated", "server.connected"].includes(event.event.type)) invalidate()
  })
  const reconnect = serverEvents.onOpen(invalidate)
  onCleanup(() => { events(); reconnect() })

  createEffect(() => {
    refresh()
    const key = identity(), instanceId = props.instanceId
    const client = instanceClient()
    const generation = getOpenCodeInstanceGeneration(instanceId)
    // The separate Preferences window has no instance store; it reads through
    // the same root proxy as its Providers section.
    if (!demanded() || !instanceId || (!client && runtimeEnv.windowContext !== "preferences")) return
    const location = createRequestLocation(props.directory), controller = new AbortController()
    let alive = true
    const current = () => alive && demanded() && identity() === key && instances().get(instanceId)?.client === client
      && getOpenCodeInstanceGeneration(instanceId) === generation
    // Coalesce visible invalidations; never enqueue a trailing read while hidden.
    const timer = setTimeout(async () => {
      if (!current()) return
      setLoading(true); setFailed(false)
      try {
        const native = getRootClient(instanceId), request = { location: toRequestLocation(location) }
        const options = { ...requestLocationOptions(location), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) }
        const [agents, models] = await Promise.all([native.agent.list(request, options), native.model.list(request, options)])
        if (!current()) return
        // The native list includes every known (often disabled) model; bound only the usable ones.
        const usable = models.data.filter(model => model.enabled && model.capabilities.tools)
        if (agents.data.length > 512 || usable.length > 4096) throw new Error("Oversized mission catalog")
        setCatalog({ key, agents: agents.data.map(({ id, mode, hidden }) => ({ id, mode, hidden })),
          models: usable.map(({ providerID, id, variants }) => ({ providerID, id, variants: variants.map(({ id }) => ({ id })) })) })
      } catch (error) {
        if (!current()) return
        setFailed(true); setFailure(error instanceof Error ? error.message : String(error))
      }
      finally { if (current()) setLoading(false) }
    }, 50)
    onCleanup(() => { alive = false; clearTimeout(timer); controller.abort(); setLoading(false) })
  })

  const agents = () => catalog()?.key === identity() ? catalog()!.agents : []
  const models = () => catalog()?.key === identity() ? catalog()!.models : []
  const choice = (profiles: MissionProfiles | undefined, role: string) => role === "coordinator" ? profiles?.coordinator : profiles?.roles?.[role]
  /** Without an inherited layer an empty choice is simply omitted (native default). */
  const update = (role: string, execution: MissionExecution | undefined) => {
    if (props.disabled || !props.active()) return
    if (props.onRoleChange) return props.onRoleChange(role, execution)
    props.onChange?.(props.inherited ? setMissionProfileRole(props.profiles, role, execution) : changeMissionProfile(props.profiles, role, execution ?? {}))
  }
  const row = (role: string) => {
    let fieldset: HTMLFieldSetElement | undefined
    const own = () => choice(props.profiles, role)
    const customized = () => own() !== undefined
    // An inherited role shows the global values; editing one field customizes the role from them.
    const selected = () => props.inherited && !customized() ? choice(props.inherited, role)
      : props.template === "compare" && role === "comparator" ? missionRoleProfile(props.template, props.profiles, role) : own()
    const availableAgents = () => legalProfileAgents(agents(), role === "coordinator" ? "coordinator" : props.taskMode ?? "native")
    const selectedModel = () => models().find(model => modelSelectionKey(model) === modelSelectionKey(selected()?.model))
    const label = () => t(`missions.control.profiles.role.${role}`)
    const inherit = () => {
      update(role, undefined)
      // The revert button disappears with the customization; keep keyboard focus in the row.
      queueMicrotask(() => fieldset?.querySelector("select")?.focus())
    }
    return <fieldset ref={fieldset} class="mission-profile-row" disabled={props.disabled}
      aria-description={props.inherited && !customized() ? t("missions.defaults.fromGlobalHint", { all: t("missions.defaults.allPlaybooks") }) : undefined}>
      <legend>{label()}
        <Show when={props.inherited}>
          <Show when={customized()} fallback={<span class="mission-profile-origin"
            title={t("missions.defaults.fromGlobalHint", { all: t("missions.defaults.allPlaybooks") })}>{t("missions.defaults.fromGlobal")}</span>}>
            <button type="button" class="mission-profile-revert" aria-label={t("missions.defaults.revert", { role: label() })}
              title={t("missions.defaults.revert", { role: label() })} disabled={props.disabled} onClick={inherit}><RotateCcw aria-hidden="true" /></button>
          </Show>
        </Show>
      </legend>
      <label>{t("missions.control.execution.agent")}
        <select aria-label={`${label()} · ${t("missions.control.execution.agent")}`} value={selected()?.agent ?? ""}
          onChange={event => update(role, { ...selected(), agent: event.currentTarget.value || undefined })}>
          <option value="" selected={!selected()?.agent}>{t("missions.control.execution.nativeDefault")}</option>
          <Show when={selected()?.agent && !availableAgents().some(agent => agent.id === selected()?.agent)}>
            <option value={selected()?.agent} selected>{selected()?.agent} · {t("missions.control.profiles.unavailable")}</option>
          </Show>
          <For each={availableAgents()}>{agent => <option value={agent.id} selected={agent.id === selected()?.agent}>{agent.id}</option>}</For>
        </select>
      </label>
      <label>{t("missions.control.execution.model")}
        <select aria-label={`${label()} · ${t("missions.control.execution.model")}`} value={modelSelectionKey(selected()?.model)}
          onChange={event => update(role, changeProfileModel(selected(), event.currentTarget.value, models()))}>
          <option value="" selected={!selected()?.model}>{t("missions.control.execution.nativeDefault")}</option>
          <Show when={selected()?.model && !selectedModel()}>
            <option value={modelSelectionKey(selected()?.model)} selected>{selected()?.model?.providerID}/{selected()?.model?.id} · {t("missions.control.profiles.unavailable")}</option>
          </Show>
          <For each={models()}>{model => <option value={modelSelectionKey(model)} selected={modelSelectionKey(model) === modelSelectionKey(selected()?.model)}>{model.providerID}/{model.id}</option>}</For>
        </select>
      </label>
      <label>{t("missions.control.execution.variant")}
        <select aria-label={`${label()} · ${t("missions.control.execution.variant")}`} disabled={!selected()?.model || props.disabled}
          value={selected()?.model?.variant ?? ""} onChange={event => {
            const model = selected()?.model
            if (!model) return
            const { variant: _variant, ...base } = model
            update(role, { ...selected(), model: { ...base, ...(event.currentTarget.value ? { variant: event.currentTarget.value } : {}) } })
          }}>
          <option value="" selected={!selected()?.model?.variant}>{t("missions.control.execution.nativeDefault")}</option>
          <Show when={selected()?.model?.variant && !selectedModel()?.variants.some(variant => variant.id === selected()?.model?.variant)}>
            <option value={selected()?.model?.variant} selected>{selected()?.model?.variant} · {t("missions.control.profiles.unavailable")}</option>
          </Show>
          <For each={selectedModel()?.variants ?? []}>{variant => <option value={variant.id} selected={variant.id === selected()?.model?.variant}>{variant.id}</option>}</For>
        </select>
      </label>
    </fieldset>
  }
  return <section class="mission-profiles" aria-label={t("missions.control.profiles.title")}>
    <Show when={props.template === "debug"}><span class="sr-only">{t("missions.control.profiles.debug")}</span></Show>
    <For each={props.roles ?? ["coordinator", ...missionProfileRoles[props.template]]}>{row}</For>
    <Show when={loading()}><p role="status">{t("missions.control.profiles.loading")}</p></Show>
    <Show when={failed()}><p role="status" title={failure() || undefined}>{t("missions.control.profiles.error")}</p></Show>
  </section>
}
