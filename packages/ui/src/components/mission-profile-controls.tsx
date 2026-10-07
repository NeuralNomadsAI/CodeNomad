import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { MissionExecution } from "../../../server/src/missions/execution"
import type { MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import type { MissionTemplateId } from "../../../server/src/missions/model"
import type { MissionTaskMode } from "../lib/mission-defaults"
import { useI18n } from "../lib/i18n"
import { serverEvents } from "../lib/server-events"
import { instances } from "../stores/instances"
import { getRootClient } from "../stores/opencode-client"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { createRequestLocation, requestLocationOptions, toRequestLocation } from "../stores/request-locations"
import { changeMissionProfile, changeProfileModel, legalProfileAgents, missionProfileRoles, modelSelectionKey, type ProfileAgent, type ProfileModel } from "./mission-profile-controls-data"

export function MissionProfileControls(props: {
  instanceId: string; directory?: string; template: MissionTemplateId
  profiles?: MissionProfiles; disabled: boolean; active: () => boolean
  taskMode?: MissionTaskMode
  onChange: (profiles: MissionProfiles | undefined) => void
}) {
  const { t } = useI18n()
  const [catalog, setCatalog] = createSignal<{ key: string; agents: ProfileAgent[]; models: ProfileModel[] }>()
  const [failed, setFailed] = createSignal(false), [loading, setLoading] = createSignal(false)
  const [refresh, setRefresh] = createSignal(0)
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
    if (!demanded() || !client) return
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
        const options = { ...requestLocationOptions(location), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) }
        const [agents, models] = await Promise.all([native.agent.list(request, options), native.model.list(request, options)])
        if (!current()) return
        if (agents.data.length > 512 || models.data.length > 4096) throw new Error("Oversized mission catalog")
        setCatalog({ key, agents: agents.data.map(({ id, mode, hidden }) => ({ id, mode, hidden })),
          models: models.data.filter(model => model.enabled && model.capabilities.tools)
            .map(({ providerID, id, variants }) => ({ providerID, id, variants: variants.map(({ id }) => ({ id })) })) })
      } catch { if (current()) setFailed(true) }
      finally { if (current()) setLoading(false) }
    }, 50)
    onCleanup(() => { alive = false; clearTimeout(timer); controller.abort(); setLoading(false) })
  })

  const agents = () => catalog()?.key === identity() ? catalog()!.agents : []
  const models = () => catalog()?.key === identity() ? catalog()!.models : []
  const selection = (role: string) => role === "coordinator" ? props.profiles?.coordinator : props.profiles?.roles?.[role]
  const update = (role: string, execution: MissionExecution) => {
    if (!props.disabled && props.active()) props.onChange(changeMissionProfile(props.profiles, role, execution))
  }
  const row = (role: string) => {
    const selected = () => selection(role)
    const availableAgents = () => legalProfileAgents(agents(), role === "coordinator" ? "coordinator" : props.taskMode ?? "native")
    const selectedModel = () => models().find(model => modelSelectionKey(model) === modelSelectionKey(selected()?.model))
    const label = () => t(`missions.control.profiles.role.${role}`)
    return <fieldset class="mission-profile-row" disabled={props.disabled}>
      <legend>{label()}</legend>
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
    <h4 title={t("missions.taskMode.hint")} aria-description={t("missions.taskMode.hint")}>{t("missions.control.profiles.title")}</h4>
    {row("coordinator")}
    <Show when={props.template === "pocock-fix-bug"}>
      <span class="sr-only">{t("missions.control.profiles.pocock")}</span>
      <For each={missionProfileRoles["pocock-fix-bug"].slice(0, 3)}>{row}</For>
    </Show>
    <details class="mission-profile-optional"><summary>{t("missions.control.profiles.optional")}</summary>
      <For each={props.template === "pocock-fix-bug" ? missionProfileRoles[props.template].slice(3) : missionProfileRoles[props.template]}>{row}</For>
    </details>
    <Show when={loading()}><p role="status">{t("missions.control.profiles.loading")}</p></Show>
    <Show when={failed()}><p role="status">{t("missions.control.profiles.error")}</p></Show>
  </section>
}
