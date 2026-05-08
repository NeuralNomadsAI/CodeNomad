import { createMemo, createSignal, For, Show, type Component } from "solid-js"
import { Pencil, Plus, Star, Trash2 } from "lucide-solid"
import type { ExecutionProfile } from "../../../../server/src/api-types"
import { useConfig } from "../../stores/preferences"
import { useI18n } from "../../lib/i18n"

function createProfileId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `exec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function formatStringList(values?: string[]): string {
  return values?.join("\n") ?? ""
}

function parseStringList(value: string): string[] | undefined {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.length > 0 ? lines : undefined
}

function buildProfileSummary(profile: ExecutionProfile): string {
  switch (profile.kind) {
    case "local":
      return profile.binaryPath
    case "wsl":
      return `${profile.distro} · ${profile.binaryPath}`
    case "docker":
      return `${profile.image} · ${profile.workspaceMountPath}`
    case "command":
      return profile.executable
  }
}

export const ExecutionProfilesSettingsSection: Component = () => {
  const { t } = useI18n()
  const {
    executionProfiles,
    defaultExecutionProfileId,
    saveExecutionProfile,
    setDefaultExecutionProfileId,
    removeExecutionProfile,
  } = useConfig()

  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [kind, setKind] = createSignal<ExecutionProfile["kind"]>("local")
  const [name, setName] = createSignal("")
  const [binaryPath, setBinaryPath] = createSignal("")
  const [distro, setDistro] = createSignal("")
  const [image, setImage] = createSignal("")
  const [workspaceMountPath, setWorkspaceMountPath] = createSignal("/workspace")
  const [configMountPath, setConfigMountPath] = createSignal("/root/.config/opencode")
  const [commandText, setCommandText] = createSignal("")
  const [extraDockerArgsText, setExtraDockerArgsText] = createSignal("")
  const [executable, setExecutable] = createSignal("")
  const [argsText, setArgsText] = createSignal("")
  const [cwdMode, setCwdMode] = createSignal<"workspace" | "inherit">("workspace")
  const [saving, setSaving] = createSignal(false)
  const [formError, setFormError] = createSignal<string | null>(null)

  const kindOptions = createMemo(() => [
    { value: "local" as const, label: t("settings.opencode.executionProfiles.kind.local") },
    { value: "wsl" as const, label: t("settings.opencode.executionProfiles.kind.wsl") },
    { value: "docker" as const, label: t("settings.opencode.executionProfiles.kind.docker") },
    { value: "command" as const, label: t("settings.opencode.executionProfiles.kind.command") },
  ])

  function resetForm(profile?: ExecutionProfile) {
    setEditingId(profile?.id ?? null)
    setKind(profile?.kind ?? "local")
    setName(profile?.name ?? "")
    setBinaryPath(profile?.kind === "local" || profile?.kind === "wsl" ? profile.binaryPath : "")
    setDistro(profile?.kind === "wsl" ? profile.distro : "")
    setImage(profile?.kind === "docker" ? profile.image : "")
    setWorkspaceMountPath(profile?.kind === "docker" ? profile.workspaceMountPath : "/workspace")
    setConfigMountPath(profile?.kind === "docker" ? profile.configMountPath : "/root/.config/opencode")
    setCommandText(profile?.kind === "docker" ? formatStringList(profile.command) : "")
    setExtraDockerArgsText(profile?.kind === "docker" ? formatStringList(profile.extraDockerArgs) : "")
    setExecutable(profile?.kind === "command" ? profile.executable : "")
    setArgsText(profile?.kind === "command" ? formatStringList(profile.args) : "")
    setCwdMode(profile?.kind === "command" ? profile.cwdMode ?? "workspace" : "workspace")
    setFormError(null)
  }

  function requireValue(value: string): string | null {
    return value.trim().length > 0 ? value.trim() : null
  }

  async function handleSave() {
    const trimmedName = requireValue(name())
    if (!trimmedName) {
      setFormError(t("settings.opencode.executionProfiles.validation.name"))
      return
    }

    let profile: ExecutionProfile | null = null
    if (kind() === "local") {
      const trimmedBinaryPath = requireValue(binaryPath())
      if (!trimmedBinaryPath) {
        setFormError(t("settings.opencode.executionProfiles.validation.binaryPath"))
        return
      }
      profile = {
        id: editingId() ?? createProfileId(),
        kind: "local",
        name: trimmedName,
        binaryPath: trimmedBinaryPath,
      }
    } else if (kind() === "wsl") {
      const trimmedDistro = requireValue(distro())
      const trimmedBinaryPath = requireValue(binaryPath())
      if (!trimmedDistro) {
        setFormError(t("settings.opencode.executionProfiles.validation.distro"))
        return
      }
      if (!trimmedBinaryPath) {
        setFormError(t("settings.opencode.executionProfiles.validation.binaryPath"))
        return
      }
      profile = {
        id: editingId() ?? createProfileId(),
        kind: "wsl",
        name: trimmedName,
        distro: trimmedDistro,
        binaryPath: trimmedBinaryPath,
      }
    } else if (kind() === "docker") {
      const trimmedImage = requireValue(image())
      const trimmedWorkspaceMountPath = requireValue(workspaceMountPath())
      const trimmedConfigMountPath = requireValue(configMountPath())
      if (!trimmedImage || !trimmedWorkspaceMountPath || !trimmedConfigMountPath) {
        setFormError(t("settings.opencode.executionProfiles.validation.docker"))
        return
      }
      profile = {
        id: editingId() ?? createProfileId(),
        kind: "docker",
        name: trimmedName,
        image: trimmedImage,
        workspaceMountPath: trimmedWorkspaceMountPath,
        configMountPath: trimmedConfigMountPath,
        command: parseStringList(commandText()),
        extraDockerArgs: parseStringList(extraDockerArgsText()),
      }
    } else {
      const trimmedExecutable = requireValue(executable())
      if (!trimmedExecutable) {
        setFormError(t("settings.opencode.executionProfiles.validation.executable"))
        return
      }
      profile = {
        id: editingId() ?? createProfileId(),
        kind: "command",
        name: trimmedName,
        executable: trimmedExecutable,
        args: parseStringList(argsText()),
        cwdMode: cwdMode(),
      }
    }

    setSaving(true)
    setFormError(null)
    try {
      await saveExecutionProfile(profile)
      resetForm()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.opencode.executionProfiles.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.opencode.executionProfiles.subtitle")}</p>
          </div>
          <span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span>
        </div>

        <div class="settings-card-content">
          <div class="settings-toggle-row settings-toggle-row-compact">
            <div>
              <div class="settings-toggle-title">{t("settings.opencode.executionProfiles.form.kind.label")}</div>
              <div class="settings-toggle-caption">{t("settings.opencode.executionProfiles.form.kind.subtitle")}</div>
            </div>
            <select class="selector-input w-full max-w-xs" value={kind()} onChange={(event) => setKind(event.currentTarget.value as ExecutionProfile["kind"])}>
              <For each={kindOptions()}>{(option) => <option value={option.value}>{option.label}</option>}</For>
            </select>
          </div>

          <div class="settings-toggle-row settings-toggle-row-compact">
            <div>
              <div class="settings-toggle-title">{t("settings.opencode.executionProfiles.form.name.label")}</div>
              <div class="settings-toggle-caption">{t("settings.opencode.executionProfiles.form.name.subtitle")}</div>
            </div>
            <input class="selector-input w-full max-w-xs" value={name()} placeholder={t("settings.opencode.executionProfiles.form.name.placeholder")} onInput={(event) => setName(event.currentTarget.value)} />
          </div>

          <Show when={kind() === "local" || kind() === "wsl"}>
            <div class="settings-toggle-row settings-toggle-row-compact">
              <div>
                <div class="settings-toggle-title">{t("settings.opencode.executionProfiles.form.binaryPath.label")}</div>
                <div class="settings-toggle-caption">{t("settings.opencode.executionProfiles.form.binaryPath.subtitle")}</div>
              </div>
              <input class="selector-input w-full max-w-xs" value={binaryPath()} placeholder={t("settings.opencode.executionProfiles.form.binaryPath.placeholder")} onInput={(event) => setBinaryPath(event.currentTarget.value)} />
            </div>
          </Show>

          <Show when={kind() === "wsl"}>
            <div class="settings-toggle-row settings-toggle-row-compact">
              <div>
                <div class="settings-toggle-title">{t("settings.opencode.executionProfiles.form.distro.label")}</div>
                <div class="settings-toggle-caption">{t("settings.opencode.executionProfiles.form.distro.subtitle")}</div>
              </div>
              <input class="selector-input w-full max-w-xs" value={distro()} placeholder={t("settings.opencode.executionProfiles.form.distro.placeholder")} onInput={(event) => setDistro(event.currentTarget.value)} />
            </div>
          </Show>

          <Show when={kind() === "docker"}>
            <div class="settings-toggle-row settings-toggle-row-compact">
              <div>
                <div class="settings-toggle-title">{t("settings.opencode.executionProfiles.form.image.label")}</div>
                <div class="settings-toggle-caption">{t("settings.opencode.executionProfiles.form.image.subtitle")}</div>
              </div>
              <input class="selector-input w-full max-w-xs" value={image()} placeholder={t("settings.opencode.executionProfiles.form.image.placeholder")} onInput={(event) => setImage(event.currentTarget.value)} />
            </div>

            <div class="settings-toggle-row settings-toggle-row-compact">
              <div>
                <div class="settings-toggle-title">{t("settings.opencode.executionProfiles.form.workspaceMountPath.label")}</div>
                <div class="settings-toggle-caption">{t("settings.opencode.executionProfiles.form.workspaceMountPath.subtitle")}</div>
              </div>
              <input class="selector-input w-full max-w-xs" value={workspaceMountPath()} placeholder={t("settings.opencode.executionProfiles.form.workspaceMountPath.placeholder")} onInput={(event) => setWorkspaceMountPath(event.currentTarget.value)} />
            </div>

            <div class="settings-toggle-row settings-toggle-row-compact">
              <div>
                <div class="settings-toggle-title">{t("settings.opencode.executionProfiles.form.configMountPath.label")}</div>
                <div class="settings-toggle-caption">{t("settings.opencode.executionProfiles.form.configMountPath.subtitle")}</div>
              </div>
              <input class="selector-input w-full max-w-xs" value={configMountPath()} placeholder={t("settings.opencode.executionProfiles.form.configMountPath.placeholder")} onInput={(event) => setConfigMountPath(event.currentTarget.value)} />
            </div>

            <div class="settings-form-group">
              <label class="settings-form-label">{t("settings.opencode.executionProfiles.form.command.label")}</label>
              <textarea class="selector-input w-full min-h-[6rem]" value={commandText()} placeholder={t("settings.opencode.executionProfiles.form.command.placeholder")} onInput={(event) => setCommandText(event.currentTarget.value)} />
            </div>

            <div class="settings-form-group">
              <label class="settings-form-label">{t("settings.opencode.executionProfiles.form.extraDockerArgs.label")}</label>
              <textarea class="selector-input w-full min-h-[6rem]" value={extraDockerArgsText()} placeholder={t("settings.opencode.executionProfiles.form.extraDockerArgs.placeholder")} onInput={(event) => setExtraDockerArgsText(event.currentTarget.value)} />
            </div>
          </Show>

          <Show when={kind() === "command"}>
            <div class="settings-toggle-row settings-toggle-row-compact">
              <div>
                <div class="settings-toggle-title">{t("settings.opencode.executionProfiles.form.executable.label")}</div>
                <div class="settings-toggle-caption">{t("settings.opencode.executionProfiles.form.executable.subtitle")}</div>
              </div>
              <input class="selector-input w-full max-w-xs" value={executable()} placeholder={t("settings.opencode.executionProfiles.form.executable.placeholder")} onInput={(event) => setExecutable(event.currentTarget.value)} />
            </div>

            <div class="settings-toggle-row settings-toggle-row-compact">
              <div>
                <div class="settings-toggle-title">{t("settings.opencode.executionProfiles.form.cwdMode.label")}</div>
                <div class="settings-toggle-caption">{t("settings.opencode.executionProfiles.form.cwdMode.subtitle")}</div>
              </div>
              <select class="selector-input w-full max-w-xs" value={cwdMode()} onChange={(event) => setCwdMode(event.currentTarget.value as "workspace" | "inherit") }>
                <option value="workspace">{t("settings.opencode.executionProfiles.form.cwdMode.workspace")}</option>
                <option value="inherit">{t("settings.opencode.executionProfiles.form.cwdMode.inherit")}</option>
              </select>
            </div>

            <div class="settings-form-group">
              <label class="settings-form-label">{t("settings.opencode.executionProfiles.form.args.label")}</label>
              <textarea class="selector-input w-full min-h-[6rem]" value={argsText()} placeholder={t("settings.opencode.executionProfiles.form.args.placeholder")} onInput={(event) => setArgsText(event.currentTarget.value)} />
            </div>
          </Show>

          <Show when={formError()}>
            <div class="settings-error-message">{formError()}</div>
          </Show>

          <div class="flex justify-end gap-2 mt-4">
            <Show when={editingId()}>
              <button type="button" class="selector-button selector-button-secondary" onClick={() => resetForm()}>
                {t("settings.opencode.executionProfiles.form.cancelEdit")}
              </button>
            </Show>
            <button type="button" class="selector-button selector-button-primary" disabled={saving()} onClick={() => void handleSave()}>
              <Show when={saving()} fallback={<Plus class="w-4 h-4" />}>
                <Plus class="w-4 h-4" />
              </Show>
              <span>{editingId() ? t("settings.opencode.executionProfiles.form.update") : t("settings.opencode.executionProfiles.form.save")}</span>
            </button>
          </div>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.opencode.executionProfiles.list.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.opencode.executionProfiles.list.subtitle")}</p>
          </div>
        </div>

        <div class="settings-card-content">
          <Show when={executionProfiles().length > 0} fallback={<div class="settings-card-message">{t("settings.opencode.executionProfiles.list.empty")}</div>}>
            <For each={executionProfiles()}>
              {(profile) => {
                const isDefault = () => defaultExecutionProfileId() === profile.id
                return (
                  <div class="settings-toggle-row settings-toggle-row-compact">
                    <div>
                      <div class="settings-toggle-title flex items-center gap-2 flex-wrap">
                        <span>{profile.name}</span>
                        <span class="text-xs text-muted uppercase">{t(`settings.opencode.executionProfiles.kind.${profile.kind}`)}</span>
                        <Show when={isDefault()}>
                          <span class="settings-scope-badge settings-scope-badge-server">{t("settings.opencode.executionProfiles.list.defaultBadge")}</span>
                        </Show>
                      </div>
                      <div class="settings-toggle-caption">{buildProfileSummary(profile)}</div>
                    </div>

                    <div class="flex items-center gap-2">
                      <button type="button" class="selector-button selector-button-secondary" onClick={() => resetForm(profile)} title={t("settings.opencode.executionProfiles.list.actions.edit")}>
                        <Pencil class="w-4 h-4" />
                      </button>
                      <button type="button" class="selector-button selector-button-secondary" disabled={isDefault()} onClick={() => void setDefaultExecutionProfileId(profile.id)} title={t("settings.opencode.executionProfiles.list.actions.makeDefault")}>
                        <Star class="w-4 h-4" />
                      </button>
                      <button type="button" class="selector-button selector-button-secondary" onClick={() => removeExecutionProfile(profile.id)} title={t("settings.opencode.executionProfiles.list.actions.delete")}>
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
