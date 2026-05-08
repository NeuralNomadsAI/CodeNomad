import { createSignal, For, Show, type Component } from "solid-js"
import { Copy, Pencil, Plus, Trash2 } from "lucide-solid"
import type { ConnectionProfile, SshConnectionProfile } from "../../../../server/src/api-types"
import { useConfig } from "../../stores/preferences"
import { useI18n } from "../../lib/i18n"
import { serverApi } from "../../lib/api-client"

function createConnectionProfileId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `conn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function buildConnectionSummary(profile: ConnectionProfile): string {
  if (profile.kind === "remote-server") {
    return profile.baseUrl
  }

  const parts = [profile.username ? `${profile.username}@${profile.host}` : profile.host]
  if (profile.port) parts.push(`:${profile.port}`)
  if (profile.remotePath) parts.push(`· ${profile.remotePath}`)
  return parts.join(" ")
}

function duplicateConnectionProfile(profile: ConnectionProfile, nameSuffix: string): ConnectionProfile {
  const timestamp = new Date().toISOString()
  return {
    ...profile,
    id: createConnectionProfileId(),
    name: `${profile.name} ${nameSuffix}`.trim(),
    createdAt: timestamp,
    updatedAt: timestamp,
    lastConnectedAt: undefined,
  }
}

export const ConnectionProfilesSettingsSection: Component = () => {
  const { t } = useI18n()
  const { connectionProfiles, saveConnectionProfile, removeConnectionProfile } = useConfig()

  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [name, setName] = createSignal("")
  const [host, setHost] = createSignal("")
  const [port, setPort] = createSignal("")
  const [remoteServerPort, setRemoteServerPort] = createSignal("9898")
  const [username, setUsername] = createSignal("")
  const [remotePath, setRemotePath] = createSignal("")
  const [bootstrapScript, setBootstrapScript] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [formError, setFormError] = createSignal<string | null>(null)

  function resetForm(profile?: SshConnectionProfile) {
    setEditingId(profile?.id ?? null)
    setName(profile?.name ?? "")
    setHost(profile?.host ?? "")
    setPort(profile?.port ? String(profile.port) : "")
    setRemoteServerPort(profile?.remoteServerPort ? String(profile.remoteServerPort) : "9898")
    setUsername(profile?.username ?? "")
    setRemotePath(profile?.remotePath ?? "")
    setBootstrapScript(profile?.bootstrapScript ?? "")
    setFormError(null)
  }

  async function handleSave() {
    const trimmedName = name().trim()
    const trimmedHost = host().trim()
    const nextPort = port().trim().length > 0 ? Number(port()) : undefined
    const nextRemoteServerPort = remoteServerPort().trim().length > 0 ? Number(remoteServerPort()) : 9898

    if (!trimmedName) {
      setFormError(t("settings.remoteConnections.validation.name"))
      return
    }
    if (!trimmedHost) {
      setFormError(t("settings.remoteConnections.validation.host"))
      return
    }
    if (nextPort !== undefined && (!Number.isInteger(nextPort) || nextPort <= 0 || nextPort > 65535)) {
      setFormError(t("settings.remoteConnections.validation.port"))
      return
    }
    if (!Number.isInteger(nextRemoteServerPort) || nextRemoteServerPort <= 0 || nextRemoteServerPort > 65535) {
      setFormError(t("settings.remoteConnections.validation.remoteServerPort"))
      return
    }

    const existing = editingId()
      ? connectionProfiles().find((profile) => profile.id === editingId() && profile.kind === "ssh") as SshConnectionProfile | undefined
      : undefined

    const profile: SshConnectionProfile = {
      id: existing?.id ?? createConnectionProfileId(),
      kind: "ssh",
      name: trimmedName,
      host: trimmedHost,
      port: nextPort,
      remoteServerPort: nextRemoteServerPort,
      username: username().trim() || undefined,
      remotePath: remotePath().trim() || undefined,
      bootstrapScript: bootstrapScript().trim() || undefined,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastConnectedAt: existing?.lastConnectedAt,
    }

    setSaving(true)
    setFormError(null)
    try {
      await saveConnectionProfile(profile)
      resetForm()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(profile: ConnectionProfile) {
    if (profile.kind === "ssh") {
      await serverApi.disconnectSshRemote(profile.id).catch(() => undefined)
    }
    removeConnectionProfile(profile.id)
  }

  async function handleDuplicate(profile: ConnectionProfile) {
    setFormError(null)
    try {
      await saveConnectionProfile(duplicateConnectionProfile(profile, t("settings.common.duplicateSuffix")))
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.remoteConnections.form.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.remoteConnections.form.subtitle")}</p>
          </div>
          <span class="settings-scope-badge">{t("settings.scope.device")}</span>
        </div>

        <div class="settings-card-content">
          <div class="settings-toggle-row settings-toggle-row-compact">
            <div>
              <div class="settings-toggle-title">{t("settings.remoteConnections.form.name.label")}</div>
            </div>
            <input class="selector-input w-full max-w-xs" value={name()} placeholder={t("settings.remoteConnections.form.name.placeholder")} onInput={(event) => setName(event.currentTarget.value)} />
          </div>

          <div class="settings-toggle-row settings-toggle-row-compact">
            <div>
              <div class="settings-toggle-title">{t("settings.remoteConnections.form.host.label")}</div>
            </div>
            <input class="selector-input w-full max-w-xs" value={host()} placeholder={t("settings.remoteConnections.form.host.placeholder")} onInput={(event) => setHost(event.currentTarget.value)} />
          </div>

          <div class="settings-toggle-row settings-toggle-row-compact">
            <div>
              <div class="settings-toggle-title">{t("settings.remoteConnections.form.port.label")}</div>
            </div>
            <input class="selector-input w-full max-w-xs" value={port()} inputMode="numeric" placeholder={t("settings.remoteConnections.form.port.placeholder")} onInput={(event) => setPort(event.currentTarget.value)} />
          </div>

          <div class="settings-toggle-row settings-toggle-row-compact">
            <div>
              <div class="settings-toggle-title">{t("settings.remoteConnections.form.remoteServerPort.label")}</div>
            </div>
            <input class="selector-input w-full max-w-xs" value={remoteServerPort()} inputMode="numeric" placeholder={t("settings.remoteConnections.form.remoteServerPort.placeholder")} onInput={(event) => setRemoteServerPort(event.currentTarget.value)} />
          </div>

          <div class="settings-toggle-row settings-toggle-row-compact">
            <div>
              <div class="settings-toggle-title">{t("settings.remoteConnections.form.username.label")}</div>
            </div>
            <input class="selector-input w-full max-w-xs" value={username()} placeholder={t("settings.remoteConnections.form.username.placeholder")} onInput={(event) => setUsername(event.currentTarget.value)} />
          </div>

          <div class="settings-toggle-row settings-toggle-row-compact">
            <div>
              <div class="settings-toggle-title">{t("settings.remoteConnections.form.remotePath.label")}</div>
            </div>
            <input class="selector-input w-full max-w-xs" value={remotePath()} placeholder={t("settings.remoteConnections.form.remotePath.placeholder")} onInput={(event) => setRemotePath(event.currentTarget.value)} />
          </div>

          <div class="settings-form-group">
            <label class="settings-form-label">{t("settings.remoteConnections.form.bootstrapScript.label")}</label>
            <textarea class="selector-input w-full min-h-[8rem]" value={bootstrapScript()} placeholder={t("settings.remoteConnections.form.bootstrapScript.placeholder")} onInput={(event) => setBootstrapScript(event.currentTarget.value)} />
          </div>

          <Show when={formError()}>
            <div class="settings-error-message">{formError()}</div>
          </Show>

          <div class="flex justify-end gap-2 mt-4">
            <Show when={editingId()}>
              <button type="button" class="selector-button selector-button-secondary" onClick={() => resetForm()}>
                {t("settings.remoteConnections.form.cancelEdit")}
              </button>
            </Show>
            <button type="button" class="selector-button selector-button-primary" disabled={saving()} onClick={() => void handleSave()}>
              <Plus class="w-4 h-4" />
              <span>{editingId() ? t("settings.remoteConnections.form.update") : t("settings.remoteConnections.form.save")}</span>
            </button>
          </div>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.remoteConnections.list.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.remoteConnections.list.subtitle")}</p>
          </div>
          <span class="settings-scope-badge">{t("settings.scope.device")}</span>
        </div>

        <div class="settings-card-content">
          <Show when={connectionProfiles().length > 0} fallback={<div class="settings-card-message">{t("settings.remoteConnections.list.empty")}</div>}>
            <For each={connectionProfiles()}>
              {(profile) => {
                const isSsh = () => profile.kind === "ssh"
                return (
                  <div class="settings-toggle-row settings-toggle-row-compact">
                    <div>
                      <div class="settings-toggle-title flex items-center gap-2 flex-wrap">
                        <span>{profile.name}</span>
                        <span class="text-xs text-muted uppercase">{t(`settings.remoteConnections.kind.${profile.kind}`)}</span>
                      </div>
                      <div class="settings-toggle-caption">{buildConnectionSummary(profile)}</div>
                    </div>

                    <div class="flex items-center gap-2">
                      <Show when={isSsh()}>
                        <button
                          type="button"
                          class="selector-button selector-button-secondary"
                          onClick={() => resetForm(profile as SshConnectionProfile)}
                          title={t("settings.remoteConnections.list.actions.edit")}
                        >
                          <Pencil class="w-4 h-4" />
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="selector-button selector-button-secondary"
                        onClick={() => void handleDuplicate(profile)}
                        title={t("settings.remoteConnections.list.actions.duplicate")}
                      >
                        <Copy class="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        class="selector-button selector-button-secondary"
                        onClick={() => void handleDelete(profile)}
                        title={t("settings.remoteConnections.list.actions.delete")}
                      >
                        <Trash2 class="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )
              }}
            </For>
          </Show>
        </div>
      </div>
    </div>
  )
}
