import { For, Show, createEffect, createMemo, createSignal, type Component } from "solid-js"
import { Plus, Search, RefreshCw, Power, Trash2, Key, CheckCircle2, XCircle } from "lucide-solid"
import { useConfig } from "../stores/preferences"
import { instances, stopInstance, createInstance } from "../stores/instances"
import { providers, fetchProviders } from "../stores/sessions"
import { getLogger } from "../lib/logger"
import { getProviderLogoUrl } from "../lib/models-api"
import { cn } from "../lib/cn"
import {
  Card,
  Button,
  Input,
  Label,
  Badge,
  Separator,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "./ui"

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
    <Card>
      <div class="flex flex-col space-y-1.5 px-4 py-3 border-b border-border bg-secondary">
        <h3 class="text-base font-semibold text-foreground">Providers</h3>
        <p class="text-xs text-muted-foreground">Show enabled providers, add more via a focused flow</p>
      </div>

      <div class="p-4 space-y-4">
        <div class="flex items-end flex-wrap gap-2">
          <div class="flex flex-col gap-1">
            <Label class="text-xs text-muted-foreground">Reference Instance</Label>
            <select
              class={cn(
                "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                "min-w-[240px]"
              )}
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

          <Button
            variant="secondary"
            size="sm"
            disabled={!referenceInstanceId() || loadingCatalog()}
            onClick={() => referenceInstanceId() && void loadCatalog(referenceInstanceId()!)}
          >
            <RefreshCw class="w-3.5 h-3.5" />
            {loadingCatalog() ? "Refreshing..." : "Refresh"}
          </Button>

          <Button
            size="sm"
            disabled={!referenceInstanceId()}
            onClick={() => void restartReferenceInstance()}
          >
            <Power class="w-3.5 h-3.5" />
            Restart to Apply
          </Button>
        </div>

        <Show
          when={referenceInstanceId()}
          fallback={<p class="text-xs text-muted-foreground italic">Start an instance first to manage providers.</p>}
        >
          <div class="space-y-3">
            <div class="flex items-center justify-between gap-2">
              <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Enabled providers</div>
              <Button size="sm" onClick={() => openProviderModal()}>
                <Plus class="w-3.5 h-3.5" />
                Add Provider
              </Button>
            </div>

            <Show
              when={activeProviders().length > 0}
              fallback={<p class="text-xs text-muted-foreground italic">No providers loaded yet. Add a provider and restart.</p>}
            >
              <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <For each={activeProviders()}>
                  {(provider) => {
                    const isConfigured = () => configuredProviderIds().has(provider.id)
                    const isConnected = () => connectedProviderIds().has(provider.id)

                    return (
                      <Card class="flex flex-col p-3 gap-3">
                        <div class="flex items-start justify-between">
                          <div class="w-8 h-8 rounded-md bg-secondary flex items-center justify-center overflow-hidden">
                            <img
                              src={getProviderLogoUrl(provider.id)}
                              alt={provider.name}
                              class="w-6 h-6 object-contain"
                              onError={(e) => {
                                e.currentTarget.style.display = 'none'
                              }}
                            />
                          </div>
                          <div>
                            <Show when={isConnected()}>
                              <Badge variant="success" class="text-[10px]">
                                <CheckCircle2 class="w-3 h-3" />
                                Connected
                              </Badge>
                            </Show>
                            <Show when={!isConnected() && isConfigured()}>
                              <Badge variant="secondary" class="text-[10px]">
                                Configured
                              </Badge>
                            </Show>
                            <Show when={!isConnected() && !isConfigured()}>
                              <Badge variant="destructive" class="text-[10px]">
                                <XCircle class="w-3 h-3" />
                                Not configured
                              </Badge>
                            </Show>
                          </div>
                        </div>
                        <div>
                          <div class="text-sm font-medium text-foreground">{provider.name}</div>
                          <div class="text-xs text-muted-foreground">
                            {provider.modelCount} model{provider.modelCount !== 1 ? 's' : ''} available
                          </div>
                        </div>
                        <div class="flex items-center gap-2 mt-auto">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => openProviderModal(provider.id)}
                          >
                            <Key class="w-3.5 h-3.5" />
                            Configure
                          </Button>
                          <Show when={isConfigured()}>
                            <Button
                              variant="destructive"
                              size="icon"
                              class="h-8 w-8"
                              onClick={() => removeProviderKeys(provider.id)}
                              title="Remove stored keys"
                            >
                              <Trash2 class="w-3.5 h-3.5" />
                            </Button>
                          </Show>
                        </div>
                      </Card>
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>

          <p class="text-xs text-muted-foreground">
            Adding provider keys updates global environment variables. Restart is required because OpenCode reads env vars at process start.
          </p>
        </Show>
      </div>

      <Dialog open={modalOpen()} onOpenChange={(open) => (open ? setModalOpen(true) : closeProviderModal())}>
        <DialogContent class="max-w-3xl max-h-[85vh] flex flex-col overflow-hidden rounded-xl shadow-xl">
          <DialogHeader class="px-6 py-4 border-b border-border">
            <DialogTitle>
              {selectedProviderId() ? `Configure ${providerSummaryLabel(selectedProviderId()!)}` : "Add Provider"}
            </DialogTitle>
            <DialogDescription class="text-xs mt-1">Pick a provider, enter only the keys it needs.</DialogDescription>
          </DialogHeader>

          <div class="p-6 flex flex-col gap-4 overflow-y-auto">
            <Show when={!selectedProviderId()}>
              <div class="flex items-center gap-2">
                <Search class="w-4 h-4 text-muted-foreground" />
                <Input
                  class="flex-1"
                  value={providerSearch()}
                  onInput={(event) => setProviderSearch(event.currentTarget.value)}
                  placeholder="Search providers (openai, anthropic, openrouter...)"
                />
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[400px] overflow-y-auto">
                <For each={filteredProviders()}>
                  {(entry) => (
                    <button
                      type="button"
                      class={cn(
                        "flex items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors",
                        "hover:bg-secondary/80 cursor-pointer"
                      )}
                      onClick={() => openProviderModal(entry.id)}
                    >
                      <div class="w-8 h-8 rounded-md bg-secondary flex items-center justify-center overflow-hidden shrink-0">
                        <img
                          src={getProviderLogoUrl(entry.id)}
                          alt={entry.name}
                          class="w-5 h-5 object-contain"
                          onError={(e) => {
                            e.currentTarget.style.display = 'none'
                          }}
                        />
                      </div>
                      <div class="min-w-0">
                        <div class="text-sm font-medium text-foreground">{entry.name}</div>
                        <div class="text-xs text-muted-foreground">
                          requires {entry.env?.length ?? 0} key{(entry.env?.length ?? 0) === 1 ? "" : "s"}
                        </div>
                      </div>
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <Show when={selectedProvider()}>
              {(entry) => (
                <div class="space-y-3">
                  <Card class="px-3 py-2">
                    <div class="text-sm font-medium text-foreground">{entry().name}</div>
                    <div class="text-xs text-muted-foreground">{entry().id}</div>
                  </Card>

                  <Show
                    when={(entry().env?.length ?? 0) > 0}
                    fallback={<p class="text-xs text-muted-foreground italic">No environment variables required for this provider.</p>}
                  >
                    <div class="space-y-2">
                      <For each={entry().env}>
                        {(key) => (
                          <div class="flex items-center gap-2 flex-wrap">
                            <Label class="text-xs text-muted-foreground min-w-[220px]">{key}</Label>
                            <Input
                              type="password"
                              class="flex-1 min-w-[240px]"
                              value={draftKeys()[key] ?? ""}
                              placeholder={envVars()[key] ? "(set)" : "Enter value"}
                              onInput={(event) => setDraftKeys((prev) => ({ ...prev, [key]: event.currentTarget.value }))}
                            />
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>

                  <p class="text-xs text-muted-foreground">
                    Restart the instance after saving keys to load provider models.
                  </p>
                </div>
              )}
            </Show>
          </div>

          <DialogFooter class="px-6 py-4 border-t border-border gap-2">
            <Button variant="secondary" onClick={closeProviderModal}>
              Close
            </Button>
            <Show when={selectedProviderId()}>
              <Button onClick={saveProviderKeys}>
                Save Keys
              </Button>
            </Show>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

export default ProviderSettingsPanel
