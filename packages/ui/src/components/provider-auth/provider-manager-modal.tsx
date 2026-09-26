import { Dialog } from "@kobalte/core/dialog"
import { Select } from "@kobalte/core/select"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Component } from "solid-js"
import { Check, ChevronDown, ExternalLink, KeyRound, Loader2, PlugZap, RefreshCw, X } from "lucide-solid"
import type { ConnectionInfo, FormAnswer, FormValue, IntegrationMethod, LocationRef, ModelInfo, OpenCodeClient, ProviderInfo } from "@opencode/client"
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
import { locationAuthorityKey, requestLocationOptions, toRequestLocation } from "../../stores/request-locations"
import { getRootClient } from "../../stores/opencode-client"
import { ProviderAuthForm } from "./provider-auth-form"
import { ProviderAccounts } from "./provider-accounts"
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
  connections: ConnectionInfo[]
}

interface ProviderManagerModalProps {
  instanceId: string
  open?: boolean
  embedded?: boolean
  location?: LocationRef
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
  let authCatalogLocation: LocationRef | null = null
  let loadedInstanceId: string | null = null
  let loadedClient: OpenCodeClient | null = null
  let loadedCatalogLocationKey: string | null = null
  let oauthCodeInput: HTMLInputElement | undefined

  const instance = createMemo(() => instances().get(props.instanceId) ?? null)
  const client = createMemo<OpenCodeClient | null>(() => {
    if (props.instanceId && props.location) return getRootClient(props.instanceId)
    const current = instance()
    return current?.status === "ready" ? current.client ?? null : null
  })
  const currentCatalogLocation = () => props.location ? { ...props.location } : { ...getActiveCatalogLocation(props.instanceId) }
  const requestLocation = (location: LocationRef) => toRequestLocation(location)
  const isActiveCatalogLocation = (location: LocationRef) => {
    const active = currentCatalogLocation()
    return locationAuthorityKey(active) === locationAuthorityKey(location)
  }

  const providerNameById = createMemo(() => {
    const names = new Map<string, string>()
    for (const provider of availableProviders()) {
      names.set(provider.id, provider.name || provider.id)
    }
    return names
  })

  const configurableProviders = createMemo<ConfigurableProviderOption[]>(() => {
    return availableProviders()
      .filter(provider => provider.source === "unknown" && provider.canConnect)
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
    if (!props.embedded && !props.open) {
      loadedInstanceId = null
      loadedClient = null
      loadedCatalogLocationKey = null
      resetProviderData()
      return
    }
    const instanceId = props.instanceId
    const authClient = client()
    if (!authClient) {
      loadedInstanceId = null
      loadedClient = null
      loadedCatalogLocationKey = null
      resetProviderData()
      return
    }
    const catalogLocation = currentCatalogLocation()
    const catalogLocationKey = locationAuthorityKey(catalogLocation)
    if (loadedInstanceId === instanceId && loadedClient === authClient && loadedCatalogLocationKey === catalogLocationKey) return
    resetProviderData()
    loadedInstanceId = instanceId
    loadedClient = authClient
    loadedCatalogLocationKey = catalogLocationKey
    void loadProviderData(authClient, version, catalogLocation)
  })

  createEffect(() => {
    if (stage() === "code") queueMicrotask(() => oauthCodeInput?.focus())
  })

  onCleanup(() => {
    loadVersion += 1
    disposePendingAuth()
  })

  async function loadProviderData(
    authClient: OpenCodeClient,
    version: number,
    catalogLocation: LocationRef,
  ): Promise<void> {
    const isCurrentLoad = () => version === loadVersion && client() === authClient && isActiveCatalogLocation(catalogLocation)
    setLoading(true)
    setLoadError(null)
    try {
      const location = { location: requestLocation(catalogLocation) }
      const [providerResponse, modelResponse, integrationResponse] = await Promise.all([
        authClient.provider.list(location, requestLocationOptions(catalogLocation)),
        authClient.model.list(location, requestLocationOptions(catalogLocation)),
        authClient.integration.list(location, requestLocationOptions(catalogLocation)),
      ])
      if (!isCurrentLoad()) return
      const listed = buildListedProviders(providerResponse.data, modelResponse.data, integrationResponse.data).map((provider) => ({
        ...provider,
        models: buildProviderVisibilityModels(provider.id, providerResponse.data, modelResponse.data),
        connections: integrationResponse.data.find(item => item.id === provider.id)?.connections ?? [],
      }))
      const methods = Object.fromEntries(integrationResponse.data.map((integration) => [
        integration.id,
        integration.methods.filter((method): method is NativeAuthMethod => method.type !== "env"),
      ]))
      setAvailableProviders(listed)
      setMethodsByProvider(methods)
      setSelectedProviderId((current) => current ?? listed[0]?.id ?? integrationResponse.data[0]?.id ?? null)
    } catch (error) {
      if (!isCurrentLoad()) return
      setLoadError(extractProviderAuthErrorMessage(error, t("settings.providers.errors.loadFailed")))
    } finally {
      if (isCurrentLoad()) setLoading(false)
    }
  }

  function disposePendingAuth() {
    authOperationVersion += 1
    authCatalogLocation = null
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

  async function refreshAfterAuth(authClient: OpenCodeClient, instanceId: string, operationVersion: number, catalogLocation: LocationRef) {
    if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
    if (!props.location) await fetchProviders(instanceId, catalogLocation, true).catch(() => undefined)
    if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
    await loadProviderData(authClient, ++loadVersion, currentCatalogLocation()).catch(() => undefined)
  }

  async function refreshProviderData() {
    const authClient = client()
    const instanceId = props.instanceId
    if (!authClient) return
    const catalogLocation = currentCatalogLocation()
    setLoading(true)
    if (!props.location) await fetchProviders(instanceId, catalogLocation, true).catch(() => undefined)
    if (client() !== authClient || props.instanceId !== instanceId) return
    await loadProviderData(authClient, ++loadVersion, catalogLocation)
  }

  function closeModelManager() {
    setManagedProviderId(null)
    queueMicrotask(() => {
      if (managedProviderTriggerId) manageModelButtons.get(managedProviderTriggerId)?.focus()
    })
  }

  async function submitApiAuth(providerId: string, authClient: OpenCodeClient, instanceId: string, operationVersion: number, catalogLocation: LocationRef) {
    await authClient.integration.connect.key({
      integrationID: providerId,
      key: apiKey().trim(),
      answer: getProviderAuthAnswer(selectedForm(), formAnswer()),
      location: requestLocation(catalogLocation),
    }, requestLocationOptions(catalogLocation))
    if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
    await refreshAfterAuth(authClient, instanceId, operationVersion, catalogLocation)
    if (isCurrentOperation(operationVersion, instanceId, authClient)) resetFlow(null)
  }

  async function submitOAuthAuthorize(providerId: string, authClient: OpenCodeClient, instanceId: string, operationVersion: number, catalogLocation: LocationRef) {
    const method = selectedMethod()
    if (method.type !== "oauth") throw new Error(t("settings.providers.errors.noAuthorization"))
    const response = await authClient.integration.oauth.connect({
      integrationID: providerId,
      methodID: method.id,
      answer: getProviderAuthAnswer(selectedForm(), formAnswer()),
      location: requestLocation(catalogLocation),
    }, requestLocationOptions(catalogLocation))
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
        { integrationID: providerId, attemptID: data.attemptID, location: requestLocation(catalogLocation) },
        { ...requestLocationOptions(catalogLocation), signal: callbackAbortController.signal },
      )
      if (result.data.status === "complete") break
      if (result.data.status === "failed") throw new Error(result.data.message)
      if (result.data.status === "expired") throw new Error(t("settings.providers.errors.authorizationFailed"))
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
    callbackAbortController = null
    await refreshAfterAuth(authClient, instanceId, operationVersion, catalogLocation)
    if (isCurrentOperation(operationVersion, instanceId, authClient)) resetFlow(null)
  }

  async function submitCommandAuth(providerId: string, authClient: OpenCodeClient, instanceId: string, operationVersion: number, catalogLocation: LocationRef) {
    const method = selectedMethod()
    if (method.type !== "command") throw new Error(t("settings.providers.errors.noAuthorization"))
    const response = await authClient.integration.command.connect({
      integrationID: providerId,
      methodID: method.id,
      location: requestLocation(catalogLocation),
    }, requestLocationOptions(catalogLocation))
    if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
    const attemptID = response.data.attemptID
    setCommandAttemptId(attemptID)
    setCommandStatusMessage(null)
    setStage("waiting")
    callbackAbortController = new AbortController()
    while (true) {
      const result = await authClient.integration.command.status(
        { integrationID: providerId, attemptID, location: requestLocation(catalogLocation) },
        { ...requestLocationOptions(catalogLocation), signal: callbackAbortController.signal },
      )
      if (result.data.status === "complete") break
      if (result.data.status === "failed") throw new Error(result.data.message)
      if (result.data.status === "expired") throw new Error(t("settings.providers.errors.authorizationFailed"))
      setCommandStatusMessage(result.data.message ?? null)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
    callbackAbortController = null
    await refreshAfterAuth(authClient, instanceId, operationVersion, catalogLocation)
    if (isCurrentOperation(operationVersion, instanceId, authClient)) resetFlow(null)
  }

  async function submitAuth() {
    const providerId = activeProviderId()
    const authClient = client()
    if (!providerId || !authClient || !canSubmit()) return
    const instanceId = props.instanceId
    const catalogLocation = currentCatalogLocation()
    const operationVersion = ++authOperationVersion
    authCatalogLocation = catalogLocation
    setStage("authorizing")
    setActionError(null)
    try {
      if (selectedMethod().type === "key") {
        await submitApiAuth(providerId, authClient, instanceId, operationVersion, catalogLocation)
        return
      }
      if (selectedMethod().type === "command") {
        await submitCommandAuth(providerId, authClient, instanceId, operationVersion, catalogLocation)
        return
      }
      pendingOauthPopup = prepareOAuthPopupWindow()
      setAuthorizationLaunchBlocked(isBrowserHostForOAuth() && pendingOauthPopup === null)
      await submitOAuthAuthorize(providerId, authClient, instanceId, operationVersion, catalogLocation)
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
    const catalogLocation = authCatalogLocation
    if (!catalogLocation) return
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
        location: requestLocation(catalogLocation),
      }, requestLocationOptions(catalogLocation))
      if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
      await refreshAfterAuth(authClient, instanceId, operationVersion, catalogLocation)
      if (isCurrentOperation(operationVersion, instanceId, authClient)) resetFlow(null)
    } catch (error) {
      if (!isCurrentOperation(operationVersion, instanceId, authClient)) return
      setActionError(extractProviderAuthErrorMessage(error, t("settings.providers.errors.authorizationFailed")))
      setStage("code")
    }
  }

  function cancelOAuthWait() {
    const providerId = activeProviderId()
    const attemptID = authorization()?.attemptID
    const commandAttemptID = commandAttemptId()
    const authClient = client()
    const instanceId = props.instanceId
    const catalogLocation = authCatalogLocation
    if (providerId && attemptID && authClient && catalogLocation) {
      void authClient.integration.oauth.cancel({
        integrationID: providerId,
        attemptID,
        location: requestLocation(catalogLocation),
      }, requestLocationOptions(catalogLocation)).catch(() => undefined)
    }
    if (providerId && commandAttemptID && authClient && catalogLocation) {
      void authClient.integration.command.cancel({
        integrationID: providerId,
        attemptID: commandAttemptID,
        location: requestLocation(catalogLocation),
      }, requestLocationOptions(catalogLocation)).catch(() => undefined)
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

  function configuredProviderSummary(provider: ListedProvider) {
    const modelCount = provider.modelCount === 1
      ? t("settings.providers.models.one", { count: provider.modelCount })
      : t("settings.providers.models.other", { count: provider.modelCount })
    return [...new Set([
      methodSummary(provider.id),
      describeProviderSource(provider),
      modelCount,
    ].filter(Boolean))].join(" • ")
  }

  const content = () => (
    <>
          <Show when={!props.embedded}>
            <div class="providers-manager-header">
              <div class="settings-card-heading-with-icon">
                <PlugZap class="settings-card-heading-icon" />
                <div>
                  <Dialog.Title class="providers-manager-title">{t("settings.providers.title")}</Dialog.Title>
                </div>
              </div>
              <button type="button" class="selector-button selector-button-secondary settings-screen-close" onClick={() => handleModalOpenChange(false)} aria-label={t("settings.close")}>
                <X class="w-4 h-4" />
              </button>
            </div>
          </Show>

          <div class="providers-manager-body">
            <Show when={!client()}>
              <div class="settings-card-message" role="status">{t("settings.providers.empty.noInstance")}</div>
            </Show>

            <Show when={client()}>
              <div class="providers-connect-bar">
                <Show when={configurableProviders().length > 0}>
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
                </Show>
                <button type="button" class="icon-button-compact" title={t("settings.providers.refresh")} aria-label={t("settings.providers.refresh")} disabled={loading()} onClick={() => void refreshProviderData()}>
                  <RefreshCw class={loading() ? "providers-spin-icon" : "providers-button-icon"} />
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
                      <div class="settings-toggle-title">{t("settings.providers.method.title")}</div>
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


                  <Show when={selectedMethod().type === "command" && (stage() === "prompts" || stage() === "error" || stage() === "authorizing")}>
                    <div class="providers-form-stack">
                      <div class="providers-command-preview" title={t("settings.providers.command.description")} dir="ltr">{selectedCommand()?.command.join(" ")}</div>
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

              <section class="providers-list-section providers-accounts-list">
                <h3 class="settings-card-title">{t("settings.providers.configured.title")}</h3>
                <Show when={managedProvider()} fallback={
                  <>
                    <Show when={loading()}><div class="providers-loading-row" role="status"><Loader2 class="providers-spin-icon" /><span>{t("settings.providers.loading")}</span></div></Show>
                    <Show when={!loading() && configuredProviders().length === 0}><div class="settings-card-message" role="status">{t("settings.providers.empty.noConfiguredProviders")}</div></Show>
                    <div class="providers-grid">
                      <For each={configuredProviders().map(provider => provider.id)}>{(providerId) => {
                        const provider = createMemo(() => configuredProviders().find(item => item.id === providerId)!)
                        return (
                        <article class="providers-card settings-toggle-row settings-toggle-row-compact">
                          <div class="providers-card-copy">
                            <h4 class="providers-card-title" title={configuredProviderSummary(provider())}>{provider().name || providerId}</h4>
                          </div>
                          <div class="provider-model-card-actions">
                            <Show when={provider().canConnect}><button type="button" class="selector-button selector-button-primary"
                              disabled={stage() !== "idle"} onClick={() => {
                                resetFlow(providerId)
                                queueMicrotask(() => document.querySelector<HTMLElement>(".providers-connect-panel")?.scrollIntoView({ block: "nearest" }))
                              }}>{t("settings.accounts.add")}</button></Show>
                            <button
                              ref={(element) => manageModelButtons.set(providerId, element)}
                              type="button"
                              class="selector-button selector-button-secondary"
                              onClick={() => {
                                managedProviderTriggerId = providerId
                                setManagedProviderId(providerId)
                              }}
                            >{t("settings.providers.actions.manageModels")}</button>
                          </div>
                          <Show when={client() && (provider().credentialIds.length > 0 || provider().source === "env")}>
                            <ProviderAccounts instanceId={props.instanceId} integrationId={providerId} client={client()!}
                              initialConnections={provider().connections}
                              location={currentCatalogLocation()} disabled={stage() !== "idle"} onChanged={refreshProviderData} />
                          </Show>
                        </article>
                      )}}</For>
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
