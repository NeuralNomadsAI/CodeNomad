import { createMemo, createSignal, For, Show, onMount, type Component } from "solid-js"
import { Globe, Loader2, Plus, Trash2 } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import { serverApi } from "../../lib/api-client"
import { ensureSidecarsLoaded, sidecars, sidecarsLoading } from "../../stores/sidecars"

function deriveSidecarId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
}

export const SideCarsSettingsSection: Component = () => {
  const { t } = useI18n()
  const [name, setName] = createSignal("")
  const [port, setPort] = createSignal("3000")
  const [insecure, setInsecure] = createSignal(false)
  const [prefixMode, setPrefixMode] = createSignal<"strip" | "preserve">("strip")
  const [busyId, setBusyId] = createSignal<string | null>(null)
  const [creating, setCreating] = createSignal(false)
  const [formError, setFormError] = createSignal<string | null>(null)
  const [actionError, setActionError] = createSignal<string | null>(null)

  onMount(() => {
    void ensureSidecarsLoaded()
  })

  const orderedSidecars = createMemo(() => Array.from(sidecars().values()).sort((a, b) => a.name.localeCompare(b.name)))
  const derivedId = createMemo(() => deriveSidecarId(name()) || "your-sidecar")

  async function handleCreate() {
    const trimmedName = name().trim()
    const nextPort = Number(port())
    if (!trimmedName || !Number.isInteger(nextPort) || nextPort <= 0 || nextPort > 65535) {
      setFormError(t("sidecars.form.validation"))
      return
    }

    setCreating(true)
    setFormError(null)
    try {
      await serverApi.createSidecar({
        kind: "port",
        name: trimmedName,
        port: nextPort,
        insecure: insecure(),
        prefixMode: prefixMode(),
      })
      setName("")
      setPort("3000")
      setInsecure(false)
      setPrefixMode("strip")
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(id: string) {
    setBusyId(id)
    setActionError(null)
    try {
      await serverApi.deleteSidecar(id)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <Globe class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">{t("settings.section.sidecars.title")}</h3>
              <p class="settings-card-subtitle">{t("settings.section.sidecars.subtitle")}</p>
            </div>
          </div>
          <span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span>
        </div>

        <div class="settings-card-content">
          <div class="settings-toggle-row settings-toggle-row-compact">
            <div>
              <div class="settings-toggle-title">{t("sidecars.form.name")}</div>
              <div class="settings-toggle-caption">{t("sidecars.basePath")}: <code>/sidecars/{derivedId()}</code></div>
            </div>
            <input
              class="selector-input w-full max-w-xs"
              value={name()}
              onInput={(event) => {
                setFormError(null)
                setName(event.currentTarget.value)
              }}
            />
          </div>

          <div class="settings-toggle-row settings-toggle-row-compact">
            <div>
              <div class="settings-toggle-title">{t("sidecars.form.port")}</div>
              <div class="settings-toggle-caption">127.0.0.1</div>
            </div>
            <input
              class="selector-input w-full max-w-xs"
              value={port()}
              onInput={(event) => {
                setFormError(null)
                setPort(event.currentTarget.value)
              }}
              inputMode="numeric"
            />
          </div>

          <div class="settings-toggle-row settings-toggle-row-compact">
            <div>
              <div class="settings-toggle-title">{t("sidecars.form.protocol")}</div>
              <div class="settings-toggle-caption">{t("sidecars.form.protocol.help")}</div>
            </div>
            <select class="selector-input w-full max-w-xs" value={insecure() ? "http" : "https"} onChange={(event) => setInsecure(event.currentTarget.value === "http") }>
              <option value="https">{t("sidecars.form.protocol.https")}</option>
              <option value="http">{t("sidecars.form.protocol.http")}</option>
            </select>
          </div>

          <div class="settings-toggle-row settings-toggle-row-compact">
            <div>
              <div class="settings-toggle-title">{t("sidecars.form.prefixMode")}</div>
              <div class="settings-toggle-caption">{t("sidecars.form.prefixMode.help")}</div>
            </div>
            <select class="selector-input w-full max-w-xs" value={prefixMode()} onChange={(event) => setPrefixMode(event.currentTarget.value as "strip" | "preserve") }>
              <option value="strip">{t("sidecars.form.prefixMode.strip")}</option>
              <option value="preserve">{t("sidecars.form.prefixMode.preserve")}</option>
            </select>
          </div>

          <Show when={formError()}>
            <div class="text-sm text-red-500">{formError()}</div>
          </Show>

          <div class="flex justify-end">
            <button type="button" class="selector-button selector-button-primary" disabled={creating()} onClick={() => void handleCreate()}>
              <Show when={creating()} fallback={<Plus class="w-4 h-4" />}>
                <Loader2 class="w-4 h-4 animate-spin" />
              </Show>
              <span>{t("sidecars.form.add")}</span>
            </button>
          </div>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("sidecars.settings.listTitle")}</h3>
            <p class="settings-card-subtitle">{t("sidecars.settings.listSubtitle")}</p>
          </div>
        </div>

        <div class="settings-card-content">
          <Show when={actionError()}>
            <div class="text-sm text-red-500">{actionError()}</div>
          </Show>

          <Show when={!sidecarsLoading()} fallback={<div class="settings-card-message">{t("sidecars.picker.loading")}</div>}>
            <Show when={orderedSidecars().length > 0} fallback={<div class="settings-card-message">{t("sidecars.settings.empty")}</div>}>
              <For each={orderedSidecars()}>
                {(sidecar) => (
                  <div class="settings-toggle-row settings-toggle-row-compact">
                    <div>
                      <div class="settings-toggle-title">{sidecar.name}</div>
                      <div class="settings-toggle-caption">
                        {t("sidecars.kind.port")} · {sidecar.insecure ? "http" : "https"}://127.0.0.1:{sidecar.port}
                      </div>
                      <div class="settings-toggle-caption">
                        {t("sidecars.basePath")}: <code>/sidecars/{sidecar.id}</code> · {t(`sidecars.form.prefixMode.${sidecar.prefixMode}`)}
                      </div>
                    </div>

                    <div class="flex items-center gap-2">
                      <span class="text-xs text-secondary min-w-[4.5rem] text-right">{t(`sidecars.status.${sidecar.status}`)}</span>
                      <button type="button" class="selector-button selector-button-secondary" disabled={busyId() === sidecar.id} onClick={() => void handleDelete(sidecar.id)}>
                        <Trash2 class="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  )
}
