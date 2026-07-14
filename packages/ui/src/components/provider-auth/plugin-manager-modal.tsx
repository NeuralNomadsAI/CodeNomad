import { Dialog } from "@kobalte/core/dialog"
import { createEffect, createMemo, createSignal, For, Show, type Component } from "solid-js"
import { Loader2, Package, Plus, RefreshCw, Trash2, X } from "lucide-solid"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { useI18n } from "../../lib/i18n"
import { requestData } from "../../lib/opencode-api"
import { instances } from "../../stores/instances"

interface PluginManagerModalProps {
  instanceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

type PluginEntry = {
  spec: string
  enabled: boolean
}

export const PluginManagerModal: Component<PluginManagerModalProps> = (props) => {
  const { t } = useI18n()
  const [plugins, setPlugins] = createSignal<PluginEntry[]>([])
  const [configData, setConfigData] = createSignal<Record<string, unknown>>({})
  const [loading, setLoading] = createSignal(false)
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [actionError, setActionError] = createSignal<string | null>(null)
  const [newPluginSpec, setNewPluginSpec] = createSignal("")
  const [adding, setAdding] = createSignal(false)

  const instance = createMemo(() => instances().get(props.instanceId) ?? null)
  const client = createMemo<OpencodeClient | null>(() => instance()?.client ?? null)

  createEffect(() => {
    if (!props.open) return
    const c = client()
    if (!c) return
    void loadPluginData(c)
  })

  async function loadPluginData(c: OpencodeClient): Promise<void> {
    setLoading(true)
    setLoadError(null)
    try {
      const configResponse = await (c as any).config.get()
      const data = (configResponse?.data ?? {}) as Record<string, unknown>
      setConfigData(data)
      const rawPlugins: unknown = data.plugin
      setPlugins(parsePluginEntries(rawPlugins))
    } catch (error) {
      setLoadError(t("settings.plugins.errors.loadFailed"))
    } finally {
      setLoading(false)
    }
  }

  function parsePluginEntries(raw: unknown): PluginEntry[] {
    if (!Array.isArray(raw)) return []
    return raw.map((entry: unknown) => {
      if (typeof entry === "string") {
        return { spec: entry, enabled: true }
      }
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string") {
        const opts = entry[1] as Record<string, unknown> | null | undefined
        return { spec: entry[0], enabled: opts?.enabled !== false }
      }
      return null
    }).filter((entry): entry is PluginEntry => entry !== null)
  }

  function serializedPluginList(): string[] {
    return plugins().map((p) => {
      if (p.enabled) return p.spec
      return `${p.spec}:disabled`
    })
  }

  async function addPlugin(): Promise<void> {
    const spec = newPluginSpec().trim()
    if (!spec) return
    const c = client()
    if (!c) return
    setAdding(true)
    setActionError(null)
    try {
      const current = (configData().plugin ?? []) as unknown[]
      const existing = Array.isArray(current) ? [...current] : []
      existing.push(spec)
      await requestData(
        (c as any).config.update({
          config: { ...configData(), plugin: existing },
        }),
        "config.update",
      )
      setNewPluginSpec("")
      await loadPluginData(c)
    } catch (error) {
      setActionError(t("settings.plugins.errors.addFailed"))
    } finally {
      setAdding(false)
    }
  }

  async function removePlugin(index: number): Promise<void> {
    const c = client()
    if (!c) return
    setActionError(null)
    try {
      const current = (configData().plugin ?? []) as unknown[]
      const updated = Array.isArray(current) ? current.filter((_, i) => i !== index) : []
      await requestData(
        (c as any).config.update({
          config: { ...configData(), plugin: updated },
        }),
        "config.update",
      )
      await loadPluginData(c)
    } catch (error) {
      setActionError(t("settings.plugins.errors.removeFailed"))
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
            <Show when={!client()}>
              <div class="settings-card-message">{t("settings.plugins.empty.noInstance")}</div>
            </Show>

            <Show when={client()}>
              <div class="providers-connect-bar">
                <div class="providers-form-stack" style={{ flex: 1, display: "flex", gap: "0.5rem" }}>
                  <input
                    type="text"
                    class="providers-input"
                    value={newPluginSpec()}
                    onInput={(event) => setNewPluginSpec(event.currentTarget.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") void addPlugin() }}
                    placeholder={t("settings.plugins.addPlaceholder")}
                    disabled={adding()}
                  />
                  <button type="button" class="selector-button selector-button-primary" disabled={!newPluginSpec().trim() || adding()} onClick={() => void addPlugin()}>
                    <Show when={adding()} fallback={<><Plus class="w-4 h-4" />{t("settings.plugins.actions.add")}</>}>
                      <Loader2 class="providers-spin-icon" />
                    </Show>
                  </button>
                </div>
                <button type="button" class="settings-pill-button" disabled={loading()} onClick={() => client() && void loadPluginData(client()!)}>
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
                    {(plugin, index) => (
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
                          <button type="button" class="selector-button selector-button-secondary providers-disconnect-button" onClick={() => void removePlugin(index())}>
                            <Trash2 class="w-4 h-4" />
                            {t("settings.plugins.actions.remove")}
                          </button>
                        </div>
                      </article>
                    )}
                  </For>
                </div>
              </section>
            </Show>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}
