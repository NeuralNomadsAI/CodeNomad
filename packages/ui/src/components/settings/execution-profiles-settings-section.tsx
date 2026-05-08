import { createEffect, createMemo, createSignal, For, Show, type Component } from "solid-js"
import { Pencil, Plus, Star, Trash2 } from "lucide-solid"
import type { ExecutionProfile, ExecutionProfilePreviewResponse, ExecutionProfileTestResponse } from "../../../../server/src/api-types"
import { serverApi } from "../../lib/api-client"
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

function formatPreviewEnvironment(environment: Record<string, string>): string {
  return Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
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
  const [previewWorkspacePath, setPreviewWorkspacePath] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [previewing, setPreviewing] = createSignal(false)
  const [testing, setTesting] = createSignal(false)
  const [formError, setFormError] = createSignal<string | null>(null)
  const [previewError, setPreviewError] = createSignal<string | null>(null)
  const [testError, setTestError] = createSignal<string | null>(null)
  const [previewResult, setPreviewResult] = createSignal<ExecutionProfilePreviewResponse | null>(null)
  const [testResult, setTestResult] = createSignal<ExecutionProfileTestResponse | null>(null)

  const kindOptions = createMemo(() => [
    { value: "local" as const, label: t("settings.opencode.executionProfiles.kind.local") },
    { value: "wsl" as const, label: t("settings.opencode.executionProfiles.kind.wsl") },
    { value: "docker" as const, label: t("settings.opencode.executionProfiles.kind.docker") },
    { value: "command" as const, label: t("settings.opencode.executionProfiles.kind.command") },
  ])

  createEffect(() => {
    kind()
    name()
    binaryPath()
    distro()
    image()
    workspaceMountPath()
    configMountPath()
    commandText()
    extraDockerArgsText()
    executable()
    argsText()
    cwdMode()
    previewWorkspacePath()
    setPreviewError(null)
    setTestError(null)
    setPreviewResult(null)
    setTestResult(null)
  })

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
    setPreviewWorkspacePath("")
    setFormError(null)
  }

  function requireValue(value: string): string | null {
    return value.trim().length > 0 ? value.trim() : null
  }

  function buildProfileFromForm(): ExecutionProfile {
    const trimmedName = requireValue(name())
    if (!trimmedName) {
      throw new Error(t("settings.opencode.executionProfiles.validation.name"))
    }

    if (kind() === "local") {
      const trimmedBinaryPath = requireValue(binaryPath())
      if (!trimmedBinaryPath) {
        throw new Error(t("settings.opencode.executionProfiles.validation.binaryPath"))
      }
      return {
        id: editingId() ?? createProfileId(),
        kind: "local",
        name: trimmedName,
        binaryPath: trimmedBinaryPath,
      }
    }

    if (kind() === "wsl") {
      const trimmedDistro = requireValue(distro())
      const trimmedBinaryPath = requireValue(binaryPath())
      if (!trimmedDistro) {
        throw new Error(t("settings.opencode.executionProfiles.validation.distro"))
      }
      if (!trimmedBinaryPath) {
        throw new Error(t("settings.opencode.executionProfiles.validation.binaryPath"))
      }
      return {
        id: editingId() ?? createProfileId(),
        kind: "wsl",
        name: trimmedName,
        distro: trimmedDistro,
        binaryPath: trimmedBinaryPath,
      }
    }

    if (kind() === "docker") {
      const trimmedImage = requireValue(image())
      const trimmedWorkspaceMountPath = requireValue(workspaceMountPath())
      const trimmedConfigMountPath = requireValue(configMountPath())
      if (!trimmedImage || !trimmedWorkspaceMountPath || !trimmedConfigMountPath) {
        throw new Error(t("settings.opencode.executionProfiles.validation.docker"))
      }
      return {
        id: editingId() ?? createProfileId(),
        kind: "docker",
        name: trimmedName,
        image: trimmedImage,
        workspaceMountPath: trimmedWorkspaceMountPath,
        configMountPath: trimmedConfigMountPath,
        command: parseStringList(commandText()),
        extraDockerArgs: parseStringList(extraDockerArgsText()),
      }
    }

    const trimmedExecutable = requireValue(executable())
    if (!trimmedExecutable) {
      throw new Error(t("settings.opencode.executionProfiles.validation.executable"))
    }
    return {
      id: editingId() ?? createProfileId(),
      kind: "command",
      name: trimmedName,
      executable: trimmedExecutable,
      args: parseStringList(argsText()),
      cwdMode: cwdMode(),
    }
  }

  async function handleSave() {
    let profile: ExecutionProfile
    setFormError(null)
    try {
      profile = buildProfileFromForm()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
      return
    }

    setSaving(true)
    try {
      await saveExecutionProfile(profile)
      resetForm()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  async function handlePreview() {
    let profile: ExecutionProfile
    setFormError(null)
    setPreviewError(null)

    try {
      profile = buildProfileFromForm()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
      return
    }

    setPreviewing(true)
    try {
      const result = await serverApi.previewExecutionProfile({
        profile,
        workspacePath: requireValue(previewWorkspacePath()) ?? undefined,
      })
      setPreviewResult(result)
    } catch (error) {
      setPreviewResult(null)
      setPreviewError(error instanceof Error ? error.message : String(error))
    } finally {
      setPreviewing(false)
    }
  }

  async function handleTest() {
    let profile: ExecutionProfile
    setFormError(null)
    setTestError(null)

    try {
      profile = buildProfileFromForm()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
      return
    }

    setTesting(true)
    try {
      const result = await serverApi.testExecutionProfile({
        profile,
        workspacePath: requireValue(previewWorkspacePath()) ?? undefined,
      })
      setPreviewResult(result)
      setTestResult(result)
    } catch (error) {
      setTestResult(null)
      setTestError(error instanceof Error ? error.message : String(error))
    } finally {
      setTesting(false)
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

          <div class="settings-toggle-row settings-toggle-row-compact">
            <div>
              <div class="settings-toggle-title">{t("settings.opencode.executionProfiles.form.previewWorkspacePath.label")}</div>
              <div class="settings-toggle-caption">{t("settings.opencode.executionProfiles.form.previewWorkspacePath.subtitle")}</div>
            </div>
            <input class="selector-input w-full max-w-xs" value={previewWorkspacePath()} placeholder={t("settings.opencode.executionProfiles.form.previewWorkspacePath.placeholder")} onInput={(event) => setPreviewWorkspacePath(event.currentTarget.value)} />
          </div>

          <Show when={formError()}>
            <div class="settings-error-message">{formError()}</div>
          </Show>

          <Show when={previewError()}>
            <div class="settings-error-message">{previewError()}</div>
          </Show>

          <Show when={testError()}>
            <div class="settings-error-message">{testError()}</div>
          </Show>

          <div class="flex justify-end gap-2 mt-4">
            <Show when={editingId()}>
              <button type="button" class="selector-button selector-button-secondary" onClick={() => resetForm()}>
                {t("settings.opencode.executionProfiles.form.cancelEdit")}
              </button>
            </Show>
            <button type="button" class="selector-button selector-button-secondary" disabled={saving() || previewing() || testing()} onClick={() => void handleTest()}>
              <span>{testing() ? t("settings.opencode.executionProfiles.form.testing") : t("settings.opencode.executionProfiles.form.test")}</span>
            </button>
            <button type="button" class="selector-button selector-button-secondary" disabled={saving() || previewing() || testing()} onClick={() => void handlePreview()}>
              <span>{previewing() ? t("settings.opencode.executionProfiles.form.previewing") : t("settings.opencode.executionProfiles.form.preview")}</span>
            </button>
            <button type="button" class="selector-button selector-button-primary" disabled={saving() || previewing() || testing()} onClick={() => void handleSave()}>
              <Show when={saving()} fallback={<Plus class="w-4 h-4" />}>
                <Plus class="w-4 h-4" />
              </Show>
              <span>{editingId() ? t("settings.opencode.executionProfiles.form.update") : t("settings.opencode.executionProfiles.form.save")}</span>
            </button>
          </div>

          <Show when={testResult()}>
            {(result) => (
              <div class="settings-form-group mt-4">
                <div class="settings-form-label">{t("settings.opencode.executionProfiles.test.title")}</div>
                <div class="mt-3 rounded-lg border border-base bg-surface-secondary p-3 text-sm text-primary">
                  <Show when={result().valid} fallback={<span>{result().error ?? t("settings.opencode.executionProfiles.test.failureFallback")}</span>}>
                    <span>
                      {result().version
                        ? t("settings.opencode.executionProfiles.test.successWithVersion", { version: result().version })
                        : t("settings.opencode.executionProfiles.test.success")}
                    </span>
                  </Show>
                </div>
              </div>
            )}
          </Show>

          <Show when={previewResult()}>
            {(result) => (
              <div class="settings-form-group mt-4">
                <div class="settings-form-label">{t("settings.opencode.executionProfiles.preview.title")}</div>
                <div class="settings-toggle-caption">{t("settings.opencode.executionProfiles.preview.subtitle")}</div>

                <div class="mt-3 rounded-lg border border-base bg-surface-secondary p-3 flex flex-col gap-3">
                  <div>
                    <div class="text-xs font-medium uppercase tracking-wide text-secondary">{t("settings.opencode.executionProfiles.preview.commandLine")}</div>
                    <pre class="mt-2 text-xs whitespace-pre-wrap break-all text-primary bg-surface-primary border border-base rounded-md p-4 font-mono">{result().commandLine}</pre>
                  </div>

                  <div>
                    <div class="text-xs font-medium uppercase tracking-wide text-secondary">{t("settings.opencode.executionProfiles.preview.cwd")}</div>
                    <pre class="mt-2 text-xs whitespace-pre-wrap break-all text-primary bg-surface-primary border border-base rounded-md p-4 font-mono">{result().cwd ?? t("settings.opencode.executionProfiles.preview.cwd.inherit")}</pre>
                  </div>

                  <div>
                    <div class="text-xs font-medium uppercase tracking-wide text-secondary">{t("settings.opencode.executionProfiles.preview.environment")}</div>
                    <pre class="mt-2 text-xs whitespace-pre-wrap break-all text-primary bg-surface-primary border border-base rounded-md p-4 font-mono">{formatPreviewEnvironment(result().environment)}</pre>
                  </div>
                </div>
              </div>
            )}
          </Show>
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
