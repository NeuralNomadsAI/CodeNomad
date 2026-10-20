import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import type { ServiceUsageSnapshot } from "../../../../server/src/api-types"
import { useI18n } from "../../lib/i18n"
import { serverApi } from "../../lib/api-client"
import { serverEvents } from "../../lib/server-events"
import { isExecutionTerminalEvent } from "../../lib/native-execution-events"
import { activeInstanceId } from "../../stores/instances"
import { createEventRefreshScheduler, type RefreshUrgency } from "../../lib/event-refresh-scheduler"

export function UsageSettingsSection(props: { instanceId?: string }) {
  const { t, locale } = useI18n()
  const [days, setDays] = createSignal(30)
  const [choice, setChoice] = createSignal<{ id: string; days: number }>()
  const [snapshot, setSnapshot] = createSignal<ServiceUsageSnapshot>()
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal(false)
  const [stale, setStale] = createSignal(true)
  const [visible, setVisible] = createSignal(document.visibilityState === "visible")
  const visibility = () => setVisible(document.visibilityState === "visible")
  document.addEventListener("visibilitychange", visibility)
  onCleanup(() => document.removeEventListener("visibilitychange", visibility))
  const instanceId = () => props.instanceId ?? activeInstanceId() ?? ""
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  let refresh = () => {}
  createEffect(() => {
    const id = instanceId(), selected = choice()?.id === id ? choice()?.days : undefined
    let count = selected ?? 30, disposed = false, revision = 0, invalidation = 0, restore = true, connected = true
    let periodKnown = selected !== undefined, freshEpoch = -1
    let controller: AbortController | undefined
    setDays(count); setSnapshot(undefined); setError(false); setBusy(false); setStale(true)
    if (!id) return
    const current = (epoch: number) => !disposed && untrack(visible) && epoch === revision
    const load = async () => {
      if (disposed || !untrack(visible) || !connected) return
      controller?.abort()
      const epoch = ++revision, observed = invalidation
      controller = new AbortController()
      const signal = controller.signal
      let verifiedOwner: string | undefined, verifiedIdentity: string | undefined
      setBusy(true)
      // These are independent reads: optional discovery/restoration never gates
      // native aggregation. Only the last known owner survives disconnects.
      const verify = (owner?: string, identity?: string, connection?: string) => {
        if (!current(epoch) || freshEpoch === epoch) return
        const previous = untrack(snapshot)
        if (previous && (owner && previous.owner && owner !== previous.owner
          || identity && previous.identity && identity !== previous.identity
          || !previous.identity && connection && previous.connection && connection !== previous.connection)) setSnapshot(undefined)
      }
      void serverApi.getServiceUsageOwner(id, signal).then(value => {
        if (!current(epoch) || freshEpoch === epoch) return
        verify(value.owner, value.identity, value.connection)
        verifiedOwner = value.owner; verifiedIdentity = value.identity
      }).catch(() => {})
      if (restore) {
        void serverApi.getCachedServiceUsage(id, timezone, selected, signal).then(cached => {
          if (!current(epoch)) return
          if (freshEpoch === epoch) {
            const fresh = untrack(snapshot)
            // Bind identity metadata only, never cached totals/period, and only
            // when discovery belongs to the very same native connection.
            if (fresh && fresh.connection && fresh.connection === cached.connection && fresh.owner === cached.owner
              && !fresh.identity && cached.identity) setSnapshot({ ...fresh, identity: cached.identity })
            return
          }
          if (verifiedOwner && cached.owner && verifiedOwner !== cached.owner
            || verifiedIdentity && cached.identity && verifiedIdentity !== cached.identity) return
          verify(cached.owner, cached.identity, cached.connection)
          verifiedOwner = cached.owner ?? verifiedOwner; verifiedIdentity = cached.identity ?? verifiedIdentity
          count = cached.days; periodKnown = true; setDays(count)
          if (cached.snapshot) { setSnapshot(cached.snapshot); setStale(true) }
        }).catch(() => {}).finally(() => {
          if (current(epoch)) restore = false
        })
      }
      const to = Date.now()
      try {
        const next = await serverApi.getServiceUsage(id, { from: to - count * 86_400_000, to, timezone, ...(!periodKnown ? { restorePeriod: true } : {}) }, signal)
        if (current(epoch)) {
          if (verifiedOwner && next.owner && verifiedOwner !== next.owner
            || verifiedIdentity && next.identity && verifiedIdentity !== next.identity) throw new Error("Stats display owner changed")
          freshEpoch = epoch
          count = (next.stats.range.to - next.stats.range.from) / 86_400_000; periodKnown = true; setDays(count)
          setSnapshot({ ...next, identity: next.identity ?? verifiedIdentity }); setError(false); setStale(observed !== invalidation)
        }
      } catch { if (current(epoch)) { setError(true); setStale(true) } }
      if (current(epoch)) setBusy(false)
    }
    const scheduler = createEventRefreshScheduler(load)
    const invalidate = (urgency: RefreshUrgency = "urgent") => {
      invalidation++; setStale(true)
      if (untrack(visible) && connected) scheduler.schedule("stats", urgency)
    }
    refresh = () => invalidate()
    // Terminal events are invalidation hints, not proof a task finished. Bursts
    // share the existing activity cooldown, not one full scan per descendant.
    const events = serverEvents.on("instance.event", payload => {
      if (payload.type !== "instance.event" || payload.instanceId !== id) return
      if (isExecutionTerminalEvent(payload.event)) invalidate("activity")
      else if (["session.deleted", "rpc.codenomad.session-pruning.pruned"].includes(payload.event.type)) invalidate()
    })
    const revoke = () => {
      revision++; controller?.abort(); scheduler.cancel("stats"); restore = true
      setBusy(false); setStale(true)
    }
    let connectionStatus: string | undefined
    const status = serverEvents.on("instance.eventStatus", payload => {
      if (payload.type !== "instance.eventStatus" || payload.instanceId !== id) return
      const key = `${payload.status}:${payload.generation}`
      if (key === connectionStatus) return
      connectionStatus = key; connected = payload.status === "connected"; revoke()
      if (payload.status === "connected") invalidate()
    })
    const reconnect = serverEvents.onOpen(() => { connected = true; revoke(); invalidate() })
    const transport = serverEvents.onTransportStatus(status => { if (status === "disconnected") { connected = false; revoke() } })
    createEffect(() => {
      if (visible()) invalidate()
      else { revision++; controller?.abort(); scheduler.cancel("stats"); setBusy(false); setStale(true) }
    })
    onCleanup(() => { disposed = true; controller?.abort(); scheduler.cancel("stats"); events(); status(); reconnect(); transport(); refresh = () => {} })
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
    <h3 class="settings-card-title">{t("settings.usage.title")}</h3>
    <p class="settings-card-subtitle">{t("settings.usage.scope")}</p>
    <Show when={instanceId()} fallback={<p role="status">{t("settings.usage.noProject")}</p>}>
      <div class="usage-toolbar">
        <label>{t("settings.usage.period")}<select class="selector-trigger" aria-label={t("settings.usage.period")} value={days()} onChange={event => setChoice({ id: instanceId(), days: Number(event.currentTarget.value) })}>
          <For each={[7, 30, 90, 365]}>{count => <option value={count}>{t("settings.usage.days", { count })}</option>}</For>
        </select></label>
        <button class="selector-button selector-button-secondary" type="button" disabled={busy()} onClick={() => refresh()}>{t("settings.providers.refresh")}</button>
      </div>
      <Show when={busy() && !snapshot()}><p role="status">{t("settings.usage.loading")}</p></Show>
      <Show when={snapshot() && stale()}><p role="status">{t("settings.usage.cached")}</p></Show>
      <Show when={error()}><p role="alert">{t("settings.usage.error")}</p></Show>
      <Show when={snapshot()}>{data => <>
        <p>{new Date(data().stats.range.from).toLocaleString(locale())} — {new Date(data().stats.range.to).toLocaleString(locale())} · {timezone}</p>
        <dl class="usage-metrics">
          <For each={metrics()}>{([label, value]) => <div><dt>{t(`settings.usage.${label}`)}</dt><dd>{number(value)}</dd></div>}</For>
          <div><dt>{t("settings.usage.cost")}</dt><dd>{money(data().stats.cost)}</dd></div>
        </dl>
        <p class="settings-inline-note">{t("settings.usage.costHint")}</p>
        <h4 class="settings-card-section-title">{t("settings.usage.models")}</h4>
        <div class="usage-table-scroll"><table>
          <thead><tr><th>{t("settings.usage.model")}</th><th>{t("settings.usage.steps")}</th><th>{t("settings.usage.input")}</th><th>{t("settings.usage.output")}</th><th>{t("settings.usage.cost")}</th></tr></thead>
          <tbody><For each={data().stats.models}>{model => <tr><th scope="row">{model.model.providerID}/{model.model.id}{model.model.variant ? ` · ${model.model.variant}` : ""}</th><td>{number(model.steps)}</td><td>{number(model.tokens.input)}</td><td>{number(model.tokens.output)}</td><td>{money(model.cost)}</td></tr>}</For></tbody>
        </table></div>
        <h4 class="settings-card-section-title">{t("settings.usage.activity")}</h4>
        <div class="usage-activity"><For each={data().stats.activity}>{day => <div><time datetime={day.date}>{day.date}</time><meter min="0" max={Math.max(1, ...data().stats.activity.map(item => item.steps))} value={day.steps} aria-label={`${day.date} · ${t("settings.usage.steps")}`} /><span>{number(day.steps)}</span></div>}</For></div>
      </>}</Show>
    </Show>
  </section>
}
