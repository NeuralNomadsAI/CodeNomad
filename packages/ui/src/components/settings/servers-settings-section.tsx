import { ExternalLink, Pencil, Server, Terminal, Trash2 } from "lucide-solid"
import { createSignal, For, Show, type Component } from "solid-js"
import type { RemoteServerProfile } from "../../../../server/src/api-types"
import { useI18n } from "../../lib/i18n"
import { serverDisplayName } from "../../lib/codenomad-link"
import { useRelayServerProfiles, remoteServerErrorKey, type RemoteServerInput } from "../../lib/hooks/use-remote-server-profiles"
import { ServerEditor } from "../remote-server-dialog"
import ServerAddField from "../server-add-field"
import { serversUsable, serversManageable } from "../../lib/server-meta"

import type { ServerSelectionIntent } from "../../lib/native/server-selection-intent"
export const ServersSettingsSection: Component<{ onSelectServer?: (profile: ServerSelectionIntent) => Promise<void> }> = (props) => {
  const { t } = useI18n()
  const { remoteServers, enabled, capture, submitServer, removeServer } = useRelayServerProfiles()
  const [dialog, setDialog] = createSignal<{ initial: RemoteServerInput } | null>(null)
  const [error, setError] = createSignal<string>()
  const usable = () => enabled() && serversUsable()
  const manageable = () => usable() && serversManageable()
  const submit = (input: RemoteServerInput, current: () => boolean) =>
    submitServer(input, () => manageable() && current())
  const displayName = (server: RemoteServerProfile) => serverDisplayName(server, remoteServers())
  async function remove(server: RemoteServerProfile) {
    if (!manageable()) return
    const target = { ...server }, op = capture(target)
    try {
      if (!op.current()) return
      setError(undefined)
      try { await removeServer(target, manageable) }
      catch (failure) { if (op.current()) setError(remoteServerErrorKey(failure)) }
    } finally { op.dispose() }
  }
  async function open(server: RemoteServerProfile) {
    if (!usable() || !props.onSelectServer) return
    const op = capture({ ...server })
    setError(undefined)
    try { if (op.current()) await props.onSelectServer(Object.freeze({ id: server.id, baseUrl: server.baseUrl, skipTlsVerify: server.skipTlsVerify,
      ...(server.ssh ? { ssh: Object.freeze({ ...server.ssh }) } : {}) })) }
    catch (failure) { if (op.current()) setError(remoteServerErrorKey(failure)) }
    finally { op.dispose() }
  }
  return (
    <Show when={usable()}><div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header"><div class="settings-card-heading-with-icon">
          <Server class="settings-card-heading-icon" /><h3 class="settings-card-title">{t("folderSelection.servers.title")}</h3>
        </div>
        </div>
        <div class="settings-card-content">
          <Show when={manageable()}><div class="flex items-start gap-2">
            <div class="flex-1 min-w-0"><ServerAddField /></div>
            <button type="button" class="window-icon-button"
              aria-label={t("settings.servers.addSsh")} title={t("settings.servers.addSsh")}
              onClick={() => { if (manageable()) setDialog({ initial: { name: "", baseUrl: "", skipTlsVerify: false } }) }}>
              <Terminal class="w-4 h-4" aria-hidden="true" />
            </button>
          </div></Show>
          <Show when={error()}>{key => <p class="server-add-field-error" role="alert">{t(key())}</p>}</Show>
          <Show when={remoteServers().length > 0} fallback={<div class="settings-card-message">{t("folderSelection.servers.empty.title")}</div>}>
            <For each={remoteServers()}>{server => (
              <div class="settings-toggle-row settings-toggle-row-compact" data-remote-server={server.id}>
                <div class="flex items-center gap-2 min-w-0"><Server class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
                  <div class="min-w-0"><div class="settings-toggle-title truncate"><bdi dir="auto">{displayName(server)}</bdi></div>
                    <div class="settings-toggle-caption font-mono truncate" dir="ltr">{server.baseUrl}</div></div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <button type="button" class="selector-button selector-button-secondary w-auto" disabled={!props.onSelectServer || !usable()}
                    aria-label={`${t("settings.servers.open")}: ${displayName(server)}`} title={`${t("settings.servers.open")}: ${displayName(server)}`} onClick={() => void open(server)}><ExternalLink class="w-4 h-4" /></button>
                  <Show when={manageable()}><button type="button" class="selector-button selector-button-secondary w-auto"
                    aria-label={`${t("folderSelection.remoteProject.edit")}: ${displayName(server)}`} title={`${t("folderSelection.remoteProject.edit")}: ${displayName(server)}`}
                    onClick={() => { if (manageable()) setDialog({ initial: { id: server.id, name: server.name, baseUrl: server.baseUrl, skipTlsVerify: server.skipTlsVerify,
                      ...(server.ssh ? { ssh: { ...server.ssh } } : {}) } }) }}><Pencil class="w-4 h-4" /></button>
                  <button type="button" class="selector-button selector-button-secondary w-auto"
                    aria-label={`${t("folderSelection.servers.remove")}: ${displayName(server)}`} title={`${t("folderSelection.servers.remove")}: ${displayName(server)}`} onClick={() => void remove(server)}><Trash2 class="w-4 h-4" /></button></Show>
                </div>
              </div>
            )}</For>
          </Show>
        </div>
      </div>
      <Show when={manageable()}><ServerEditor open={dialog() !== null} initial={dialog()?.initial} onOpenChange={open => { if (!open) setDialog(null) }} onSubmit={submit} /></Show>
    </div></Show>
  )
}
