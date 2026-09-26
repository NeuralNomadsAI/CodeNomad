import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { ServiceUsageSnapshot } from "../../../../server/src/api-types"
import { useI18n } from "../../lib/i18n"
import { serverApi } from "../../lib/api-client"
import { serverEvents } from "../../lib/server-events"
import { activeInstanceId } from "../../stores/instances"

export function UsageSettingsSection(props: { instanceId?: string }) {
  const { t, locale } = useI18n()
  const [days, setDays] = createSignal(30)
  const [snapshot, setSnapshot] = createSignal<ServiceUsageSnapshot>()
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal(false)
  const instanceId = () => props.instanceId ?? activeInstanceId() ?? ""
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  let refresh = () => {}
  createEffect(() => {
    const id = instanceId(), count = days()
    let disposed = false, reading = false, trailing = false
    setSnapshot(undefined); setError(false); setBusy(false)
    if (!id) return
    const load = async () => {
      if (disposed) return
      if (reading) { trailing = true; return }
      reading = true; setBusy(true)
      do {
        trailing = false
        const to = Date.now()
        try {
          const next = await serverApi.getServiceUsage(id, { from: to - count * 86_400_000, to, timezone })
          if (!disposed && !trailing) { setSnapshot(next); setError(false) }
        } catch { if (!disposed && !trailing) setError(true) }
      } while (!disposed && trailing)
      reading = false
      if (!disposed) setBusy(false)
    }
    refresh = () => { void load() }
    // Native stats are durable aggregates: refresh at settled session changes,
    // never per token/delta and never by loading transcript messages.
    const events = serverEvents.on("instance.event", payload => {
      if (payload.type === "instance.event" && payload.instanceId === id && ["session.idle", "session.deleted", "rpc.codenomad.session-pruning.pruned"].includes(payload.event.type)) refresh()
    })
    const status = serverEvents.on("instance.eventStatus", payload => {
      if (payload.type === "instance.eventStatus" && payload.instanceId === id && payload.status === "connected") refresh()
    })
    const reconnect = serverEvents.onOpen(() => refresh())
    onCleanup(() => { disposed = true; events(); status(); reconnect() })
    void load()
  })
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value)
  const money = (value: number) => new Intl.NumberFormat(locale(), { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value)
  const stats = () => snapshot()?.stats
  const metrics = createMemo(() => { const data = stats(); return data ? [
    ["sessions", data.sessions], ["subagents", data.subagents], ["prompts", data.prompts], ["steps", data.steps],
    ["input", data.tokens.input], ["output", data.tokens.output], ["reasoning", data.tokens.reasoning],
    ["cacheRead", data.tokens.cache.read], ["cacheWrite", data.tokens.cache.write], ["activeDays", data.activeDays], ["streak", data.streak],
  ] as const : [] })
  return <section class="settings-card usage-dashboard">
    <h3>{t("settings.usage.title")}</h3>
    <p>{t("settings.usage.scope")}</p>
    <Show when={instanceId()} fallback={<p role="status">{t("settings.usage.noProject")}</p>}>
      <div class="usage-toolbar">
        <label>{t("settings.usage.period")}<select class="selector-trigger" aria-label={t("settings.usage.period")} value={days()} onChange={event => setDays(Number(event.currentTarget.value))}>
          <For each={[7, 30, 90, 365]}>{count => <option value={count}>{t("settings.usage.days", { count })}</option>}</For>
        </select></label>
        <button class="selector-button" type="button" disabled={busy()} onClick={() => refresh()}>{t("settings.providers.refresh")}</button>
      </div>
      <Show when={busy()}><p role="status">{t("settings.usage.loading")}</p></Show>
      <Show when={error()}><p role="alert">{t("settings.usage.error")}</p></Show>
      <Show when={snapshot()}>{data => <>
        <p>{new Date(data().stats.range.from).toLocaleString(locale())} — {new Date(data().stats.range.to).toLocaleString(locale())} · {timezone}</p>
        <dl class="usage-metrics">
          <For each={metrics()}>{([label, value]) => <div><dt>{t(`settings.usage.${label}`)}</dt><dd>{number(value)}</dd></div>}</For>
          <div><dt>{t("settings.usage.cost")}</dt><dd>{money(data().stats.cost)}</dd></div>
        </dl>
        <p>{t("settings.usage.costHint")}</p>
        <h4>{t("settings.usage.models")}</h4>
        <div class="usage-table-scroll"><table>
          <thead><tr><th>{t("settings.usage.model")}</th><th>{t("settings.usage.steps")}</th><th>{t("settings.usage.input")}</th><th>{t("settings.usage.output")}</th><th>{t("settings.usage.cost")}</th></tr></thead>
          <tbody><For each={data().stats.models}>{model => <tr><th scope="row">{model.model.providerID}/{model.model.id}{model.model.variant ? ` · ${model.model.variant}` : ""}</th><td>{number(model.steps)}</td><td>{number(model.tokens.input)}</td><td>{number(model.tokens.output)}</td><td>{money(model.cost)}</td></tr>}</For></tbody>
        </table></div>
        <h4>{t("settings.usage.activity")}</h4>
        <div class="usage-activity"><For each={data().stats.activity}>{day => <div><time datetime={day.date}>{day.date}</time><meter min="0" max={Math.max(1, ...data().stats.activity.map(item => item.steps))} value={day.steps} aria-label={`${day.date} · ${t("settings.usage.steps")}`} /><span>{number(day.steps)}</span></div>}</For></div>
      </>}</Show>
    </Show>
  </section>
}
