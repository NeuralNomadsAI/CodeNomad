import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { render } from "solid-js/web"
import iconUrl from "../../images/CodeNomad-Icon.png"
import { tGlobal } from "../../lib/i18n"
import { beginPerfTrace, markPerf, measurePerf } from "../../lib/perf"
import { runtimeEnv, isTauriHost } from "../../lib/runtime-env"
import "../../index.css"
import "./loading.css"

const phraseKeys = [
  "loadingScreen.phrases.neurons",
  "loadingScreen.phrases.daydreaming",
  "loadingScreen.phrases.goggles",
  "loadingScreen.phrases.reorganizingFiles",
  "loadingScreen.phrases.coffee",
  "loadingScreen.phrases.nodeModules",
  "loadingScreen.phrases.actNatural",
  "loadingScreen.phrases.rewritingHistory",
  "loadingScreen.phrases.stretch",
  "loadingScreen.phrases.keyboardControl",
] as const

type PhraseKey = (typeof phraseKeys)[number]

interface CliStatus {
  state?: string
  url?: string | null
  error?: string | null
  startupEvents?: StartupPerfEvent[]
}

interface StartupPerfEvent {
  stage?: string
  detail?: Record<string, unknown>
}

function pickPhraseKey(previous?: PhraseKey) {
  const filtered = phraseKeys.filter((key) => key !== previous)
  const source = filtered.length > 0 ? filtered : phraseKeys
  const index = Math.floor(Math.random() * source.length)
  return source[index]
}

function navigateTo(url?: string | null) {
  if (!url) return
  markPerf("loading.navigate", { url })
  measurePerf("loading_to_navigation", "loading.screen.mounted", "loading.navigate")
  window.location.replace(url)
}

function annotateDocument() {
  if (typeof document === "undefined") {
    return
  }
  document.documentElement.dataset.runtimeHost = runtimeEnv.host
  document.documentElement.dataset.runtimePlatform = runtimeEnv.platform
}

function LoadingApp() {
  const [phraseKey, setPhraseKey] = createSignal<PhraseKey>(pickPhraseKey())
  const [error, setError] = createSignal<string | null>(null)
  const [statusKey, setStatusKey] = createSignal<string | null>(null)

  const changePhrase = () => setPhraseKey(pickPhraseKey(phraseKey()))

  onMount(() => {
    annotateDocument()
    beginPerfTrace("loading.screen.mounted", {
      host: runtimeEnv.host,
      platform: runtimeEnv.platform,
    })
    setPhraseKey(pickPhraseKey())
    const unsubscribers: Array<() => void> = []

    async function bootstrapTauri() {
      const replayStartupEvent = (payload: StartupPerfEvent) => {
        if (!payload?.stage) {
          return
        }

        const markName = `loading.tauri.${payload.stage}`
        if (typeof window !== "undefined") {
          const trace = (window as any).__CODENOMAD_PERF__?.getTrace?.() ?? []
          if (Array.isArray(trace) && trace.some((entry: { name?: string }) => entry?.name === markName)) {
            return
          }
        }

        markPerf(markName, payload.detail)
      }

      try {
        markPerf("loading.tauri.bootstrap.start")
        const perfUnlisten = await listen("perf:startup", (event) => {
          const payload = (event?.payload as StartupPerfEvent) || {}
          replayStartupEvent(payload)
        })
        const readyUnlisten = await listen("cli:ready", (event) => {
          const payload = (event?.payload as CliStatus) || {}
          setError(null)
          setStatusKey(null)
          markPerf("loading.tauri.cli.ready", { url: payload.url ?? null })
          measurePerf("loading_to_cli_ready", "loading.screen.mounted", "loading.tauri.cli.ready")
          navigateTo(payload.url)
        })
        const errorUnlisten = await listen("cli:error", (event) => {
          const payload = (event?.payload as CliStatus) || {}
          if (payload.error) {
            markPerf("loading.tauri.cli.error", { error: payload.error })
            setError(payload.error)
            setStatusKey("loadingScreen.status.issue")
          }
        })
        const statusUnlisten = await listen("cli:status", (event) => {
          const payload = (event?.payload as CliStatus) || {}
          if (payload.state === "error" && payload.error) {
            markPerf("loading.tauri.cli.status.error", { error: payload.error })
            setError(payload.error)
            setStatusKey("loadingScreen.status.issue")
            return
          }
          if (payload.state && payload.state !== "ready") {
            markPerf(`loading.tauri.cli.status.${payload.state}`)
            setError(null)
            setStatusKey(null)
          }
        })
        unsubscribers.push(perfUnlisten, readyUnlisten, errorUnlisten, statusUnlisten)

        const result = await invoke<CliStatus>("cli_get_status")
        result?.startupEvents?.forEach((entry) => replayStartupEvent(entry))
        if (result?.state === "ready" && result.url) {
          markPerf("loading.tauri.status.ready-on-load", { url: result.url })
          navigateTo(result.url)
        } else if (result?.state === "error" && result.error) {
          markPerf("loading.tauri.status.error-on-load", { error: result.error })
          setError(result.error)
          setStatusKey("loadingScreen.status.issue")
        }
      } catch (err) {
        markPerf("loading.tauri.bootstrap.error", { error: String(err) })
        setError(String(err))
        setStatusKey("loadingScreen.status.issue")
      }
    }

    if (isTauriHost()) {
      void bootstrapTauri()
    }

    onCleanup(() => {
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
      <img src={iconUrl} alt={tGlobal("loadingScreen.logoAlt")} class="loading-logo" width="180" height="180" />
      <div class="loading-heading">
        <h1 class="loading-title">CodeNomad</h1>
        <Show when={statusKey()}>
          {(key) => <p class="loading-status">{tGlobal(key())}</p>}
        </Show>
      </div>
      <div class="loading-card">
        <div class="loading-row">
          <div class="spinner" aria-hidden="true" />
          <span>{tGlobal(phraseKey())}</span>
        </div>
        <div class="phrase-controls">
          <button type="button" onClick={changePhrase}>
            {tGlobal("loadingScreen.actions.showAnother")}
          </button>
        </div>
        {error() && <div class="loading-error">{error()}</div>}
      </div>
    </div>
  )
}

const root = document.getElementById("loading-root")

if (!root) {
  throw new Error(tGlobal("loadingScreen.errors.missingRoot"))
}

render(() => <LoadingApp />, root)
