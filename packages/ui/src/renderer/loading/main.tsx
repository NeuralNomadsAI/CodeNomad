import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { render } from "solid-js/web"
// The loading screen is always dark (loading.html): the white hexagon.
import logoUrl from "../../images/CodeNomad-Logo-OnDark.svg"
import { tGlobal } from "../../lib/i18n"
import { remoteUnavailableToken } from "../../lib/native/remote-unavailable"
import { runtimeEnv, isElectronHost, isTauriHost } from "../../lib/runtime-env"
import { RemoteUnavailable } from "./remote-unavailable"
import "../../index.css"
import "./loading.css"

interface CliStatus {
  state?: string
  error?: string | null
}

function annotateDocument() {
  if (typeof document === "undefined") {
    return
  }
  document.documentElement.dataset.runtimeHost = runtimeEnv.host
  document.documentElement.dataset.runtimePlatform = runtimeEnv.platform
}

function LoadingApp() {
  const [error, setError] = createSignal<string | null>(null)
  const [statusKey, setStatusKey] = createSignal("loadingScreen.status.loading")
  const [busy, setBusy] = createSignal(true)

  onMount(() => {
    annotateDocument()
    const unsubscribers: Array<() => void> = []
    let disposed = false
    let eventVersion = 0

    function applyStatus(payload: CliStatus) {
      if (disposed) return
      const failed = payload.state === "error"
      setError(failed && typeof payload.error === "string" ? payload.error : null)
      setBusy(!failed && payload.state !== "stopped")
      setStatusKey(failed ? "loadingScreen.status.issue"
        : payload.state === "starting" ? "loadingScreen.status.starting"
        : payload.state === "ready" ? "loadingScreen.status.ready"
        : payload.state === "stopped" ? "loadingScreen.status.stopped"
        : "loadingScreen.status.loading")
    }

    function onStatus(payload: unknown) {
      eventVersion++
      applyStatus((payload as CliStatus) || {})
    }

    function onError(payload: unknown) {
      const data = payload as { error?: unknown; message?: unknown } | null
      const message = data?.error ?? data?.message
      onStatus({ state: "error", error: typeof message === "string" ? message : null })
    }

    function keep(unsubscribe: () => void) {
      if (disposed) unsubscribe()
      else unsubscribers.push(unsubscribe)
    }

    async function bootstrap() {
      let version = eventVersion
      try {
        if (isTauriHost()) {
          keep(await listen("cli:error", event => onError(event.payload)))
          keep(await listen("cli:status", event => onStatus(event.payload)))
        } else if (isElectronHost()) {
          const api = window.electronAPI
          if (api?.onCliError) keep(api.onCliError(onError))
          if (api?.onCliStatus) keep(api.onCliStatus(onStatus))
        }
        if (disposed) return
        version = eventVersion
        const result = isTauriHost()
          ? await invoke<CliStatus>("cli_get_status")
          : await window.electronAPI?.getCliStatus?.() as CliStatus | undefined
        if (result && version === eventVersion) applyStatus(result)
      } catch (err) {
        if (version === eventVersion) onError({ error: String(err) })
      }
    }

    if (runtimeEnv.windowContext !== "remote") {
      void bootstrap()
    }

    onCleanup(() => {
      disposed = true
      unsubscribers.forEach((unsubscribe) => {
        try {
          unsubscribe()
        } catch {
          /* noop */
        }
      })
    })
  })

  return (
    <div class="loading-wrapper" role="status" aria-live="polite">
      <img src={logoUrl} alt={tGlobal("loadingScreen.logoAlt")} class="loading-logo" width="73" height="85" />
      <div class="loading-heading">
        <h1 class="loading-title">CodeNomad</h1>
      </div>
      <Show when={!recoveryToken} fallback={<RemoteUnavailable token={recoveryToken!} />}>
        <div class="loading-card">
          <div class="loading-row">
            <Show when={busy()}><div class="spinner" aria-hidden="true" /></Show>
            <span>{tGlobal(statusKey())}</span>
          </div>
          {error() && <div class="loading-error">{error()}</div>}
        </div>
      </Show>
    </div>
  )
}

// An Electron remote window shows this page when its server could not be loaded.
const recoveryToken = runtimeEnv.windowContext === "remote" ? remoteUnavailableToken(window.location.href) : null

const root = document.getElementById("loading-root")

if (!root) {
  throw new Error(tGlobal("loadingScreen.errors.missingRoot"))
}

render(() => <LoadingApp />, root)
