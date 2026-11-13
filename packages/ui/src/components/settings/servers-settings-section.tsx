import { ExternalLink, Pencil, Plus, Server, Trash2 } from "lucide-solid"
import { createSignal, For, Show, type Component } from "solid-js"
import type { RemoteServerProfile } from "../../../../server/src/api-types"
import { useI18n } from "../../lib/i18n"
import { serverDisplayName } from "../../lib/codenomad-link"
import { useRelayServerProfiles, remoteServerErrorKey, type RemoteServerInput } from "../../lib/hooks/use-remote-server-profiles"
import { showConfirmDialog } from "../../stores/alerts"
import { RemoteServerDialog } from "../remote-server-dialog"
import ServerAddField from "../server-add-field"

import type { ServerSelectionIntent } from "../../lib/native/server-selection-intent"
export type { ServerSelectionIntent } from "../../lib/native/server-selection-intent"
export const ServersSettingsSection: Component<{ onSelectServer?: (profile: ServerSelectionIntent) => void }> = (props) => {
  const { t } = useI18n()
  const { remoteServers, enabled, capture, submitServer, removeServer } = useRelayServerProfiles()
  const [dialog, setDialog] = createSignal<{ initial: RemoteServerInput } | null>(null)
  const [error, setError] = createSignal<string>()
  const displayName = (server: RemoteServerProfile) => serverDisplayName(server, remoteServers())
  async function remove(server: RemoteServerProfile) {
    const target = { ...server }, op = capture(target)
    try {
      if (!op.current()) return
      const confirmed = await showConfirmDialog(t("folderSelection.remoteProject.removeConfirm", { name: displayName(target) }), {
        title: t("folderSelection.servers.remove"), variant: "warning", confirmLabel: t("folderSelection.servers.remove"),
      }, op.signal)
      if (!confirmed || !op.current()) return
      setError(undefined)
      try { await removeServer(target) }
      catch (failure) { if (op.current()) setError(remoteServerErrorKey(failure)) }
    } finally { op.dispose() }
  }
  function open(server: RemoteServerProfile) {
    if (!enabled() || !props.onSelectServer) return
    const op = capture({ ...server })
    try { if (op.current()) props.onSelectServer(Object.freeze({ id: server.id, baseUrl: server.baseUrl, skipTlsVerify: server.skipTlsVerify,
      ...(server.ssh ? { ssh: Object.freeze({ ...server.ssh }) } : {}) })) }
    finally { op.dispose() }
  }
  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header"><div class="settings-card-heading-with-icon">
          <Server class="settings-card-heading-icon" /><h3 class="settings-card-title">{t("folderSelection.servers.title")}</h3>
        </div>
          <button type="button" class="selector-button selector-button-secondary w-auto" disabled={!enabled()}
            onClick={() => { if (enabled()) setDialog({ initial: { name: "", baseUrl: "", skipTlsVerify: false } }) }}>
            <Plus class="w-4 h-4" /><span>{t("folderSelection.browseMenu.add")}</span>
          </button>
        </div>
        <div class="settings-card-content">
          <ServerAddField />
          <Show when={error()}>{key => <p class="server-add-field-error" role="alert">{t(key())}</p>}</Show>
          <Show when={remoteServers().length > 0} fallback={<div class="settings-card-message">{t("folderSelection.servers.empty.title")}</div>}>
            <For each={remoteServers()}>{server => (
              <div class="settings-toggle-row settings-toggle-row-compact" data-remote-server={server.id}>
                <div class="flex items-center gap-2 min-w-0"><Server class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
                  <div class="min-w-0"><div class="settings-toggle-title truncate"><bdi dir="auto">{displayName(server)}</bdi></div>
                    <div class="settings-toggle-caption font-mono truncate" dir="ltr">{server.baseUrl}</div></div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <button type="button" class="selector-button selector-button-secondary w-auto" disabled={!props.onSelectServer || !enabled()}
                    aria-label={`${t("settings.servers.open")}: ${displayName(server)}`} title={`${t("settings.servers.open")}: ${displayName(server)}`} onClick={() => open(server)}><ExternalLink class="w-4 h-4" /></button>
                  <button type="button" class="selector-button selector-button-secondary w-auto"
                    aria-label={`${t("folderSelection.remoteProject.edit")}: ${displayName(server)}`} title={`${t("folderSelection.remoteProject.edit")}: ${displayName(server)}`}
                    onClick={() => { if (enabled()) setDialog({ initial: { id: server.id, name: displayName(server), baseUrl: server.baseUrl, skipTlsVerify: server.skipTlsVerify,
                      ...(server.ssh ? { ssh: { ...server.ssh } } : {}) } }) }}><Pencil class="w-4 h-4" /></button>
                  <button type="button" class="selector-button selector-button-secondary w-auto"
                    aria-label={`${t("folderSelection.servers.remove")}: ${displayName(server)}`} title={`${t("folderSelection.servers.remove")}: ${displayName(server)}`} onClick={() => void remove(server)}><Trash2 class="w-4 h-4" /></button>
                </div>
              </div>
            )}</For>
          </Show>
        </div>
      </div>
      <RemoteServerDialog open={dialog() !== null} initial={dialog()?.initial} onOpenChange={open => { if (!open) setDialog(null) }} onSubmit={submitServer} onEditSubmit={(input, current) => submitServer(input, false, current)} />
    </div>
  )
}
