import { Dialog } from "@kobalte/core/dialog"
import { Select } from "@kobalte/core/select"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Component } from "solid-js"
import { Check, ChevronDown, ExternalLink, KeyRound, Loader2, PlugZap, RefreshCw, ShieldCheck, X } from "lucide-solid"
import type { FormAnswer, FormValue, IntegrationMethod, ModelInfo, OpenCodeClient, ProviderInfo } from "@opencode-ai/client"
import { openExternalUrl } from "../../lib/external-url"
import { useI18n } from "../../lib/i18n"
import { isLocalTauriHost } from "../../lib/runtime-env"
import { isFormFieldVisible, isHttpFormUrl } from "../../lib/form-schema"
import {
  extractProviderAuthErrorMessage,
  genericApiMethod,
  getProviderAuthAnswer,
  getProviderAuthInitialAnswer,
  isProviderAuthFieldComplete,
  isAbortError,
  type ProviderAuthAuthorization,
} from "../../lib/provider-auth"
import { instances } from "../../stores/instances"
import { fetchProviders, getActiveCatalogLocation } from "../../stores/sessions"
import { ProviderAuthForm } from "./provider-auth-form"
import { buildListedProviders, buildProviderVisibilityModels, type ListedProvider as ProviderOption } from "./provider-options"
import {
  ProviderModelVisibilityManager,
  type ProviderVisibilityModel,
} from "./provider-model-visibility-manager"

type AuthStage = "idle" | "prompts" | "authorizing" | "code" | "waiting" | "success" | "error"

type MethodOption = {
  value: string
  label: string
  method: NativeAuthMethod
  index: number
}

type ConfigurableProviderOption = {
  id: string
  name: string
  modelCount: number
  connectionSummary: string
  canConnect: boolean
}

type DisconnectMode = "credential-remove" | "not-disconnectable" | "unknown"
type NativeAuthMethod = Exclude<IntegrationMethod, { type: "env" }>
type NativeAuthorization = ProviderAuthAuthorization & { attemptID: string }
type ListedProvider = ProviderOption & {
  models: ProviderVisibilityModel[]
}

interface ProviderManagerModalProps {
  instanceId: string
  open?: boolean
  embedded?: boolean
  onOpenChange?: (open: boolean) => void
}

export const ProviderManagerModal: Component<ProviderManagerModalProps> = (props) => {
  const { t } = useI18n()
  const [methodsByProvider, setMethodsByProvider] = createSignal<Record<string, NativeAuthMethod[]>>({})
  const [availableProviders, setAvailableProviders] = createSignal<ListedProvider[]>([])
  const [selectedProviderId, setSelectedProviderId] = createSignal<string | null>(null)
  const [activeProviderId, setActiveProviderId] = createSignal<string | null>(null)
  const [managedProviderId, setManagedProviderId] = createSignal<string | null>(null)
  const manageModelButtons = new Map<string, HTMLButtonElement>()
  let managedProviderTriggerId: string | null = null
  const [selectedMethodIndex, setSelectedMethodIndex] = createSignal(0)
  const [apiKey, setApiKey] = createSignal("")
  const [formAnswer, setFormAnswer] = createSignal<FormAnswer>({})
  const [authorization, setAuthorization] = createSignal<NativeAuthorization | null>(null)
  const [commandAttemptId, setCommandAttemptId] = createSignal<string | null>(null)
  const [commandStatusMessage, setCommandStatusMessage] = createSignal<string | null>(null)
  const [code, setCode] = createSignal("")
  const [stage, setStage] = createSignal<AuthStage>("idle")
  const [loading, setLoading] = createSignal(false)
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [actionError, setActionError] = createSignal<string | null>(null)
  const [authorizationLaunchBlocked, setAuthorizationLaunchBlocked] = createSignal(false)
  const [authorizationLinkCopied, setAuthorizationLinkCopied] = createSignal(false)
  let callbackAbortController: AbortController | null = null
  let pendingOauthPopup: Window | null = null
  let loadVersion = 0
  let authOperationVersion = 0
  let oauthCodeInput: HTMLInputElement | undefined

  const instance = createMemo(() => instances().get(props.instanceId) ?? null)
  const client = createMemo<OpenCodeClient | null>(() => {
    const current = instance()
    return current?.status === "ready" ? current.client ?? null : null
  })

  const providerNameById = createMemo(() => {
    const names = new Map<string, string>()
    for (const provider of availableProviders()) {
      names.set(provider.id, provider.name || provider.id)
    }
    return names
  })

  const configurableProviders = createMemo<ConfigurableProviderOption[]>(() => {
    return availableProviders()
      .sort((left, right) => left.id.localeCompare(right.id, undefined, { sensitivity: "base" }))
      .map((listed) => {
        return {
          id: listed.id,
          name: providerNameById().get(listed.id) ?? listed.id,
          modelCount: listed.modelCount,
          connectionSummary: methodSummary(listed.id),
          canConnect: listed.canConnect,
        }
      })
  })

  const configuredProviders = createMemo(() =>
    availableProviders().filter((provider) => provider.source !== "unknown"),
  )

  const managedProvider = createMemo(() =>
    configuredProviders().find((provider) => provider.id === managedProviderId()) ?? null,
  )

  const getDisconnectMode = (provider: ListedProvider): DisconnectMode => {
    if (provider.source === "env") return "not-disconnectable"
    if (provider.credentialIds.length > 0) return "credential-remove"
    return "unknown"
  }

  const describeProviderSource = (provider: ListedProvider) => {
    const mode = getDisconnectMode(provider)
    if (provider.source === "config") return t("settings.providers.source.config")
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
      label: method.label || (method.type === "oauth"
        ? t("settings.providers.method.oauth")
        : method.type === "command" ? t("settings.providers.method.command") : t("settings.providers.method.api")),
      method,
      index,
    })),
  )

  const selectedMethodOption = createMemo(() => methodOptions().find((option) => option.index === selectedMethodIndex()) ?? methodOptions()[0])
  const selectedMethod = createMemo(() => selectedMethodOption()?.method ?? genericApiMethod)
  const selectedForm = createMemo(() => {
    const method = selectedMethod()
    return method.type === "command" ? undefined : method.form
  })
  const selectedCommand = createMemo(() => {
    const method = selectedMethod()
    return method.type === "command" ? method : undefined
  })
  const canSubmit = createMemo(() => {
    if (!activeProviderId()) return false
    if (stage() === "authorizing" || stage() === "waiting" || stage() === "success") return false
    const method = selectedMethod()
    if (method.type === "key" && apiKey().trim().length === 0) return false
    return (method.type === "command" ? [] : method.form ?? [])
      .filter((field) => isFormFieldVisible(field, formAnswer()))
      .every((field) => isProviderAuthFieldComplete(field, formAnswer()))
  })

  function handleModalOpenChange(open: boolean) {
    if (!open) resetFlow(null)
    props.onOpenChange?.(open)
  }

  function isBrowserHostForOAuth(): boolean {
    return !isLocalTauriHost() && typeof window !== "undefined"
  }

  function prepareOAuthPopupWindow(): Window | null {
    if (!isBrowserHostForOAuth()) {
      return null
    }

    let popup: Window | null = null
    try {
      popup = window.open("", "_blank")
      if (popup && popup.document) {
        popup.opener = null
        popup.document.title = t("settings.providers.oauth.popup.loadingTitle")
        popup.document.body.innerHTML = `<div style=\"font-family: sans-serif; padding: 24px; color: #111;\">${t("settings.providers.oauth.popup.loadingBody")}</div>`
      }
      return popup
    } catch {
      popup?.close()
      return null
    }
  }

  async function launchAuthorizationUrl(url: string, options?: { popup?: Window | null; sameTab?: boolean }): Promise<boolean> {
    if (!isHttpFormUrl(url)) {
      if (options?.popup && !options.popup.closed) options.popup.close()
      return false
    }

    if (options?.sameTab && typeof window !== "undefined") {
      window.location.assign(url)
      return true
    }

    const popup = options?.popup
    if (popup && !popup.closed) {
      try {
        popup.location.href = url
        return true
      } catch {
        // fall through to general opener path
      }
    }

    return await openExternalUrl(url, "provider-auth")
  }

  async function copyAuthorizationUrl(): Promise<void> {
    const url = authorization()?.url
    if (!url || typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      return
    }

    try {
      await navigator.clipboard.writeText(url)
      setAuthorizationLinkCopied(true)
      setTimeout(() => setAuthorizationLinkCopied(false), 1500)
    } catch {
      setAuthorizationLinkCopied(false)
    }
  }

  createEffect(() => {
    const version = ++loadVersion
    resetProviderData()
    if (!props.embedded && !props.open) return
    const authClient = client()
    if (!authClient) return
    void loadProviderData(authClient, version)
  })

  createEffect(() => {
    if (stage() === "code") queueMicrotask(() => oauthCodeInput?.focus())
  })

  onCleanup(() => {
    loadVersion += 1
    disposePendingAuth()
  })

  async function loadProviderData(authClient: OpenCodeClient, version = ++loadVersion): Promise<void> {
    setLoading(true)
    setLoadError(null)
    try {
      const location = { location: getActiveCatalogLocation(props.instanceId) }
      const [providerResponse, modelResponse, integrationResponse] = await Promise.all([
        authClient.provider.list(location),
        authClient.model.list(location),
        authClient.integration.list(location),
      ])
      if (version !== loadVersion) return
      const listed = buildListedProviders(providerResponse.data, modelResponse.data, integrationResponse.data).map((provider) => ({
        ...provider,
        models: buildProviderVisibilityModels(provider.id, providerResponse.data, modelResponse.data),
      }))
      const methods = Object.fromEntries(integrationResponse.data.map((integration) => [
        integration.id,
        integration.methods.filter((method): method is NativeAuthMethod => method.type !== "env"),
      ]))
      setAvailableProviders(listed)
      setMethodsByProvider(methods)
      setSelectedProviderId((current) => current ?? listed[0]?.id ?? integrationResponse.data[0]?.id ?? null)
    } catch (error) {
      if (version !== loadVersion) return
      setLoadError(extractProviderAuthErrorMessage(error, t("settings.providers.errors.loadFailed")))
    } finally {
      if (version === loadVersion) setLoading(false)
    }
  }

  function disposePendingAuth() {
    authOperationVersion += 1
    callbackAbortController?.abort()
    callbackAbortController = null
    if (pendingOauthPopup && !pendingOauthPopup.closed) pendingOauthPopup.close()
    pendingOauthPopup = null
  }

  function resetProviderData() {
    resetFlow(null)
    setMethodsByProvider({})
    setAvailableProviders([])
    setSelectedProviderId(null)
    setManagedProviderId(null)
    setLoadError(null)
    setLoading(false)
  }

  function resetFlow(nextProviderId: string | null = null) {
    if (nextProviderId && !(methodsByProvider()[nextProviderId]?.length)) return
    disposePendingAuth()
    setActiveProviderId(nextProviderId)
    setSelectedMethodIndex(0)
    setApiKey("")
    const firstMethod = nextProviderId ? methodsByProvider()[nextProviderId]?.[0] : undefined
    setFormAnswer(getProviderAuthInitialAnswer(firstMethod?.type === "command" ? undefined : firstMethod?.form))
    setAuthorization(null)
    setCommandAttemptId(null)
    setCommandStatusMessage(null)
    setCode("")
    setStage(nextProviderId ? "prompts" : "idle")
    setActionError(null)
    setAuthorizationLaunchBlocked(false)
    setAuthorizationLinkCopied(false)
  }

  function updateFormAnswer(key: string, value: FormValue | undefined) {
    setFormAnswer((current) => {
      const next = { ...current }
      if (value === undefined) delete next[key]
      else next[key] = value
      return next
    })
  }

  function isCurrentOperation(version: number, instanceId: string, authClient: OpenCodeClient) {
    return version === authOperationVersion && props.instanceId === instanceId && client() === authClient
  }

  async function refreshAfterAuth(authClient: OpenCodeClient, instanceId: string, operationVersion: number) {
    if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
    await fetchProviders(instanceId, getActiveCatalogLocation(instanceId), true).catch(() => undefined)
    if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
    await loadProviderData(authClient).catch(() => undefined)
  }

  async function refreshProviderData() {
    const authClient = client()
    const instanceId = props.instanceId
    if (!authClient) return
    setLoading(true)
    await fetchProviders(instanceId, getActiveCatalogLocation(instanceId), true).catch(() => undefined)
    if (client() !== authClient || props.instanceId !== instanceId) return
    await loadProviderData(authClient)
  }

  function closeModelManager() {
    setManagedProviderId(null)
    queueMicrotask(() => {
      if (managedProviderTriggerId) manageModelButtons.get(managedProviderTriggerId)?.focus()
    })
  }

  async function submitApiAuth(providerId: string, authClient: OpenCodeClient, instanceId: string, operationVersion: number) {
    await authClient.integration.connect.key({
      integrationID: providerId,
      key: apiKey().trim(),
      answer: getProviderAuthAnswer(selectedForm(), formAnswer()),
      location: getActiveCatalogLocation(instanceId),
    })
    if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
    await refreshAfterAuth(authClient, instanceId, operationVersion)
    if (isCurrentOperation(operationVersion, instanceId, authClient)) resetFlow(null)
  }

  async function submitOAuthAuthorize(providerId: string, authClient: OpenCodeClient, instanceId: string, operationVersion: number) {
    const method = selectedMethod()
    if (method.type !== "oauth") throw new Error(t("settings.providers.errors.noAuthorization"))
    const response = await authClient.integration.oauth.connect({
      integrationID: providerId,
      methodID: method.id,
      answer: getProviderAuthAnswer(selectedForm(), formAnswer()),
      location: getActiveCatalogLocation(instanceId),
    })
    if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
    const data = response.data
    if (!data) throw new Error(t("settings.providers.errors.noAuthorization"))
    const nextAuthorization: NativeAuthorization = {
      attemptID: data.attemptID,
      url: data.url,
      instructions: data.instructions,
      method: data.mode,
    }
    setAuthorization(nextAuthorization)
    const opened = await launchAuthorizationUrl(data.url, { popup: pendingOauthPopup })
    if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
    pendingOauthPopup = null
    setAuthorizationLaunchBlocked(!opened)
    if (data.mode === "code") {
      setStage("code")
      return
    }
    setStage("waiting")
    callbackAbortController = new AbortController()
    while (true) {
      const result = await authClient.integration.oauth.status(
        { integrationID: providerId, attemptID: data.attemptID, location: getActiveCatalogLocation(instanceId) },
        { signal: callbackAbortController.signal },
      )
      if (result.data.status === "complete") break
      if (result.data.status === "failed") throw new Error(result.data.message)
      if (result.data.status === "expired") throw new Error(t("settings.providers.errors.authorizationFailed"))
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
    callbackAbortController = null
    await refreshAfterAuth(authClient, instanceId, operationVersion)
    if (isCurrentOperation(operationVersion, instanceId, authClient)) resetFlow(null)
  }

  async function submitCommandAuth(providerId: string, authClient: OpenCodeClient, instanceId: string, operationVersion: number) {
    const method = selectedMethod()
    if (method.type !== "command") throw new Error(t("settings.providers.errors.noAuthorization"))
    const response = await authClient.integration.command.connect({
      integrationID: providerId,
      methodID: method.id,
      location: getActiveCatalogLocation(instanceId),
    })
    if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
    const attemptID = response.data.attemptID
    setCommandAttemptId(attemptID)
    setCommandStatusMessage(null)
    setStage("waiting")
    callbackAbortController = new AbortController()
    while (true) {
      const result = await authClient.integration.command.status(
        { integrationID: providerId, attemptID, location: getActiveCatalogLocation(instanceId) },
        { signal: callbackAbortController.signal },
      )
      if (result.data.status === "complete") break
      if (result.data.status === "failed") throw new Error(result.data.message)
      if (result.data.status === "expired") throw new Error(t("settings.providers.errors.authorizationFailed"))
      setCommandStatusMessage(result.data.message ?? null)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
    callbackAbortController = null
    await refreshAfterAuth(authClient, instanceId, operationVersion)
    if (isCurrentOperation(operationVersion, instanceId, authClient)) resetFlow(null)
  }

  async function submitAuth() {
    const providerId = activeProviderId()
    const authClient = client()
    if (!providerId || !authClient || !canSubmit()) return
    const instanceId = props.instanceId
    const operationVersion = ++authOperationVersion
    setStage("authorizing")
    setActionError(null)
    try {
      if (selectedMethod().type === "key") {
        await submitApiAuth(providerId, authClient, instanceId, operationVersion)
        return
      }
      if (selectedMethod().type === "command") {
        await submitCommandAuth(providerId, authClient, instanceId, operationVersion)
        return
      }
      pendingOauthPopup = prepareOAuthPopupWindow()
      setAuthorizationLaunchBlocked(isBrowserHostForOAuth() && pendingOauthPopup === null)
      await submitOAuthAuthorize(providerId, authClient, instanceId, operationVersion)
    } catch (error) {
      if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
      if (pendingOauthPopup && !pendingOauthPopup.closed) {
        pendingOauthPopup.close()
      }
      pendingOauthPopup = null
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
    const instanceId = props.instanceId
    const operationVersion = ++authOperationVersion
    setStage("authorizing")
    setActionError(null)
    try {
      const attemptID = authorization()?.attemptID
      if (!attemptID) throw new Error(t("settings.providers.errors.noAuthorization"))
      await authClient.integration.oauth.complete({
        integrationID: providerId,
        attemptID,
        code: code().trim(),
        location: getActiveCatalogLocation(instanceId),
      })
      if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
      await refreshAfterAuth(authClient, instanceId, operationVersion)
      if (isCurrentOperation(operationVersion, instanceId, authClient)) resetFlow(null)
    } catch (error) {
      if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
      setActionError(extractProviderAuthErrorMessage(error, t("settings.providers.errors.authorizationFailed")))
      setStage("code")
    }
  }

  async function disconnectProvider(providerId: string) {
    const authClient = client()
    const provider = availableProviders().find((item) => item.id === providerId)
    if (!authClient || !provider) return
    const instanceId = props.instanceId
    disposePendingAuth()
    const operationVersion = ++authOperationVersion
    setActionError(null)
    setStage("authorizing")
    try {
      const disconnectMode = getDisconnectMode(provider)
      if (disconnectMode === "not-disconnectable") {
        setActionError(t("settings.providers.errors.envDisconnectUnavailable"))
        setStage("error")
        return
      }
      if (disconnectMode !== "credential-remove") return
      await Promise.all(provider.credentialIds.map((credentialID) => authClient.credential.remove({
        credentialID,
        location: getActiveCatalogLocation(instanceId),
      })))
      if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
      await refreshAfterAuth(authClient, instanceId, operationVersion)
      if (isCurrentOperation(operationVersion, instanceId, authClient)) resetFlow(null)
    } catch (error) {
      if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
      setActionError(extractProviderAuthErrorMessage(error, t("settings.providers.errors.removeFailed")))
      setStage("idle")
    }
  }

  function cancelOAuthWait() {
    const providerId = activeProviderId()
    const attemptID = authorization()?.attemptID
    const commandAttemptID = commandAttemptId()
    const authClient = client()
    const instanceId = props.instanceId
    if (providerId && attemptID && authClient) {
      void authClient.integration.oauth.cancel({
        integrationID: providerId,
        attemptID,
        location: getActiveCatalogLocation(instanceId),
      }).catch(() => undefined)
    }
    if (providerId && commandAttemptID && authClient) {
      void authClient.integration.command.cancel({
        integrationID: providerId,
        attemptID: commandAttemptID,
        location: getActiveCatalogLocation(instanceId),
      }).catch(() => undefined)
    }
    disposePendingAuth()
    setStage("prompts")
    setAuthorization(null)
    setCommandAttemptId(null)
    setCommandStatusMessage(null)
    setActionError(null)
  }

  function methodSummary(providerId: string) {
    const methods = methodsByProvider()[providerId]
    if (!methods || methods.length === 0) {
      const source = availableProviders().find((provider) => provider.id === providerId)?.source ?? "unknown"
      return t(`settings.providers.source.${source}`)
    }
    const kinds = new Set(methods.map((method) => method.type))
    if (kinds.size > 1) return t("settings.providers.method.mixed")
    if (kinds.has("oauth")) return t("settings.providers.method.oauth")
    if (kinds.has("command")) return t("settings.providers.method.command")
    return t("settings.providers.method.api")
  }

  const content = () => (
    <>
          <div class="providers-manager-header">
            <div class="settings-card-heading-with-icon">
              <PlugZap class="settings-card-heading-icon" />
              <div>
                <Show
                  when={!props.embedded}
                  fallback={<h2 class="providers-manager-title">{t("settings.providers.title")}</h2>}
                >
                  <Dialog.Title class="providers-manager-title">{t("settings.providers.title")}</Dialog.Title>
                </Show>
                <p class="settings-card-subtitle">{t("settings.providers.subtitle")}</p>
              </div>
            </div>
            <Show when={!props.embedded}>
              <button type="button" class="selector-button selector-button-secondary settings-screen-close" onClick={() => handleModalOpenChange(false)} aria-label={t("settings.close")}>
                <X class="w-4 h-4" />
              </button>
            </Show>
          </div>

          <div class="providers-manager-body">
            <Show when={!client()}>
              <div class="settings-card-message" role="status">{t("settings.providers.empty.noInstance")}</div>
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
                <button type="button" class="selector-button selector-button-primary" disabled={!selectedProviderOption()?.canConnect} onClick={() => resetFlow(selectedProviderOption()?.id ?? null)}>
                  {t("settings.providers.actions.connect")}
                </button>
                <button type="button" class="settings-pill-button" disabled={loading()} onClick={() => void refreshProviderData()}>
                  <RefreshCw class={loading() ? "providers-spin-icon" : "providers-button-icon"} />
                  {t("settings.providers.refresh")}
                </button>
              </div>

              <Show when={loadError()}>
                <div class="settings-error-message" role="alert">{loadError()}</div>
              </Show>
              <Show when={actionError()}>
                <div class="settings-error-message" role="alert">{actionError()}</div>
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
                          setFormAnswer(getProviderAuthInitialAnswer(option.method.type === "command" ? undefined : option.method.form))
                          setApiKey("")
                          setAuthorization(null)
                          setCode("")
                          setStage("prompts")
                          setActionError(null)
                        }}
                        options={methodOptions()}
                        optionValue="value"
                        optionTextValue="label"
                        disabled={stage() !== "prompts" && stage() !== "error"}
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

                  <Show when={selectedMethod().type === "key"}>
                    <div class="providers-form-stack"><label class="providers-field"><span class="settings-form-label">{t("settings.providers.apiKey.label")}</span><div class="providers-input-wrap"><KeyRound class="providers-input-icon" /><input type="password" class="providers-input" value={apiKey()} onInput={(event) => setApiKey(event.currentTarget.value)} placeholder={t("settings.providers.apiKey.placeholder")} autocomplete="off" /></div></label></div>
                  </Show>

                  <Show when={selectedForm()}>
                    <ProviderAuthForm fields={selectedForm()} answer={formAnswer()} disabled={stage() !== "prompts" && stage() !== "error"} onAnswer={updateFormAnswer} />
                  </Show>

                  <Show when={selectedMethod().type === "oauth" && !selectedForm() && (stage() === "prompts" || stage() === "error" || stage() === "authorizing")}>
                    <div class="settings-card-message" role="status">{t("settings.providers.oauth.noPrompts")}</div>
                  </Show>

                  <Show when={selectedMethod().type === "command" && (stage() === "prompts" || stage() === "error" || stage() === "authorizing")}>
                    <div class="providers-form-stack">
                      <div class="settings-card-message" role="status">{t("settings.providers.command.description")}</div>
                      <div class="providers-command-preview" dir="ltr">{selectedCommand()?.command.join(" ")}</div>
                    </div>
                  </Show>

                  <Show when={stage() === "code"}><div class="providers-form-stack"><div class="providers-oauth-instructions"><ExternalLink class="providers-instructions-icon" /><span>{authorization()?.instructions || t("settings.providers.oauth.enterCode")}</span></div><label class="providers-field"><span class="settings-form-label">{t("settings.providers.oauth.codeLabel")}</span><input ref={(element) => { oauthCodeInput = element }} type="text" class="providers-input" value={code()} onInput={(event) => setCode(event.currentTarget.value)} placeholder={t("settings.providers.oauth.codePlaceholder")} autocomplete="one-time-code" /></label></div></Show>
                  <Show when={stage() === "waiting"}><div class="providers-waiting-card" role="status"><Loader2 class="providers-spin-icon" /><div><div class="settings-toggle-title">{selectedMethod().type === "command" ? t("settings.providers.command.waitingTitle") : t("settings.providers.oauth.waitingTitle")}</div><div class="settings-toggle-caption">{selectedMethod().type === "command" ? commandStatusMessage() ?? t("settings.providers.command.waitingMessage") : authorization()?.instructions}</div></div><button type="button" class="selector-button selector-button-secondary providers-wait-cancel" onClick={cancelOAuthWait}>{t("settings.providers.oauth.cancelWait")}</button></div></Show>
                  <Show when={authorization() && isHttpFormUrl(authorization()!.url) && (stage() === "code" || stage() === "waiting")}>
                    <div class="providers-oauth-actions">
                      <a href={authorization()?.url} target="_blank" rel="noopener noreferrer" class="selector-button selector-button-secondary providers-oauth-link">
                        <ExternalLink class="w-4 h-4" />
                        {t("settings.providers.oauth.openPage")}
                      </a>
                      <button type="button" class="selector-button selector-button-secondary" onClick={() => void launchAuthorizationUrl(authorization()!.url, { sameTab: true })}>
                        {t("settings.providers.oauth.openHere")}
                      </button>
                      <button type="button" class="selector-button selector-button-secondary" onClick={() => void copyAuthorizationUrl()}>
                        {authorizationLinkCopied() ? t("settings.providers.oauth.linkCopied") : t("settings.providers.oauth.copyLink")}
                      </button>
                    </div>
                  </Show>
                  <Show when={authorizationLaunchBlocked() && authorization()}>
                    <div class="settings-card-message" role="alert">{t("settings.providers.oauth.popupBlocked")}</div>
                  </Show>
                  <Show when={stage() === "success"}><div class="providers-success-card" role="status"><Check class="providers-success-icon" /><span>{t("settings.providers.success")}</span></div></Show>

                  <div class="providers-actions-row">
                    <Show when={stage() === "code"} fallback={<button type="button" class="selector-button selector-button-primary" disabled={!canSubmit()} onClick={() => void submitAuth()}><Show when={stage() === "authorizing"} fallback={t("settings.providers.actions.continue")}><Loader2 class="providers-spin-icon" />{t("settings.providers.actions.working")}</Show></button>}>
                      <button type="button" class="selector-button selector-button-primary" disabled={!code().trim()} onClick={() => void submitOAuthCode()}>{t("settings.providers.oauth.submitCode")}</button>
                    </Show>
                  </div>
                </section>
              </Show>

              <section class="providers-list-section">
                <h3 class="settings-card-title">{t("settings.providers.configured.title")}</h3>
                <Show when={managedProvider()} fallback={
                  <>
                    <Show when={loading()}><div class="providers-loading-row" role="status"><Loader2 class="providers-spin-icon" /><span>{t("settings.providers.loading")}</span></div></Show>
                    <Show when={!loading() && configuredProviders().length === 0}><div class="settings-card-message" role="status">{t("settings.providers.empty.noConfiguredProviders")}</div></Show>
                    <div class="providers-grid">
                      <For each={configuredProviders()}>{(provider) => (
                        <article class="providers-card">
                          <div class="providers-card-main"><div class="providers-card-mark"><ShieldCheck class="providers-card-mark-icon" /></div><div class="providers-card-copy"><div class="providers-card-title-row"><h4 class="providers-card-title">{provider.name || provider.id}</h4></div><p class="providers-card-meta">{provider.id}</p><p class="providers-card-methods">{methodSummary(provider.id)}</p><p class="providers-card-source">{describeProviderSource(provider)}</p></div></div>
                          <div class="providers-card-footer">
                            <span class="providers-model-count">{provider.modelCount === 1 ? t("settings.providers.models.one", { count: provider.modelCount }) : t("settings.providers.models.other", { count: provider.modelCount })}</span>
                            <div class="provider-model-card-actions">
                              <button
                                ref={(element) => manageModelButtons.set(provider.id, element)}
                                type="button"
                                class="selector-button selector-button-secondary"
                                onClick={() => {
                                  managedProviderTriggerId = provider.id
                                  setManagedProviderId(provider.id)
                                }}
                              >{t("settings.providers.actions.manageModels")}</button>
                              <Show when={getDisconnectMode(provider) === "credential-remove"}><button type="button" class="selector-button selector-button-secondary providers-disconnect-button" disabled={stage() !== "idle"} onClick={() => void disconnectProvider(provider.id)} title={t("settings.providers.actions.disconnect")}>{t("settings.providers.actions.disconnect")}</button></Show>
                            </div>
                          </div>
                        </article>
                      )}</For>
                    </div>
                  </>
                }>
                  {(provider) => (
                    <ProviderModelVisibilityManager
                      providerId={provider().id}
                      providerName={provider().name || provider().id}
                      models={provider().models}
                      onBack={closeModelManager}
                    />
                  )}
                </Show>
              </section>
            </Show>
          </div>
    </>
  )

  if (props.embedded) {
    return <div class="providers-manager-modal providers-manager-embedded">{content()}</div>
  }

  return (
    <Dialog open={Boolean(props.open)} onOpenChange={handleModalOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay" />
        <Dialog.Content class="modal-surface providers-manager-modal">
          {content()}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}
