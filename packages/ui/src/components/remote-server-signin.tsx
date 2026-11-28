import { createSignal, createUniqueId, onCleanup, Show } from "solid-js"
import { useI18n } from "../lib/i18n"
import { secretEntryAllowed } from "../lib/server-meta"

/** Credentials live only in the mounted form and its in-flight connect request. */
export default function RemoteServerSignin(props: {
  busy: boolean
  error?: string
  onConnect: (credentials: { username: string; password: string }) => void
}) {
  const { t } = useI18n()
  const [username, setUsername] = createSignal("codenomad")
  let password!: HTMLInputElement
  const errorId = createUniqueId()
  onCleanup(() => { password.value = "" })
  return <form class="remote-server-signin" onSubmit={event => {
    event.preventDefault()
    if (props.busy || !secretEntryAllowed() || !password.value) return
    const entered = password.value
    password.value = ""
    props.onConnect({ username: username(), password: entered })
  }}>
    <label><span>{t("authRecovery.username")}</span>
      <input class="selector-input" autocomplete="username" value={username()}
        onInput={event => setUsername(event.currentTarget.value)} disabled={props.busy || !secretEntryAllowed()} />
    </label>
    <label><span>{t("authRecovery.password")}</span>
      <input class="selector-input" ref={password} type="password" autocomplete="current-password" data-remote-password
        readonly={props.busy} disabled={!secretEntryAllowed()} aria-invalid={props.error ? "true" : undefined}
        aria-describedby={props.error ? errorId : undefined} />
    </label>
    <button type="submit" class="selector-button selector-button-primary" disabled={props.busy || !secretEntryAllowed()}>{t("authRecovery.signIn")}</button>
    <Show when={!secretEntryAllowed()}><p role="alert" class="server-add-field-error">{t("remoteBrowse.secretEntryForbidden")}</p></Show>
    <Show when={props.error}>{key => <p id={errorId} role="alert" class="server-add-field-error">{t(key())}</p>}</Show>
  </form>
}
