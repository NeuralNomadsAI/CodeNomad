import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import type { McpCodeModeEntry } from "../../../server/src/api-types"
import type { PluginControlScope } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"
import { useI18n } from "../lib/i18n"

export function McpCodeModeControls(props: { instanceId: string; directory: string; active?: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = createSignal(false)
  const [entries, setEntries] = createSignal<McpCodeModeEntry[]>([])
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal(false)
  let refresh = () => {}
  let save: (server: string, scope: PluginControlScope, mode: string) => void = () => {}
  createEffect(() => {
    const instanceId = props.instanceId, directory = props.directory
    setEntries([]); setError(false); setBusy(false)
    if (!open() || !directory || props.active === false) return
    let disposed = false, reading = false, writing = false, trailing = false
    const load = async () => {
      if (disposed) return
      if (reading || writing) { trailing = true; return }
      reading = true; setBusy(true)
      do {
        trailing = false
        try {
          const next = await serverApi.getMcpCodeMode(instanceId, directory)
          if (!disposed && !trailing) { setEntries(next); setError(false) }
        } catch { if (!disposed && !trailing) setError(true) }
      } while (trailing && !disposed)
      reading = false
      if (!disposed) setBusy(false)
    }
    refresh = () => { void load() }
    save = (server, scope, mode) => {
      if (disposed || reading || writing) return
      writing = true; setBusy(true); setError(false)
      void (async () => {
        let failed = false
        try { await serverApi.setMcpCodeMode(instanceId, { location: { directory }, server, scope, mode: mode === "default" ? null : mode === "on" }) }
        catch { failed = true }
        finally { writing = false }
        if (disposed) return
        await load()
        if (!disposed && failed) setError(true)
      })()
    }
    const event = serverEvents.on("instance.event", payload => {
      if (payload.type === "instance.event" && payload.instanceId === instanceId && ["config.updated", "mcp.updated"].includes(payload.event.type)) refresh()
    })
    const status = serverEvents.on("instance.eventStatus", payload => {
      if (payload.type === "instance.eventStatus" && payload.instanceId === instanceId && payload.status === "connected") refresh()
    })
    const reconnect = serverEvents.onOpen(() => refresh())
    onCleanup(() => { disposed = true; event(); status(); reconnect() })
    void load()
  })
  const mode = (value: boolean | null) => value === null ? "default" : value ? "on" : "off"
  return <details class="mcp-code-mode" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("settings.mcpCodeMode.title")}</summary>
    <Show when={open()}>
      <p>{t("settings.mcpCodeMode.hint")}</p>
      <button type="button" class="selector-button" disabled={busy()} onClick={() => refresh()}>{t("settings.providers.refresh")}</button>
      <Show when={error()}><p role="alert">{t("settings.mcpCodeMode.error")}</p></Show>
      <For each={entries().map(entry => entry.server)}>{server => {
        const entry = () => entries().find(item => item.server === server)!
        return <div class="mcp-code-mode-server">
          <strong>{server}</strong><span>{t("settings.mcpCodeMode.effective", { mode: t(`settings.mcpCodeMode.${mode(entry().effective)}`) })}</span>
          <For each={entry().scopes.map(item => item.scope)}>{scope => {
            const source = () => entry().scopes.find(item => item.scope === scope)!
            return <label title={source().path}>
              <span>{t(`instanceServiceStatus.plugins.scope.${scope}`)}</span>
              <select class="selector-trigger" aria-label={`${server} · ${t(`instanceServiceStatus.plugins.scope.${scope}`)}`} value={mode(source().mode)} disabled={busy()}
                onChange={event => save(server, scope, event.currentTarget.value)}>
                <For each={["default", "on", "off"]}>{value => <option value={value} selected={value === mode(source().mode)}>{t(`settings.mcpCodeMode.${value}`)}</option>}</For>
              </select>
            </label>
          }}</For>
        </div>
      }}</For>
    </Show>
  </details>
}
