import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import type { ConnectionInfo, LocationRef, OpenCodeClient } from "@opencode/client"
import { Pencil, RefreshCw, Trash2, LockKeyhole } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import { serverEvents } from "../../lib/server-events"
import { requestLocationOptions, toRequestLocation } from "../../stores/request-locations"

export function ProviderAccounts(props: {
  instanceId: string
  integrationId: string
  client: OpenCodeClient
  location: LocationRef
  disabled?: boolean
  initialConnections?: ConnectionInfo[]
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
  const activeConnection = () => (open() ? connections() : props.initialConnections ?? [])[0]
  const connectionLabel = (item: ConnectionInfo) => item.type === "credential" ? item.label : item.name
  return <details class="provider-accounts" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary title={t("settings.accounts.global")}>
      <span>{t("settings.accounts.title")}</span>
      <Show when={activeConnection()}>{item => <span class="provider-accounts-current">
        <span>{connectionLabel(item())}</span><span class="badge-shape">{t("settings.accounts.active")}</span>
      </span>}</Show>
    </summary>
    <Show when={open()}>
      <div class="provider-accounts-toolbar"><button type="button" class="icon-button-compact" disabled={busy()}
        aria-label={t("settings.providers.refresh")} title={t("settings.providers.refresh")} onClick={() => refresh()}>
        <RefreshCw size={14} classList={{ "animate-spin": busy() }} />
      </button></div>
      <Show when={error()}><p role="alert">{t("settings.accounts.error")}</p></Show>
      <For each={ids()}>{(id, index) => {
        const connection = () => connections().find(item => id === (item.type === "credential" ? `credential:${item.id}` : `env:${item.name}`))!
        const [label, setLabel] = createSignal("")
        const [dirty, setDirty] = createSignal(false)
        const [editing, setEditing] = createSignal(false)
        let input: HTMLInputElement | undefined
        let editRevision = 0
        createEffect(() => { const item = connection(); if (!dirty()) setLabel(item.type === "credential" ? item.label : item.name) })
        return <div class="provider-account" data-account-id={id}>
          <span class="provider-account-name">{connectionLabel(connection())}</span>
          <Show when={index() === 0}><span class="badge-shape">{t("settings.accounts.active")}</span></Show>
          <Show when={connection().type === "credential"} fallback={<span title={t("settings.providers.source.env")} aria-label={t("settings.providers.source.env")}><LockKeyhole size={14} /></span>}>
            <div class="provider-account-actions">
            <Show when={index() !== 0}><button type="button" class="selector-button" disabled={busy() || props.disabled}
              onClick={() => void run(id.slice(11), "activate")}>{t("settings.accounts.activate")}</button></Show>
            <button type="button" class="icon-button-compact" disabled={busy() || props.disabled}
              title={t("settings.accounts.rename")} aria-label={t("settings.accounts.rename")}
              onClick={() => { setEditing(true); queueMicrotask(() => { input?.focus(); input?.select() }) }}><Pencil size={14} /></button>
            <button type="button" class="icon-button-compact" disabled={busy() || props.disabled}
              title={t("settings.accounts.remove")} aria-label={t("settings.accounts.remove")}
              onClick={() => void run(id.slice(11), "remove")}><Trash2 size={14} /></button>
            </div>
            <Show when={editing()}><form class="provider-account-edit" onSubmit={event => {
              event.preventDefault()
              if (busy() || props.disabled || !label().trim() || !dirty()) return
              const revision = editRevision
              void run(id.slice(11), "rename", label()).then(saved => {
                if (saved && revision === editRevision) { setDirty(false); setEditing(false) }
              })
            }}>
            <input ref={input} class="providers-input" aria-label={t("settings.accounts.label")} value={label()} maxlength={256} disabled={busy() || props.disabled}
              onInput={event => { editRevision++; setDirty(true); setLabel(event.currentTarget.value) }} />
            <button type="submit" class="selector-button" disabled={busy() || props.disabled || !label().trim() || !dirty()}
              >{t("settings.configFiles.actions.save")}</button>
            <button type="button" class="selector-button" disabled={busy() || props.disabled}
              onClick={() => { setDirty(false); setEditing(false); setLabel(connectionLabel(connection())) }}>{t("alertDialog.actions.cancel")}</button>
            </form></Show>
          </Show>
        </div>
      }}</For>
    </Show>
  </details>
}
