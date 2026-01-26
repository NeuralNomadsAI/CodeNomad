import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { render } from "solid-js/web"
import iconUrl from "../../images/CodeNomad-Icon.png"
import { tGlobal } from "../../lib/i18n"
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
}

interface TauriBridge {
  invoke?: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>
  event?: {
    listen: (event: string, handler: (payload: { payload: unknown }) => void) => Promise<() => void>
  }
}

function pickPhraseKey(previous?: PhraseKey) {
  const filtered = phraseKeys.filter((key) => key !== previous)
  const source = filtered.length > 0 ? filtered : phraseKeys
  const index = Math.floor(Math.random() * source.length)
  return source[index]
}

function navigateTo(url?: string | null) {
  if (!url) return
  window.location.replace(url)
}

function getTauriBridge(): TauriBridge | null {
  if (typeof window === "undefined") {
    return null
  }
  const bridge = (window as { __TAURI__?: TauriBridge }).__TAURI__
  if (!bridge || !bridge.event || !bridge.invoke) {
    return null
  }
  return bridge
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
    setPhraseKey(pickPhraseKey())
    const unsubscribers: Array<() => void> = []

    async function bootstrapTauri(tauriBridge: TauriBridge | null) {
      if (!tauriBridge || !tauriBridge.event || !tauriBridge.invoke) {
        return
      }
      try {
        const readyUnlisten = await tauriBridge.event.listen("cli:ready", (event) => {
          const payload = (event?.payload as CliStatus) || {}
          setError(null)
          setStatusKey(null)
          navigateTo(payload.url)
        })
        const errorUnlisten = await tauriBridge.event.listen("cli:error", (event) => {
          const payload = (event?.payload as CliStatus) || {}
          if (payload.error) {
            setError(payload.error)
            setStatusKey("loadingScreen.status.issue")
          }
        })
        const statusUnlisten = await tauriBridge.event.listen("cli:status", (event) => {
          const payload = (event?.payload as CliStatus) || {}
          if (payload.state === "error" && payload.error) {
            setError(payload.error)
            setStatusKey("loadingScreen.status.issue")
            return
          }
          if (payload.state && payload.state !== "ready") {
            setError(null)
            setStatusKey(null)
          }
        })
        unsubscribers.push(readyUnlisten, errorUnlisten, statusUnlisten)

        const result = await tauriBridge.invoke<CliStatus>("cli_get_status")
        if (result?.state === "ready" && result.url) {
          navigateTo(result.url)
        } else if (result?.state === "error" && result.error) {
          setError(result.error)
          setStatusKey("loadingScreen.status.issue")
        }
      } catch (err) {
        setError(String(err))
        setStatusKey("loadingScreen.status.issue")
      }
    }

    if (isTauriHost()) {
      void bootstrapTauri(getTauriBridge())
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
