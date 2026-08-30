import { Dialog } from "@kobalte/core/dialog"
import { createEffect, createSignal, For, Show, type Component } from "solid-js"
import { AlertTriangle, Loader2, Package, Plus, RefreshCw, Trash2, X } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import { CODENOMAD_API_BASE } from "../../lib/api-client"

interface PluginManagerModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type PluginEntry = {
  spec: string
  enabled: boolean
}

const API_CONFIG_URL = `${CODENOMAD_API_BASE.replace(/\/+$/, "")}/api/opencode-plugin-config`

function isValidPluginSpec(spec: string): boolean {
  const trimmed = spec.trim()
  return (
    trimmed.startsWith("npm:") ||
    trimmed.startsWith("file://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith(".")
  )
}

async function fetchJSON(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    const message = (body as Record<string, unknown>)?.error ?? `HTTP ${response.status}`
    throw new Error(String(message))
  }
  return response.json()
}

export const PluginManagerModal: Component<PluginManagerModalProps> = (props) => {
  const { t } = useI18n()
  const [plugins, setPlugins] = createSignal<PluginEntry[]>([])
  const [loading, setLoading] = createSignal(false)
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [actionError, setActionError] = createSignal<string | null>(null)
  const [validationError, setValidationError] = createSignal<string | null>(null)
  const [newPluginSpec, setNewPluginSpec] = createSignal("")
  const [adding, setAdding] = createSignal(false)
  const [removingIndex, setRemovingIndex] = createSignal<number | null>(null)
  const [confirmRemoveIndex, setConfirmRemoveIndex] = createSignal<number | null>(null)

  createEffect(() => {
    if (!props.open) return
    void loadPluginData()
  })

  async function loadPluginData(): Promise<void> {
    setLoading(true)
    setLoadError(null)
    try {
      const data = (await fetchJSON(API_CONFIG_URL)) as { plugins?: PluginEntry[] }
      setPlugins(data.plugins ?? [])
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("settings.plugins.errors.loadFailed"))
    } finally {
      setLoading(false)
    }
  }

  function validateSpec(spec: string): string | null {
    const trimmed = spec.trim()
    if (!trimmed) return null
    if (!isValidPluginSpec(trimmed)) {
      return t("settings.plugins.errors.invalidSpec")
    }
    return null
  }

  function handleInputChange(value: string) {
    setNewPluginSpec(value)
    if (value.trim()) {
      setValidationError(validateSpec(value))
    } else {
      setValidationError(null)
    }
  }

  function canAdd(): boolean {
    const spec = newPluginSpec().trim()
    return spec.length > 0 && isValidPluginSpec(spec) && !adding()
  }

  async function addPlugin(): Promise<void> {
    const spec = newPluginSpec().trim()
    if (!spec || !isValidPluginSpec(spec)) return
    setAdding(true)
    setActionError(null)
    setValidationError(null)
    try {
      const currentList = [...plugins()]
      if (!currentList.some((p) => p.spec === spec)) {
        currentList.push({ spec, enabled: true })
      }
      await fetchJSON(API_CONFIG_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plugins: currentList.map((p) => p.spec) }),
      })
      setNewPluginSpec("")
      await loadPluginData()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("settings.plugins.errors.addFailed"))
    } finally {
      setAdding(false)
    }
  }

  function requestRemovePlugin(index: number) {
    setConfirmRemoveIndex(index)
  }

  function cancelRemove() {
    setConfirmRemoveIndex(null)
  }

  async function confirmRemovePlugin(): Promise<void> {
    const index = confirmRemoveIndex()
    if (index === null) return
    setRemovingIndex(index)
    setConfirmRemoveIndex(null)
    setActionError(null)
    try {
      const currentList = [...plugins()]
      currentList.splice(index, 1)
      await fetchJSON(API_CONFIG_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plugins: currentList.map((p) => p.spec) }),
      })
      await loadPluginData()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("settings.plugins.errors.removeFailed"))
    } finally {
      setRemovingIndex(null)
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay" />
        <Dialog.Content class="modal-surface providers-manager-modal">
          <div class="providers-manager-header">
            <div class="settings-card-heading-with-icon">
              <Package class="settings-card-heading-icon" />
              <div>
                <Dialog.Title class="providers-manager-title">{t("settings.plugins.title")}</Dialog.Title>
                <p class="settings-card-subtitle">{t("settings.plugins.subtitle")}</p>
              </div>
            </div>
            <button type="button" class="selector-button selector-button-secondary settings-screen-close" onClick={() => props.onOpenChange(false)} aria-label={t("settings.close")}>
              <X class="w-4 h-4" />
            </button>
          </div>

          <div class="providers-manager-body">
            <div class="providers-connect-bar">
              <div style={{ flex: 1, display: "flex", "flex-direction": "column", gap: "0.25rem" }}>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <input
                    type="text"
                    class="providers-input"
                    value={newPluginSpec()}
                    onInput={(event) => handleInputChange(event.currentTarget.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") void addPlugin() }}
                    placeholder={t("settings.plugins.addPlaceholder")}
                    disabled={adding()}
                  />
                  <button type="button" class="selector-button selector-button-primary" disabled={!canAdd()} onClick={() => void addPlugin()}>
                    <Show when={adding()} fallback={<><Plus class="w-4 h-4" />{t("settings.plugins.actions.add")}</>}>
                      <Loader2 class="providers-spin-icon" />
                    </Show>
                  </button>
                </div>
                <Show when={validationError()}>
                  <div class="text-[11px] flex items-center gap-1" style={{ color: "var(--status-warning)" }}>
                    <AlertTriangle class="w-3 h-3" />
                    {validationError()}
                  </div>
                </Show>
              </div>
              <button type="button" class="settings-pill-button" disabled={loading()} onClick={() => void loadPluginData()}>
                <RefreshCw class={loading() ? "providers-spin-icon" : "providers-button-icon"} />
                {t("settings.plugins.refresh")}
              </button>
            </div>

            <Show when={loadError()}>
              <div class="settings-error-message">{loadError()}</div>
            </Show>
            <Show when={actionError()}>
              <div class="settings-error-message">{actionError()}</div>
            </Show>

            <div class="settings-card-message" style={{ "margin-top": "0.5rem" }}>
              {t("settings.plugins.restartNote")}
            </div>

            <section class="providers-list-section">
              <h3 class="settings-card-title">{t("settings.plugins.configured.title")}</h3>
              <Show when={loading()}>
                <div class="providers-loading-row"><Loader2 class="providers-spin-icon" /><span>{t("settings.plugins.loading")}</span></div>
              </Show>
              <Show when={!loading() && plugins().length === 0}>
                <div class="settings-card-message">{t("settings.plugins.empty.noPlugins")}</div>
              </Show>
              <div class="providers-grid">
                <For each={plugins()}>
                  {(plugin, index) => {
                    const isConfirming = () => confirmRemoveIndex() === index()
                    const isRemoving = () => removingIndex() === index()
                    return (
                      <article class="providers-card">
                        <div class="providers-card-main">
                          <div class="providers-card-copy">
                            <div class="providers-card-title-row">
                              <h4 class="providers-card-title" style="word-break:break-all">{plugin.spec}</h4>
                            </div>
                            <p class="providers-card-meta">
                              {plugin.enabled ? t("settings.plugins.status.enabled") : t("settings.plugins.status.disabled")}
                            </p>
                          </div>
                        </div>
                        <div class="providers-card-footer">
                          <Show
                            when={isConfirming()}
                            fallback={
                              <button
                                type="button"
                                class="selector-button selector-button-secondary providers-disconnect-button"
                                disabled={isRemoving()}
                                onClick={() => requestRemovePlugin(index())}
                              >
                                <Show when={isRemoving()} fallback={<><Trash2 class="w-4 h-4" />{t("settings.plugins.actions.remove")}</>}>
                                  <Loader2 class="providers-spin-icon" />
                                </Show>
                              </button>
                            }
                          >
                            <div style={{ display: "flex", gap: "0.5rem", "align-items": "center" }}>
                              <span class="text-xs">{t("settings.plugins.remove.confirm")}</span>
                              <button type="button" class="selector-button selector-button-primary text-xs" onClick={() => void confirmRemovePlugin()}>
                                {t("settings.plugins.remove.confirmYes")}
                              </button>
                              <button type="button" class="selector-button selector-button-secondary text-xs" onClick={cancelRemove}>
                                {t("settings.plugins.remove.confirmNo")}
                              </button>
                            </div>
                          </Show>
                        </div>
                      </article>
                    )
                  }}
                </For>
              </div>
            </section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}
