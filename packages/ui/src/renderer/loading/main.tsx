import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { render } from "solid-js/web"
import iconUrl from "../../images/EraCode-Icon.png"
import { runtimeEnv, isTauriHost } from "../../lib/runtime-env"
import "../../index.css"
import "./loading.css"

const phrases = [
  "Warming up the AI neurons…",
  "Convincing the AI to stop daydreaming…",
  "Polishing the AI’s code goggles…",
  "Asking the AI to stop reorganizing your files…",
  "Feeding the AI additional coffee…",
  "Teaching the AI not to delete node_modules (again)…",
  "Telling the AI to act natural before you arrive…",
  "Asking the AI to please stop rewriting history…",
  "Letting the AI stretch before its coding sprint…",
  "Persuading the AI to give you keyboard control…",
]

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

function pickPhrase(previous?: string) {
  const filtered = phrases.filter((phrase) => phrase !== previous)
  const source = filtered.length > 0 ? filtered : phrases
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
  const [phrase, setPhrase] = createSignal(pickPhrase())
  const [error, setError] = createSignal<string | null>(null)
  const [status, setStatus] = createSignal<string | null>(null)

  const changePhrase = () => setPhrase(pickPhrase(phrase()))

  onMount(() => {
    annotateDocument()
    setPhrase(pickPhrase())
    const unsubscribers: Array<() => void> = []

    async function bootstrapTauri(tauriBridge: TauriBridge | null) {
      if (!tauriBridge || !tauriBridge.event || !tauriBridge.invoke) {
        return
      }
      try {
        const readyUnlisten = await tauriBridge.event.listen("cli:ready", (event) => {
          const payload = (event?.payload as CliStatus) || {}
          setError(null)
          setStatus(null)
          navigateTo(payload.url)
        })
        const errorUnlisten = await tauriBridge.event.listen("cli:error", (event) => {
          const payload = (event?.payload as CliStatus) || {}
          if (payload.error) {
            setError(payload.error)
            setStatus("Encountered an issue")
          }
        })
        const statusUnlisten = await tauriBridge.event.listen("cli:status", (event) => {
          const payload = (event?.payload as CliStatus) || {}
          if (payload.state === "error" && payload.error) {
            setError(payload.error)
            setStatus("Encountered an issue")
            return
          }
          if (payload.state && payload.state !== "ready") {
            setError(null)
            setStatus(null)
          }
        })
        unsubscribers.push(readyUnlisten, errorUnlisten, statusUnlisten)

        const result = await tauriBridge.invoke<CliStatus>("cli_get_status")
        if (result?.state === "ready" && result.url) {
          navigateTo(result.url)
        } else if (result?.state === "error" && result.error) {
          setError(result.error)
          setStatus("Encountered an issue")
        }
      } catch (err) {
        setError(String(err))
        setStatus("Encountered an issue")
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
      <img src={iconUrl} alt="Era Code" class="loading-logo" width="180" height="180" />
      <div class="loading-heading">
        <h1 class="loading-title">Era Code</h1>
        <Show when={status()}>{(statusText) => <p class="loading-status">{statusText()}</p>}</Show>
      </div>
      <div class="loading-card">
        <div class="loading-row">
          <div class="spinner" aria-hidden="true" />
          <span>{phrase()}</span>
        </div>
        <div class="phrase-controls">
          <button type="button" onClick={changePhrase}>
            Show another
          </button>
        </div>
        {error() && <div class="loading-error">{error()}</div>}
      </div>
    </div>
  )
}

const root = document.getElementById("loading-root")

if (!root) {
  throw new Error("Loading root element not found")
}

render(() => <LoadingApp />, root)
