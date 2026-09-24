import { Dialog } from "@kobalte/core/dialog"
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { authRecovery } from "../lib/auth-recovery"
import { useI18n } from "../lib/i18n"

export default function AuthRecoveryDialog() {
  const { t } = useI18n()
  const [username, setUsername] = createSignal("codenomad")
  const [password, setPassword] = createSignal("")
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<"credentials" | "unavailable" | "">("")
  createEffect(() => { if (!authRecovery.required()) { setPassword(""); setError("") } })
  onMount(() => {
    const check = () => { if (authRecovery.required()) void authRecovery.check() }
    window.addEventListener("focus", check)
    onCleanup(() => window.removeEventListener("focus", check))
  })

  async function signIn(event: SubmitEvent) {
    event.preventDefault()
    if (pending()) return
    setPending(true)
    setError("")
    const result = await authRecovery.signIn(username(), password())
    setPassword("")
    if (result !== "ok") setError(result)
    setPending(false)
  }

  return (
    <Dialog open={authRecovery.required()} modal>
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay auth-recovery-overlay" />
        <Dialog.Content class="modal-surface window-shell auth-recovery-window"
          onEscapeKeyDown={event => { event.preventDefault(); event.stopImmediatePropagation() }}
          onInteractOutside={event => event.preventDefault()}>
          <div class="window-header"><Dialog.Title class="window-title">{t("authRecovery.title")}</Dialog.Title></div>
          <form onSubmit={signIn}>
            <div class="window-body">
              <Dialog.Description>{t("authRecovery.description")}</Dialog.Description>
              <p>{t("authRecovery.drafts")}</p>
              <label for="auth-recovery-username">{t("authRecovery.username")}</label>
              <input id="auth-recovery-username" class="form-input" name="username" autocomplete="username"
                autocapitalize="none" autocorrect="off" spellcheck={false} required
                value={username()} onInput={event => setUsername(event.currentTarget.value)} disabled={pending()} />
              <label for="auth-recovery-password">{t("authRecovery.password")}</label>
              <input id="auth-recovery-password" class="form-input" name="password" type="password" autocomplete="current-password"
                required value={password()} onInput={event => setPassword(event.currentTarget.value)} disabled={pending()} />
              <Show when={error()}><p role="alert">{t(error() === "credentials" ? "authRecovery.credentials" : "authRecovery.unavailable")}</p></Show>
            </div>
            <div class="window-footer">
              <button type="button" class="window-action" disabled={pending()} onClick={() => void authRecovery.check()}>{t("authRecovery.check")}</button>
              <button type="submit" class="window-action" disabled={pending()}>{t(pending() ? "authRecovery.pending" : "authRecovery.signIn")}</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}
