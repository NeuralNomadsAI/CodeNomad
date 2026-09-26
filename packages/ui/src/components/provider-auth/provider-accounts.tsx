import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import type { ConnectionInfo, LocationRef, OpenCodeClient } from "@opencode/client"
import { useI18n } from "../../lib/i18n"
import { serverEvents } from "../../lib/server-events"
import { requestLocationOptions, toRequestLocation } from "../../stores/request-locations"

export function ProviderAccounts(props: {
  instanceId: string
  integrationId: string
  client: OpenCodeClient
  location: LocationRef
  disabled?: boolean
  onChanged?: () => Promise<void>
}) {
  const { t } = useI18n()
  const [open, setOpen] = createSignal(false)
  const [connections, setConnections] = createSignal<ConnectionInfo[]>([])
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal(false)
  let refresh = () => {}
  let run: (id: string, action: "activate" | "remove" | "rename", label?: string) => Promise<boolean> = async () => false
  createEffect(() => {
    const client = props.client, instanceId = props.instanceId, integrationID = props.integrationId, location = { ...props.location }
    let disposed = false, reading = false, writing = false, trailing = false
    setConnections([]); setError(false); setBusy(false)
    if (!open()) return
    const read = async () => {
      if (disposed) return
      if (reading || writing) { trailing = true; return }
      reading = true; setBusy(true)
      do {
        trailing = false
        try {
          const catalog = await client.integration.list({ location: toRequestLocation(location) }, requestLocationOptions(location))
          if (!disposed && !trailing) {
            setConnections(catalog.data.find(item => item.id === integrationID)?.connections ?? [])
            setError(false)
          }
        } catch { if (!disposed && !trailing) setError(true) }
      } while (trailing && !disposed)
      reading = false
      if (!disposed) setBusy(false)
    }
    refresh = () => { void read() }
    run = async (credentialID, action, label) => {
      if (disposed || reading || writing || props.disabled) return false
      if (!connections().some(item => item.type === "credential" && item.id === credentialID)) return false
      writing = true; setBusy(true); setError(false)
      let failed = false
      try {
        const options = requestLocationOptions(location, { includeDirectory: true })
        if (action === "activate") await client.credential.activate({ credentialID }, options)
        else if (action === "remove") await client.credential.remove({ credentialID }, options)
        else await client.credential.update({ credentialID, label: label!.trim() }, options)
      } catch { failed = true }
      finally { writing = false }
      if (disposed) return false
      await read()
      if (failed) { if (!disposed) setError(true); return false }
      if (!disposed) await props.onChanged?.()
      return !disposed
    }
    const events = serverEvents.on("instance.event", payload => {
      if (payload.type === "instance.event" && payload.instanceId === instanceId
        && ["integration.updated", "credential.updated", "credential.switched"].includes(payload.event.type)) refresh()
    })
    const status = serverEvents.on("instance.eventStatus", payload => {
      if (payload.type === "instance.eventStatus" && payload.instanceId === instanceId && payload.status === "connected") refresh()
    })
    const reconnect = serverEvents.onOpen(() => refresh())
    onCleanup(() => { disposed = true; events(); status(); reconnect() })
    void read()
  })
  const ids = () => connections().map(item => item.type === "credential" ? `credential:${item.id}` : `env:${item.name}`)
  return <details class="provider-accounts" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("settings.accounts.title")}</summary>
    <Show when={open()}>
      <p>{t("settings.accounts.global")}</p>
      <button type="button" class="selector-button" disabled={busy()} onClick={() => refresh()}>{t("settings.providers.refresh")}</button>
      <Show when={error()}><p role="alert">{t("settings.accounts.error")}</p></Show>
      <For each={ids()}>{(id, index) => {
        const connection = () => connections().find(item => id === (item.type === "credential" ? `credential:${item.id}` : `env:${item.name}`))!
        const [label, setLabel] = createSignal("")
        const [dirty, setDirty] = createSignal(false)
        let editRevision = 0
        createEffect(() => { const item = connection(); if (!dirty()) setLabel(item.type === "credential" ? item.label : item.name) })
        return <div class="provider-account" data-account-id={id}>
          <span>{connection().type === "credential" ? (connection() as Extract<ConnectionInfo, { type: "credential" }>).label : (connection() as Extract<ConnectionInfo, { type: "env" }>).name}</span>
          <Show when={index() === 0}><span class="badge-shape">{t("settings.accounts.active")}</span></Show>
          <Show when={connection().type === "credential"} fallback={<span>{t("settings.providers.source.env")}</span>}>
            <input class="providers-input" aria-label={t("settings.accounts.label")} value={label()} maxlength={256} disabled={busy() || props.disabled}
              onInput={event => { editRevision++; setDirty(true); setLabel(event.currentTarget.value) }} />
            <button type="button" class="selector-button" disabled={busy() || props.disabled || !label().trim() || !dirty()}
              onClick={() => {
                const revision = editRevision
                void run(id.slice(11), "rename", label()).then(saved => { if (saved && revision === editRevision) setDirty(false) })
              }}>{t("settings.configFiles.actions.save")}</button>
            <button type="button" class="selector-button" disabled={busy() || props.disabled || index() === 0}
              onClick={() => void run(id.slice(11), "activate")}>{t("settings.accounts.activate")}</button>
            <button type="button" class="selector-button" disabled={busy() || props.disabled}
              onClick={() => void run(id.slice(11), "remove")}>{t("settings.providers.actions.remove")}</button>
          </Show>
        </div>
      }}</For>
    </Show>
  </details>
}
