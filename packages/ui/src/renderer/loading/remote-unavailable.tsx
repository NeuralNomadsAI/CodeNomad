import { createSignal } from "solid-js"
import { tGlobal } from "../../lib/i18n"

interface RemoteRecoveryAPI {
  retryRemoteWindow?: (token: string) => Promise<unknown>
  openLocalWindow?: (token: string) => Promise<unknown>
}

function recoveryApi(): RemoteRecoveryAPI {
  return (window as Window & { electronAPI?: RemoteRecoveryAPI }).electronAPI ?? {}
}

/**
 * What an Electron remote window shows when its server could not be loaded: never a page without a way
 * back. `token` is the one the host issued for this document; it authorises the native actions.
 */
export function RemoteUnavailable(props: { token: string }) {
  const [busy, setBusy] = createSignal(false)
  const run = async (action: ((token: string) => Promise<unknown>) | undefined) => {
    if (!action || busy()) return
    setBusy(true)
    try {
      await action(props.token)
    } catch {
      /* the host keeps this page when the action fails */
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="loading-card" role="alert">
      <p class="loading-remote-title">{tGlobal("loadingScreen.remoteUnavailable.title")}</p>
      <p class="loading-remote-message">{tGlobal("loadingScreen.remoteUnavailable.message")}</p>
      <div class="loading-remote-actions">
        <button type="button" class="selector-button selector-button-primary" disabled={busy()} onClick={() => void run(recoveryApi().retryRemoteWindow)}>
          {tGlobal("loadingScreen.remoteUnavailable.retry")}
        </button>
        <button type="button" class="selector-button selector-button-secondary" disabled={busy()} onClick={() => void run(recoveryApi().openLocalWindow)}>
          {tGlobal("loadingScreen.remoteUnavailable.openLocal")}
        </button>
        <button type="button" class="selector-button selector-button-secondary" onClick={() => window.close()}>
          {tGlobal("loadingScreen.remoteUnavailable.close")}
        </button>
      </div>
    </div>
  )
}
