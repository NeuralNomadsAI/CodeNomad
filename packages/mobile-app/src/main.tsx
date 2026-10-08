import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { invoke } from "@tauri-apps/api/core"
import { canonicalEndpoint } from "./endpoint"
import { loadMessages } from "./messages"
import "../../ui/src/styles/tokens.css"
import "./launcher.css"

async function start() {
  const t = await loadMessages(navigator.languages)
  function Launcher() {
    const [endpoint, setEndpoint] = createSignal("")
    const [error, setError] = createSignal("")
    const [busy, setBusy] = createSignal(false)
    async function connect(event: SubmitEvent) {
      event.preventDefault()
      if (busy()) return
      setError("")
      let canonical: string
      try { canonical = canonicalEndpoint(endpoint()) }
      catch { setError(t("invalid")); return }
      setBusy(true)
      try { await invoke("connect_server", { endpoint: canonical }) }
      catch (error) { setError(t(String(error) === "unsupported" ? "unsupported" : "failed")) }
      finally { setBusy(false) }
    }
    return <main>
      <p class="brand">CodeNomad</p>
      <h1>{t("remoteAccess.title")}</h1>
      <p>{t("help")}</p>
      <form onSubmit={connect}>
        <label for="endpoint">{t("endpoint")}</label>
        <input id="endpoint" type="url" required inputmode="url" autocomplete="off" dir="ltr"
          autocapitalize="off" spellcheck={false} placeholder="https://example.com"
          value={endpoint()} onInput={(event) => setEndpoint(event.currentTarget.value)}
          disabled={busy()} aria-describedby="network error" />
        <button type="submit" disabled={busy()}>{busy() ? t("working") : t("remoteAccess.address.open")}</button>
      </form>
      <p id="error" role="alert">{error()}</p>
      <p id="network" class="note">{t("network")}</p>
      <p class="note">{t("recovery")}</p>
      <p class="note">{t("privacy")}</p>
    </main>
  }
  render(() => <Launcher />, document.getElementById("root")!)
}

void start()
