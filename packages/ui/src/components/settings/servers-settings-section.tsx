import { ExternalLink, Loader2, Pencil, Server, Trash2 } from "lucide-solid"
import { createSignal, For, Show, type Component } from "solid-js"
import type { RemoteServerProfile } from "../../../../server/src/api-types"
import { useI18n } from "../../lib/i18n"
import { serverDisplayName } from "../../lib/codenomad-link"
import { useRemoteServerProfiles, type RemoteServerInput } from "../../lib/hooks/use-remote-server-profiles"
import { showConfirmDialog } from "../../stores/alerts"
import { RemoteServerDialog } from "../remote-server-dialog"
import ServerAddField from "../server-add-field"

/**
 * Settings → Servers, the one place that manages saved CodeNomad servers: add
 * (the inline address field), open, edit (the server dialog) and remove.
 * Opening shows a project tab where this window has tabs, else the server's
 * own window (Preferences, unverified certificates).
 */
export const ServersSettingsSection: Component = () => {
  const { t } = useI18n()
  const { remoteServers, connectingServerId, submitServer, openServer, removeRemoteServerProfile } = useRemoteServerProfiles()
  // The saved server being edited.
  const [dialog, setDialog] = createSignal<{ initial: RemoteServerInput } | null>(null)
  const displayName = (server: RemoteServerProfile) => serverDisplayName(server, remoteServers())

  async function remove(server: RemoteServerProfile) {
    const confirmed = await showConfirmDialog(t("folderSelection.remoteProject.removeConfirm", { name: displayName(server) }), {
      title: t("folderSelection.servers.remove"),
      variant: "warning",
      confirmLabel: t("folderSelection.servers.remove"),
    })
    if (confirmed) removeRemoteServerProfile(server.id)
  }

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <Server class="settings-card-heading-icon" />
            <h3 class="settings-card-title">{t("folderSelection.servers.title")}</h3>
          </div>
        </div>
        <div class="settings-card-content">
          {/* Adding saves the server, like Browse's field, without opening it here. */}
          <ServerAddField />
          <Show when={remoteServers().length > 0} fallback={<div class="settings-card-message">{t("folderSelection.servers.empty.title")}</div>}>
            <For each={remoteServers()}>
              {(server) => (
                <div class="settings-toggle-row settings-toggle-row-compact" data-remote-server={server.id}>
                  <div class="flex items-center gap-2 min-w-0">
                    <Server class="w-4 h-4 icon-muted shrink-0" aria-hidden="true" />
                    <div class="min-w-0">
                      <div class="settings-toggle-title truncate"><bdi dir="auto">{displayName(server)}</bdi></div>
                      <div class="settings-toggle-caption font-mono truncate" dir="ltr">{server.baseUrl}</div>
                    </div>
                  </div>
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      class="selector-button selector-button-secondary w-auto"
                      disabled={Boolean(connectingServerId())}
                      aria-label={`${t("settings.servers.open")}: ${displayName(server)}`}
                      title={`${t("settings.servers.open")}: ${displayName(server)}`}
                      onClick={() => openServer(server)}
                    >
                      <Show when={connectingServerId() === server.id} fallback={<ExternalLink class="w-4 h-4" />}>
                        <Loader2 class="w-4 h-4 animate-spin" />
                      </Show>
                    </button>
                    <button
                      type="button"
                      class="selector-button selector-button-secondary w-auto"
                      aria-label={`${t("folderSelection.remoteProject.edit")}: ${displayName(server)}`}
                      title={`${t("folderSelection.remoteProject.edit")}: ${displayName(server)}`}
                      onClick={() => setDialog({ initial: { id: server.id, name: displayName(server), baseUrl: server.baseUrl, skipTlsVerify: server.skipTlsVerify } })}
                    >
                      <Pencil class="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      class="selector-button selector-button-secondary w-auto"
                      aria-label={`${t("folderSelection.servers.remove")}: ${displayName(server)}`}
                      title={`${t("folderSelection.servers.remove")}: ${displayName(server)}`}
                      onClick={() => void remove(server)}
                    >
                      <Trash2 class="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
      <RemoteServerDialog open={dialog() !== null} initial={dialog()?.initial}
        onOpenChange={(open) => { if (!open) setDialog(null) }} onSubmit={submitServer} />
    </div>
  )
}
