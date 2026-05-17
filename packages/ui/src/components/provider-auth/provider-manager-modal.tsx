import { Dialog } from "@kobalte/core/dialog"
import { Select } from "@kobalte/core/select"
import { createEffect, createMemo, createSignal, For, Show, type Component } from "solid-js"
import { Check, ChevronDown, ExternalLink, KeyRound, Loader2, PlugZap, RefreshCw, ShieldCheck, X } from "lucide-solid"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { openExternalUrl } from "../../lib/external-url"
import { useI18n } from "../../lib/i18n"
import { requestData } from "../../lib/opencode-api"
import {
  extractProviderAuthErrorMessage,
  genericApiMethod,
  isAbortError,
  shouldShowProviderAuthPrompt,
  type ProviderAuthAuthorization,
  type ProviderAuthMethod,
} from "../../lib/provider-auth"
import { instances } from "../../stores/instances"
import { fetchProviders } from "../../stores/sessions"

type AuthStage = "idle" | "prompts" | "authorizing" | "code" | "waiting" | "success" | "error"

type MethodOption = {
  value: string
  label: string
  method: ProviderAuthMethod
  index: number
}

type ConfigurableProviderOption = {
  id: string
  name: string
  modelCount: number
  connectionSummary: string
}

type ListedProvider = {
  id: string
  name: string
  modelCount: number
  source: "env" | "config" | "custom" | "api" | "unknown"
}

type DisconnectMode = "auth-remove" | "disable-in-config" | "not-disconnectable" | "unknown"

interface ProviderManagerModalProps {
  instanceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

function modelCountFromProvider(provider: any): number {
  const models = provider?.models
  if (Array.isArray(models)) return models.length
  if (models && typeof models === "object") return Object.keys(models).length
  return 0
}

export const ProviderManagerModal: Component<ProviderManagerModalProps> = (props) => {
  const { t } = useI18n()
  const [methodsByProvider, setMethodsByProvider] = createSignal<Record<string, ProviderAuthMethod[]>>({})
  const [availableProviders, setAvailableProviders] = createSignal<ListedProvider[]>([])
  const [connectedProviderIds, setConnectedProviderIds] = createSignal<Set<string>>(new Set())
  const [configuredProviderIds, setConfiguredProviderIds] = createSignal<Set<string>>(new Set())
  const [configData, setConfigData] = createSignal<Record<string, any>>({})
  const [selectedProviderId, setSelectedProviderId] = createSignal<string | null>(null)
  const [activeProviderId, setActiveProviderId] = createSignal<string | null>(null)
  const [selectedMethodIndex, setSelectedMethodIndex] = createSignal(0)
  const [apiKey, setApiKey] = createSignal("")
  const [promptValues, setPromptValues] = createSignal<Record<string, string>>({})
  const [authorization, setAuthorization] = createSignal<ProviderAuthAuthorization | null>(null)
  const [code, setCode] = createSignal("")
  const [stage, setStage] = createSignal<AuthStage>("idle")
  const [loading, setLoading] = createSignal(false)
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [actionError, setActionError] = createSignal<string | null>(null)
  let callbackAbortController: AbortController | null = null

  const instance = createMemo(() => instances().get(props.instanceId) ?? null)
  const client = createMemo<OpencodeClient | null>(() => instance()?.client ?? null)

  const providerNameById = createMemo(() => {
    const names = new Map<string, string>()
    for (const provider of availableProviders()) {
      names.set(provider.id, provider.name || provider.id)
    }
    return names
  })

  const configurableProviders = createMemo<ConfigurableProviderOption[]>(() => {
    const ids = new Set<string>()
    for (const provider of availableProviders()) ids.add(provider.id)
    for (const id of Object.keys(methodsByProvider())) ids.add(id)
    return Array.from(ids)
      .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }))
      .map((id) => {
        const listed = availableProviders().find((provider) => provider.id === id)
        return {
          id,
          name: providerNameById().get(id) ?? id,
          modelCount: listed?.modelCount ?? 0,
          connectionSummary: methodSummary(id),
        }
      })
  })

  const configuredProviders = createMemo(() =>
    availableProviders().filter((provider) => isConfiguredProvider(provider)),
  )

  const getDisconnectMode = (provider: ListedProvider): DisconnectMode => {
    if (provider.source === "env") return "not-disconnectable"
    if (provider.source === "config" || configuredProviderIds().has(provider.id)) return "disable-in-config"
    if (provider.source === "api" || provider.source === "custom") return "auth-remove"
    return "unknown"
  }

  const isConfiguredProvider = (provider: ListedProvider) =>
    connectedProviderIds().has(provider.id) ||
    provider.source === "env" ||
    provider.source === "config" ||
    provider.source === "api" ||
    configuredProviderIds().has(provider.id)

  const describeProviderSource = (provider: ListedProvider) => {
    const mode = getDisconnectMode(provider)
    if (mode === "disable-in-config") return t("settings.providers.source.config")
    if (mode === "not-disconnectable") return t("settings.providers.source.env")
    if (provider.source === "api") return t("settings.providers.source.api")
    if (provider.source === "custom") return t("settings.providers.source.custom")
    return t("settings.providers.source.unknown")
  }

  const selectedProviderOption = createMemo(() =>
    configurableProviders().find((provider) => provider.id === selectedProviderId()) ?? configurableProviders()[0] ?? null,
  )

  const activeProviderName = createMemo(() => {
    const providerId = activeProviderId()
    return providerId ? providerNameById().get(providerId) ?? providerId : ""
  })

  const activeMethods = createMemo(() => {
    const providerId = activeProviderId()
    if (!providerId) return [genericApiMethod]
    const methods = methodsByProvider()[providerId]
    return methods && methods.length > 0 ? methods : [genericApiMethod]
  })

  const methodOptions = createMemo<MethodOption[]>(() =>
    activeMethods().map((method, index) => ({
      value: String(index),
      label: method.label || (method.type === "oauth" ? t("settings.providers.method.oauth") : t("settings.providers.method.api")),
      method,
      index,
    })),
  )

  const selectedMethodOption = createMemo(() => methodOptions().find((option) => option.index === selectedMethodIndex()) ?? methodOptions()[0])
  const selectedMethod = createMemo(() => selectedMethodOption()?.method ?? genericApiMethod)
  const visiblePrompts = createMemo(() =>
    (selectedMethod().prompts ?? []).filter((prompt) => shouldShowProviderAuthPrompt(prompt, promptValues())),
  )
  const canSubmit = createMemo(() => {
    if (!activeProviderId()) return false
    if (stage() === "authorizing" || stage() === "waiting" || stage() === "success") return false
    if (selectedMethod().type === "api") return apiKey().trim().length > 0
    return visiblePrompts().every((prompt) => (promptValues()[prompt.key] ?? "").trim().length > 0)
  })

  createEffect(() => {
    if (!props.open) return
    const authClient = client()
    if (!authClient) return
    void loadProviderData(authClient)
  })

  async function loadProviderData(authClient: OpencodeClient): Promise<void> {
    setLoading(true)
    setLoadError(null)
    try {
      const [providerListResponse, authResponse, configResponse] = await Promise.all([
        (authClient as any).provider.list(),
        (authClient as any).provider.auth(),
        (authClient as any).config.get(),
      ])
      const nextConfigData = (configResponse?.data ?? {}) as Record<string, any>
      const nextConfiguredIds = new Set(Object.keys((nextConfigData.provider ?? {}) as Record<string, unknown>))
      const listed = ((providerListResponse?.data?.all ?? []) as any[]).map((provider) => ({
        id: String(provider.id ?? ""),
        name: String(provider.name ?? provider.id ?? ""),
        modelCount: modelCountFromProvider(provider),
        source:
          provider?.source === "env" || provider?.source === "config" || provider?.source === "custom" || provider?.source === "api"
            ? provider.source
            : "unknown",
      })).filter((provider) => provider.id.length > 0)
      setAvailableProviders(listed)
      setConnectedProviderIds(new Set((providerListResponse?.data?.connected ?? []) as string[]))
      setConfiguredProviderIds(nextConfiguredIds)
      setConfigData(nextConfigData)
      setMethodsByProvider((authResponse?.data ?? {}) as Record<string, ProviderAuthMethod[]>)
      setSelectedProviderId((current) => current ?? listed[0]?.id ?? Object.keys(authResponse?.data ?? {})[0] ?? null)
    } catch (error) {
      setLoadError(extractProviderAuthErrorMessage(error, t("settings.providers.errors.loadFailed")))
    } finally {
      setLoading(false)
    }
  }

  function resetFlow(nextProviderId: string | null = null) {
    callbackAbortController?.abort()
    callbackAbortController = null
    setActiveProviderId(nextProviderId)
    setSelectedMethodIndex(0)
    setApiKey("")
    setPromptValues({})
    setAuthorization(null)
    setCode("")
    setStage(nextProviderId ? "prompts" : "idle")
    setActionError(null)
  }

  function updatePromptValue(key: string, value: string) {
    setPromptValues((current) => ({ ...current, [key]: value }))
  }

  async function refreshAfterAuth(authClient: OpencodeClient) {
    await (authClient as any).global.dispose().catch(() => undefined)
    await fetchProviders(props.instanceId).catch(() => undefined)
    await loadProviderData(authClient).catch(() => undefined)
  }

  async function submitApiAuth(providerId: string, authClient: OpencodeClient) {
    await requestData(
      (authClient as any).auth.set({ providerID: providerId, auth: { type: "api", key: apiKey().trim() } }),
      "auth.set",
    )
    await refreshAfterAuth(authClient)
    resetFlow(null)
  }

  async function submitOAuthAuthorize(providerId: string, authClient: OpencodeClient) {
    const inputs = visiblePrompts().length > 0
      ? Object.fromEntries(visiblePrompts().map((prompt) => [prompt.key, promptValues()[prompt.key] ?? ""]))
      : undefined
    const response = await (authClient as any).provider.oauth.authorize(
      { providerID: providerId, method: selectedMethodIndex(), ...(inputs ? { inputs } : {}) },
      { throwOnError: true },
    )
    const data = response?.data as ProviderAuthAuthorization | undefined
    if (!data) throw new Error(t("settings.providers.errors.noAuthorization"))
    setAuthorization(data)
    await openExternalUrl(data.url, "provider-auth")
    if (data.method === "code") {
      setStage("code")
      return
    }
    setStage("waiting")
    callbackAbortController = new AbortController()
    await requestData(
      (authClient as any).provider.oauth.callback(
        { providerID: providerId, method: selectedMethodIndex() },
        { signal: callbackAbortController.signal },
      ),
      "provider.oauth.callback",
    )
    callbackAbortController = null
    await refreshAfterAuth(authClient)
    resetFlow(null)
  }

  async function submitAuth() {
    const providerId = activeProviderId()
    const authClient = client()
    if (!providerId || !authClient || !canSubmit()) return
    setStage("authorizing")
    setActionError(null)
    try {
      if (selectedMethod().type === "api") {
        await submitApiAuth(providerId, authClient)
        return
      }
      await submitOAuthAuthorize(providerId, authClient)
    } catch (error) {
      if (isAbortError(error)) {
        setStage("prompts")
        return
      }
      setActionError(extractProviderAuthErrorMessage(error, t("settings.providers.errors.authorizationFailed")))
      setStage("error")
    }
  }

  async function submitOAuthCode() {
    const providerId = activeProviderId()
    const authClient = client()
    if (!providerId || !authClient || !code().trim()) return
    setStage("authorizing")
    setActionError(null)
    try {
      await requestData(
        (authClient as any).provider.oauth.callback({ providerID: providerId, method: selectedMethodIndex(), code: code().trim() }),
        "provider.oauth.callback",
      )
      await refreshAfterAuth(authClient)
      resetFlow(null)
    } catch (error) {
      setActionError(extractProviderAuthErrorMessage(error, t("settings.providers.errors.authorizationFailed")))
      setStage("code")
    }
  }

  async function disconnectProvider(providerId: string) {
    const authClient = client()
    const provider = availableProviders().find((item) => item.id === providerId)
    if (!authClient || !provider) return
    setActionError(null)
    setStage("authorizing")
    try {
      const disconnectMode = getDisconnectMode(provider)
      if (disconnectMode === "not-disconnectable") {
        setActionError(t("settings.providers.errors.envDisconnectUnavailable"))
        setStage("error")
        return
      }

      if (disconnectMode === "disable-in-config") {
        const disabledProviders = Array.isArray(configData().disabled_providers)
          ? [...configData().disabled_providers]
          : []
        if (!disabledProviders.includes(providerId)) {
          disabledProviders.push(providerId)
        }
        await requestData(
          (authClient as any).config.update({
            ...configData(),
            disabled_providers: disabledProviders,
          }),
          "config.update",
        )
      } else {
        await requestData((authClient as any).auth.remove({ providerID: providerId }), "auth.remove")
      }
      await refreshAfterAuth(authClient)
      resetFlow(null)
    } catch (error) {
      setActionError(extractProviderAuthErrorMessage(error, t("settings.providers.errors.removeFailed")))
      setStage("error")
    }
  }

  function cancelOAuthWait() {
    callbackAbortController?.abort()
    callbackAbortController = null
    setStage("prompts")
    setAuthorization(null)
    setActionError(null)
  }

  function methodSummary(providerId: string) {
    const methods = methodsByProvider()[providerId]
    if (!methods || methods.length === 0) return t("settings.providers.method.fallback")
    const kinds = new Set(methods.map((method) => method.type))
    if (kinds.size > 1) return t("settings.providers.method.mixed")
    if (kinds.has("oauth")) return t("settings.providers.method.oauth")
    return t("settings.providers.method.api")
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => {
      if (!open) resetFlow(null)
      props.onOpenChange(open)
    }}>
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay" />
        <Dialog.Content class="modal-surface providers-manager-modal">
          <div class="providers-manager-header">
            <div class="settings-card-heading-with-icon">
              <PlugZap class="settings-card-heading-icon" />
              <div>
                <Dialog.Title class="providers-manager-title">{t("settings.providers.title")}</Dialog.Title>
                <p class="settings-card-subtitle">{t("settings.providers.subtitle")}</p>
              </div>
            </div>
            <button type="button" class="selector-button selector-button-secondary settings-screen-close" onClick={() => props.onOpenChange(false)} aria-label={t("settings.close")}>
              <X class="w-4 h-4" />
            </button>
          </div>

          <div class="providers-manager-body">
            <Show when={!client()}>
              <div class="settings-card-message">{t("settings.providers.empty.noInstance")}</div>
            </Show>

            <Show when={client()}>
              <div class="providers-connect-bar">
                <Select<ConfigurableProviderOption>
                  value={selectedProviderOption()}
                  onChange={(option) => option && setSelectedProviderId(option.id)}
                  options={configurableProviders()}
                  optionValue="id"
                  optionTextValue="name"
                  itemComponent={(itemProps) => (
                    <Select.Item item={itemProps.item} class="selector-option selector-option--multiline">
                      <div class="selector-option-content">
                        <Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.name}</Select.ItemLabel>
                        <div class="selector-option-description">
                          <span dir="ltr">{itemProps.item.rawValue.id}</span>
                          <span> • </span>
                          <span>
                            {itemProps.item.rawValue.modelCount === 1
                              ? t("settings.providers.models.one", { count: itemProps.item.rawValue.modelCount })
                              : t("settings.providers.models.other", { count: itemProps.item.rawValue.modelCount })}
                          </span>
                          <span> • </span>
                          <span>{itemProps.item.rawValue.connectionSummary}</span>
                        </div>
                      </div>
                    </Select.Item>
                  )}
                >
                  <Select.Trigger class="selector-trigger providers-connect-select" aria-label={t("settings.providers.selectProvider") }>
                    <div class="flex-1 min-w-0">
                      <Select.Value<ConfigurableProviderOption>>
                        {(state) => (
                          <div class="selector-trigger-label selector-trigger-label--stacked flex-1 min-w-0">
                            <span class="selector-trigger-primary selector-trigger-primary--align-left">{state.selectedOption()?.name ?? t("settings.providers.selectProvider")}</span>
                            <Show when={state.selectedOption()}>
                              <span class="selector-trigger-secondary" dir="ltr">
                                {state.selectedOption()?.id} • {state.selectedOption()?.connectionSummary}
                              </span>
                            </Show>
                          </div>
                        )}
                      </Select.Value>
                    </div>
                    <Select.Icon class="selector-trigger-icon"><ChevronDown class="w-3 h-3" /></Select.Icon>
                  </Select.Trigger>
                  <Select.Portal><Select.Content class="selector-popover"><Select.Listbox class="selector-listbox" /></Select.Content></Select.Portal>
                </Select>
                <button type="button" class="selector-button selector-button-primary" disabled={!selectedProviderOption()} onClick={() => resetFlow(selectedProviderOption()?.id ?? null)}>
                  {t("settings.providers.actions.connect")}
                </button>
                <button type="button" class="settings-pill-button" disabled={loading()} onClick={() => client() && void loadProviderData(client()!)}>
                  <RefreshCw class={loading() ? "providers-spin-icon" : "providers-button-icon"} />
                  {t("settings.providers.refresh")}
                </button>
              </div>

              <Show when={loadError()}>
                <div class="settings-error-message">{loadError()}</div>
              </Show>

              <Show when={activeProviderId()}>
                <section class="providers-connect-panel">
                  <div class="providers-panel-header">
                    <div>
                      <h3 class="settings-card-title">{t("settings.providers.auth.title", { provider: activeProviderName() })}</h3>
                      <p class="settings-card-subtitle">{t("settings.providers.auth.subtitle")}</p>
                    </div>
                    <button
                      type="button"
                      class="selector-button selector-button-secondary settings-screen-close"
                      onClick={() => resetFlow(null)}
                      aria-label={t("settings.providers.actions.close")}
                      title={t("settings.providers.actions.close")}
                    >
                      <X class="w-4 h-4" />
                    </button>
                  </div>

                  <Show when={methodOptions().length > 1}>
                    <div class="settings-toggle-row settings-toggle-row-compact providers-method-row">
                      <div><div class="settings-toggle-title">{t("settings.providers.method.title")}</div><div class="settings-toggle-caption">{t("settings.providers.method.subtitle")}</div></div>
                      <Select<MethodOption>
                        value={selectedMethodOption()}
                        onChange={(option) => {
                          if (!option) return
                          setSelectedMethodIndex(option.index)
                          setPromptValues({})
                          setApiKey("")
                          setAuthorization(null)
                          setCode("")
                          setStage("prompts")
                          setActionError(null)
                        }}
                        options={methodOptions()}
                        optionValue="value"
                        optionTextValue="label"
                        itemComponent={(itemProps) => <Select.Item item={itemProps.item} class="selector-option"><Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.label}</Select.ItemLabel></Select.Item>}
                      >
                        <Select.Trigger class="selector-trigger providers-method-trigger" aria-label={t("settings.providers.method.title")}>
                          <div class="flex-1 min-w-0"><Select.Value<MethodOption>>{(state) => <span class="selector-trigger-primary selector-trigger-primary--align-left">{state.selectedOption()?.label}</span>}</Select.Value></div>
                          <Select.Icon class="selector-trigger-icon"><ChevronDown class="w-3 h-3" /></Select.Icon>
                        </Select.Trigger>
                        <Select.Portal><Select.Content class="selector-popover"><Select.Listbox class="selector-listbox" /></Select.Content></Select.Portal>
                      </Select>
                    </div>
                  </Show>

                  <Show when={selectedMethod().type === "api"}>
                    <div class="providers-form-stack"><label class="providers-field"><span class="settings-form-label">{t("settings.providers.apiKey.label")}</span><div class="providers-input-wrap"><KeyRound class="providers-input-icon" /><input type="password" class="providers-input" value={apiKey()} onInput={(event) => setApiKey(event.currentTarget.value)} placeholder={t("settings.providers.apiKey.placeholder")} autocomplete="off" /></div></label></div>
                  </Show>

                  <Show when={selectedMethod().type === "oauth" && (stage() === "prompts" || stage() === "error" || stage() === "authorizing")}>
                    <div class="providers-form-stack">
                      <Show when={visiblePrompts().length === 0}><div class="settings-card-message">{t("settings.providers.oauth.noPrompts")}</div></Show>
                      <For each={visiblePrompts()}>{(prompt) => (
                        <div class="providers-field">
                          <label class="settings-form-label" for={`provider-prompt-${prompt.key}`}>{prompt.message}</label>
                          <Show when={prompt.type === "select"} fallback={<input id={`provider-prompt-${prompt.key}`} type="text" class="providers-input" value={promptValues()[prompt.key] ?? ""} onInput={(event) => updatePromptValue(prompt.key, event.currentTarget.value)} placeholder={prompt.type === "text" ? prompt.placeholder : undefined} />}>
                            <Select<{ label: string; value: string; hint?: string }> value={(prompt.type === "select" ? prompt.options : []).find((option) => option.value === promptValues()[prompt.key])} onChange={(option) => option && updatePromptValue(prompt.key, option.value)} options={prompt.type === "select" ? prompt.options : []} optionValue="value" optionTextValue="label" itemComponent={(itemProps) => <Select.Item item={itemProps.item} class="selector-option"><Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.label}<Show when={itemProps.item.rawValue.hint}><span class="providers-select-hint">{itemProps.item.rawValue.hint}</span></Show></Select.ItemLabel></Select.Item>}>
                              <Select.Trigger class="selector-trigger providers-prompt-trigger" aria-label={prompt.message}><div class="flex-1 min-w-0"><Select.Value<{ label: string; value: string; hint?: string }>>{(state) => <span class="selector-trigger-primary selector-trigger-primary--align-left">{state.selectedOption()?.label ?? t("settings.providers.prompt.selectPlaceholder")}</span>}</Select.Value></div><Select.Icon class="selector-trigger-icon"><ChevronDown class="w-3 h-3" /></Select.Icon></Select.Trigger>
                              <Select.Portal><Select.Content class="selector-popover"><Select.Listbox class="selector-listbox" /></Select.Content></Select.Portal>
                            </Select>
                          </Show>
                        </div>
                      )}</For>
                    </div>
                  </Show>

                  <Show when={stage() === "code"}><div class="providers-form-stack"><div class="providers-oauth-instructions"><ExternalLink class="providers-instructions-icon" /><span>{authorization()?.instructions || t("settings.providers.oauth.enterCode")}</span></div><label class="providers-field"><span class="settings-form-label">{t("settings.providers.oauth.codeLabel")}</span><input type="text" class="providers-input" value={code()} onInput={(event) => setCode(event.currentTarget.value)} placeholder={t("settings.providers.oauth.codePlaceholder")} autocomplete="one-time-code" /></label></div></Show>
                  <Show when={stage() === "waiting"}><div class="providers-waiting-card"><Loader2 class="providers-spin-icon" /><div><div class="settings-toggle-title">{t("settings.providers.oauth.waitingTitle")}</div><div class="settings-toggle-caption">{authorization()?.instructions}</div></div><button type="button" class="selector-button selector-button-secondary providers-wait-cancel" onClick={cancelOAuthWait}>{t("settings.providers.oauth.cancelWait")}</button></div></Show>
                  <Show when={stage() === "success"}><div class="providers-success-card"><Check class="providers-success-icon" /><span>{t("settings.providers.success")}</span></div></Show>
                  <Show when={actionError()}><div class="settings-error-message">{actionError()}</div></Show>

                  <div class="providers-actions-row">
                    <Show when={stage() === "code"} fallback={<button type="button" class="selector-button selector-button-primary" disabled={!canSubmit()} onClick={() => void submitAuth()}><Show when={stage() === "authorizing"} fallback={t("settings.providers.actions.continue")}><Loader2 class="providers-spin-icon" />{t("settings.providers.actions.working")}</Show></button>}>
                      <button type="button" class="selector-button selector-button-primary" disabled={!code().trim()} onClick={() => void submitOAuthCode()}>{t("settings.providers.oauth.submitCode")}</button>
                    </Show>
                  </div>
                </section>
              </Show>

              <section class="providers-list-section">
                <h3 class="settings-card-title">{t("settings.providers.configured.title")}</h3>
                <Show when={loading()}><div class="providers-loading-row"><Loader2 class="providers-spin-icon" /><span>{t("settings.providers.loading")}</span></div></Show>
                <Show when={!loading() && configuredProviders().length === 0}><div class="settings-card-message">{t("settings.providers.empty.noConfiguredProviders")}</div></Show>
                <div class="providers-grid">
                  <For each={configuredProviders()}>{(provider) => (
                    <article class="providers-card">
                      <div class="providers-card-main"><div class="providers-card-mark"><ShieldCheck class="providers-card-mark-icon" /></div><div class="providers-card-copy"><div class="providers-card-title-row"><h4 class="providers-card-title">{provider.name || provider.id}</h4></div><p class="providers-card-meta">{provider.id}</p><p class="providers-card-methods">{methodSummary(provider.id)}</p><p class="providers-card-source">{describeProviderSource(provider)}</p></div></div>
                      <div class="providers-card-footer"><span class="providers-model-count">{provider.modelCount === 1 ? t("settings.providers.models.one", { count: provider.modelCount }) : t("settings.providers.models.other", { count: provider.modelCount })}</span><Show when={getDisconnectMode(provider) !== "disable-in-config"}><button type="button" class="selector-button selector-button-secondary providers-disconnect-button" disabled={getDisconnectMode(provider) === "not-disconnectable"} onClick={() => void disconnectProvider(provider.id)} title={getDisconnectMode(provider) === "not-disconnectable" ? t("settings.providers.source.env") : t("settings.providers.actions.disconnect")}>{t("settings.providers.actions.disconnect")}</button></Show></div>
                    </article>
                  )}</For>
                </div>
              </section>
            </Show>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}
