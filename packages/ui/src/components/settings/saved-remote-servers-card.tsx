import { Globe, Loader2, Pencil, Plus, Trash2 } from "lucide-solid"
import { createSignal, For, Show, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { serverDisplayName } from "../../lib/codenomad-link"
import { useRemoteServerProfiles, type RemoteServerInput } from "../../lib/hooks/use-remote-server-profiles"
import { RemoteServerDialog } from "../remote-server-dialog"

export const SavedRemoteServersCard: Component = () => {
  const { t } = useI18n()
  const { remoteServers, connectingServerId, saveServer, connectSavedServer, removeRemoteServerProfile } = useRemoteServerProfiles()
  const [dialogOpen, setDialogOpen] = createSignal(false)
  // The server being edited; none when adding.
  const [editing, setEditing] = createSignal<RemoteServerInput>()
  const openDialog = (server?: RemoteServerInput) => { setEditing(server); setDialogOpen(true) }

  return (
    <>
      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <Globe class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">{t("folderSelection.tabs.servers")}</h3>
              <p class="settings-card-subtitle">{t("folderSelection.servers.empty.description")}</p>
            </div>
          </div>
          <button type="button" class="selector-button selector-button-secondary w-auto" onClick={() => openDialog()}>
            <Plus class="w-4 h-4" />
            <span>{t("folderSelection.actions.connectButton")}</span>
          </button>
        </div>
        <div class="settings-card-content">
          <Show when={remoteServers().length > 0} fallback={<div class="settings-card-message">{t("folderSelection.servers.empty.title")}</div>}>
            <For each={remoteServers()}>
              {(server) => (
                <div class="settings-toggle-row settings-toggle-row-compact">
                  <div class="min-w-0">
                    <div class="settings-toggle-title truncate">{serverDisplayName(server, remoteServers())}</div>
                    <div class="settings-toggle-caption font-mono truncate">{server.baseUrl}</div>
                  </div>
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      class="selector-button selector-button-secondary w-auto"
                      disabled={Boolean(connectingServerId())}
                      aria-label={`${t("folderSelection.servers.dialog.connect")}: ${server.name}`}
                      title={`${t("folderSelection.servers.dialog.connect")}: ${server.name}`}
                      onClick={() => void connectSavedServer(server.id)}
                    >
                      <Show when={connectingServerId() === server.id} fallback={<Globe class="w-4 h-4" />}><Loader2 class="w-4 h-4 animate-spin" /></Show>
                    </button>
                    <button
                      type="button"
                      class="selector-button selector-button-secondary w-auto"
                      title={`${t("folderSelection.remoteProject.edit")}: ${serverDisplayName(server, remoteServers())}`}
                      aria-label={`${t("folderSelection.remoteProject.edit")}: ${serverDisplayName(server, remoteServers())}`}
                      onClick={() => openDialog({ id: server.id, name: serverDisplayName(server, remoteServers()), baseUrl: server.baseUrl, skipTlsVerify: server.skipTlsVerify })}
                    >
                      <Pencil class="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      class="selector-button selector-button-secondary w-auto"
                      title={`${t("folderSelection.servers.remove")}: ${serverDisplayName(server, remoteServers())}`}
                      aria-label={`${t("folderSelection.servers.remove")}: ${serverDisplayName(server, remoteServers())}`}
                      onClick={() => removeRemoteServerProfile(server.id)}
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
      <RemoteServerDialog open={dialogOpen()} onOpenChange={setDialogOpen} onSubmit={saveServer} initial={editing()} />
    </>
  )
}
