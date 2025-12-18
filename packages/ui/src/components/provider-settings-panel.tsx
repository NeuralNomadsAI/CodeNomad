import { Dialog } from "@kobalte/core/dialog"
import { For, Show, createEffect, createMemo, createSignal, type Component } from "solid-js"
import { Plus, Search, RefreshCw, Power, Trash2, Key } from "lucide-solid"
import { useConfig } from "../stores/preferences"
import { instances, stopInstance, createInstance } from "../stores/instances"
import { providers, fetchProviders } from "../stores/sessions"
import { getLogger } from "../lib/logger"

const log = getLogger("actions")

type ProviderCatalogEntry = {
  id: string
  name: string
  env: string[]
}

type ProviderCatalog = {
  all: ProviderCatalogEntry[]
  connected: string[]
  default: Record<string, string>
}

const ProviderSettingsPanel: Component = () => {
  const { preferences, updateEnvironmentVariables } = useConfig()

  const instanceOptions = createMemo(() => Array.from(instances().values()).filter((i) => i.status === "ready" && i.client))
  const [referenceInstanceId, setReferenceInstanceId] = createSignal<string | null>(null)

  const [catalog, setCatalog] = createSignal<ProviderCatalog | null>(null)
  const [loadingCatalog, setLoadingCatalog] = createSignal(false)

  const [modalOpen, setModalOpen] = createSignal(false)
  const [providerSearch, setProviderSearch] = createSignal("")
  const [selectedProviderId, setSelectedProviderId] = createSignal<string | null>(null)
  const [draftKeys, setDraftKeys] = createSignal<Record<string, string>>({})

  const envVars = createMemo(() => preferences().environmentVariables ?? {})

  const activeProviderList = createMemo(() => {
    const id = referenceInstanceId()
    if (!id) return []
    return providers().get(id) ?? []
  })

  const connectedProviderIds = createMemo(() => new Set((catalog()?.connected ?? []).map((id) => id)))

  createEffect(() => {
    if (!referenceInstanceId() && instanceOptions().length > 0) {
      setReferenceInstanceId(instanceOptions()[0].id)
    }
  })

  const loadCatalog = async (instanceId: string) => {
    const instance = instances().get(instanceId)
    if (!instance?.client) return

    setLoadingCatalog(true)
    try {
      await fetchProviders(instanceId).catch(() => {})
      const response = await instance.client.provider.list()
      if (response.data) {
        setCatalog(response.data as unknown as ProviderCatalog)
      }
    } catch (error) {
      log.error("Failed to load provider catalog", { instanceId, error })
      setCatalog(null)
    } finally {
      setLoadingCatalog(false)
    }
  }

  createEffect(() => {
    const id = referenceInstanceId()
    if (!id) return
    void loadCatalog(id)
  })

  const providerById = createMemo(() => {
    const map = new Map<string, ProviderCatalogEntry>()
    for (const entry of catalog()?.all ?? []) {
      if (entry?.id) map.set(entry.id, entry)
    }
    return map
  })

  const activeProviders = createMemo(() => {
    const map = providerById()
    return activeProviderList().map((p) => ({
      id: p.id,
      name: p.name,
      env: map.get(p.id)?.env ?? [],
      modelCount: p.models?.length ?? 0,
    }))
  })

  const configuredProviderIds = createMemo(() => {
    const map = providerById()
    const result = new Set<string>()
    const vars = envVars()

    for (const entry of map.values()) {
      if (!entry.env?.length) {
        result.add(entry.id)
        continue
      }
      if (entry.env.every((key) => Boolean(vars[key]?.trim()))) {
        result.add(entry.id)
      }
    }

    return result
  })

  const openProviderModal = (providerId?: string) => {
    const id = providerId ?? null
    setSelectedProviderId(id)

    if (id) {
      const entry = providerById().get(id)
      if (entry) {
        const nextDraft: Record<string, string> = {}
        for (const key of entry.env ?? []) {
          nextDraft[key] = envVars()[key] ?? ""
        }
        setDraftKeys(nextDraft)
      }
    } else {
      setDraftKeys({})
    }

    setProviderSearch("")
    setModalOpen(true)
  }

  const closeProviderModal = () => {
    setModalOpen(false)
    setProviderSearch("")
    setSelectedProviderId(null)
    setDraftKeys({})
  }

  const filteredProviders = createMemo(() => {
    const query = providerSearch().trim().toLowerCase()
    const list = catalog()?.all ?? []

    if (!query) {
      return list.slice(0, 30)
    }

    return list
      .filter((entry) => entry.name.toLowerCase().includes(query) || entry.id.toLowerCase().includes(query))
      .slice(0, 50)
  })

  const selectedProvider = createMemo(() => {
    const id = selectedProviderId()
    if (!id) return null
    return providerById().get(id) ?? null
  })

  const saveProviderKeys = () => {
    const entry = selectedProvider()
    if (!entry) return

    const next = { ...envVars() }
    for (const key of entry.env ?? []) {
      const value = (draftKeys()[key] ?? "").trim()
      if (value) next[key] = value
      else delete next[key]
    }

    updateEnvironmentVariables(next)
    closeProviderModal()
  }

  const removeProviderKeys = (providerId: string) => {
    const entry = providerById().get(providerId)
    if (!entry) return

    const next = { ...envVars() }
    for (const key of entry.env ?? []) {
      delete next[key]
    }

    updateEnvironmentVariables(next)
  }

  const restartReferenceInstance = async () => {
    const id = referenceInstanceId()
    if (!id) return
    const instance = instances().get(id)
    if (!instance) return

    const folder = instance.folder
    await stopInstance(id)
    await createInstance(folder)
  }

  const providerSummaryLabel = (providerId: string) => {
    const entry = providerById().get(providerId)
    if (!entry) return providerId
    return entry.name
  }

  return (
    <div class="panel">
      <div class="panel-header">
        <h3 class="panel-title">Providers</h3>
        <p class="panel-subtitle">Show enabled providers, add more via a focused flow</p>
      </div>

      <div class="panel-body" style={{ gap: "var(--space-md)" }}>
        <div class="flex items-end flex-wrap" style={{ gap: "var(--space-sm)" }}>
          <div class="flex flex-col" style={{ gap: "var(--space-xs)" }}>
            <label class="text-xs text-secondary">Reference Instance</label>
            <select
              class="modal-input min-w-[240px]"
              value={referenceInstanceId() ?? ""}
              onChange={(event) => setReferenceInstanceId(event.currentTarget.value)}
              disabled={instanceOptions().length === 0}
            >
              <For each={instanceOptions()}>
                {(instance) => (
                  <option value={instance.id}>
                    {instance.binaryLabel ?? "opencode"} • {instance.folder}
                  </option>
                )}
              </For>
            </select>
          </div>

          <button
            type="button"
            class="modal-button modal-button--secondary"
            disabled={!referenceInstanceId() || loadingCatalog()}
            onClick={() => referenceInstanceId() && void loadCatalog(referenceInstanceId()!)}
          >
            <RefreshCw class="w-3.5 h-3.5" />
            {loadingCatalog() ? "Refreshing..." : "Refresh"}
          </button>

          <button type="button" class="modal-button modal-button--primary" disabled={!referenceInstanceId()} onClick={() => void restartReferenceInstance()}>
            <Power class="w-3.5 h-3.5" />
            Restart to Apply
          </button>
        </div>

        <Show
          when={referenceInstanceId()}
          fallback={<p class="text-xs text-secondary italic">Start an instance first to manage providers.</p>}
        >
          <div class="flex flex-col" style={{ gap: "var(--space-sm)" }}>
            <div class="flex items-center justify-between" style={{ gap: "var(--space-sm)" }}>
              <div class="text-xs font-medium text-muted uppercase tracking-wide">Enabled providers</div>
              <button type="button" class="modal-button modal-button--primary" onClick={() => openProviderModal()}>
                <Plus class="w-3.5 h-3.5" />
                Add Provider
              </button>
            </div>

            <Show
              when={activeProviders().length > 0}
              fallback={<p class="text-xs text-secondary italic">No providers loaded yet. Add a provider and restart.</p>}
            >
              <div class="flex flex-col" style={{ gap: "var(--space-sm)" }}>
                <For each={activeProviders()}>
                  {(provider) => {
                    const isConfigured = () => configuredProviderIds().has(provider.id)
                    const isConnected = () => connectedProviderIds().has(provider.id)

                    return (
                      <div class="px-3 py-2 rounded-md border bg-surface-secondary border-base">
                        <div class="flex items-center justify-between" style={{ gap: "var(--space-md)" }}>
                          <div class="flex flex-col min-w-0">
                            <div class="text-sm text-primary font-medium truncate">
                              {provider.name} <span class="text-xs text-secondary">({provider.id})</span>
                            </div>
                            <div class="text-xs text-secondary">
                              <span>Models: {provider.modelCount}</span>
                              <span class="px-2">•</span>
                              <span>Configured: {isConfigured() ? "yes" : "no"}</span>
                              <span class="px-2">•</span>
                              <span>Connected: {isConnected() ? "yes" : "no"}</span>
                            </div>
                          </div>

                          <div class="flex items-center flex-shrink-0" style={{ gap: "var(--space-xs)" }}>
                            <button
                              type="button"
                              class="modal-button modal-button--secondary"
                              onClick={() => openProviderModal(provider.id)}
                            >
                              <Key class="w-3.5 h-3.5" />
                              Keys
                            </button>
                            <button
                              type="button"
                              class="modal-button modal-button--danger"
                              onClick={() => removeProviderKeys(provider.id)}
                              title="Remove stored keys"
                            >
                              <Trash2 class="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>

          <div class="text-xs text-secondary">
            Adding provider keys updates global environment variables. Restart is required because OpenCode reads env vars at process start.
          </div>
        </Show>
      </div>

      <Dialog open={modalOpen()} onOpenChange={(open) => (open ? setModalOpen(true) : closeProviderModal())}>
        <Dialog.Portal>
          <Dialog.Overlay class="modal-overlay" />
          <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
            <Dialog.Content class="modal-surface w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden">
              <header class="px-6 py-4 border-b" style={{ "border-color": "var(--border-base)" }}>
                <Dialog.Title class="text-lg font-semibold text-primary">
                  {selectedProviderId() ? `Configure ${providerSummaryLabel(selectedProviderId()!)}` : "Add Provider"}
                </Dialog.Title>
                <div class="text-[11px] text-secondary mt-1">Pick a provider, enter only the keys it needs.</div>
              </header>

              <div class="p-6 flex flex-col gap-4 overflow-y-auto">
                <Show when={!selectedProviderId()}>
                  <div class="flex items-center gap-2">
                    <Search class="w-4 h-4 icon-muted" />
                    <input
                      class="selector-search-input flex-1"
                      value={providerSearch()}
                      onInput={(event) => setProviderSearch(event.currentTarget.value)}
                      placeholder="Search providers (openai, anthropic, openrouter...)"
                    />
                  </div>

                  <div class="space-y-2">
                    <For each={filteredProviders()}>
                      {(entry) => (
                        <button
                          type="button"
                          class="w-full px-3 py-2 rounded-lg border bg-surface-secondary border-base text-left hover:bg-surface-muted transition-colors"
                          onClick={() => openProviderModal(entry.id)}
                        >
                          <div class="text-sm font-medium text-primary">{entry.name}</div>
                          <div class="text-[11px] text-secondary">
                            {entry.id} • requires {entry.env?.length ?? 0} key{(entry.env?.length ?? 0) === 1 ? "" : "s"}
                          </div>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={selectedProvider()}>
                  {(entry) => (
                    <div class="space-y-3">
                      <div class="px-3 py-2 rounded-lg border bg-surface-secondary border-base">
                        <div class="text-sm font-medium text-primary">{entry().name}</div>
                        <div class="text-[11px] text-secondary">{entry().id}</div>
                      </div>

                      <Show
                        when={(entry().env?.length ?? 0) > 0}
                        fallback={<p class="text-[11px] text-secondary italic">No environment variables required for this provider.</p>}
                      >
                        <div class="space-y-2">
                          <For each={entry().env}>
                            {(key) => (
                              <div class="flex items-center gap-2 flex-wrap">
                                <div class="text-xs text-secondary min-w-[220px]">{key}</div>
                                <input
                                  type="password"
                                  class="selector-search-input flex-1 min-w-[240px]"
                                  value={draftKeys()[key] ?? ""}
                                  placeholder={envVars()[key] ? "(set)" : "Enter value"}
                                  onInput={(event) => setDraftKeys((prev) => ({ ...prev, [key]: event.currentTarget.value }))}
                                />
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>

                      <div class="text-[11px] text-secondary">
                        Restart the instance after saving keys to load provider models.
                      </div>
                    </div>
                  )}
                </Show>
              </div>

              <div class="px-6 py-4 border-t flex items-center justify-end gap-2" style={{ "border-color": "var(--border-base)" }}>
                <button type="button" class="selector-button selector-button-secondary" onClick={closeProviderModal}>
                  Close
                </button>
                <Show when={selectedProviderId()}>
                  <button type="button" class="selector-button" onClick={saveProviderKeys}>
                    Save Keys
                  </button>
                </Show>
              </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog>
    </div>
  )
}

export default ProviderSettingsPanel
