import { createSignal, onCleanup } from "solid-js"
import { useI18n } from "../lib/i18n"

/** Credentials live only in the mounted form and its in-flight connect request. */
export default function RemoteServerSignin(props: {
  busy: boolean
  error: string
  errorId: string
  passwordRef: (input: HTMLInputElement) => void
  onConnect: (credentials: { username: string; password: string }) => void
}) {
  const { t } = useI18n()
  const [username, setUsername] = createSignal("codenomad")
  let password!: HTMLInputElement
  onCleanup(() => { password.value = "" })
  return <form class="remote-server-signin" onSubmit={(event) => {
    event.preventDefault()
    if (props.busy || !password.value) return
    const entered = password.value
    password.value = ""
    props.onConnect({ username: username(), password: entered })
  }}>
    <label class="remote-server-label"><span>{t("authRecovery.username")}</span>
      <input class="selector-input" data-browse-nav aria-label={t("authRecovery.username")} autocomplete="username"
        value={username()} onInput={(event) => setUsername(event.currentTarget.value)} disabled={props.busy} />
    </label>
    <label class="remote-server-label"><span>{t("authRecovery.password")}</span>
      <input class="selector-input" data-browse-nav ref={(input) => { password = input; props.passwordRef(input) }} type="password" autocomplete="current-password"
        aria-label={t("authRecovery.password")} aria-invalid={props.error === "auth" ? true : undefined}
        aria-describedby={props.error === "auth" ? props.errorId : undefined} disabled={props.busy} />
    </label>
    <button type="submit" class="selector-button selector-button-primary" data-browse-nav disabled={props.busy}>{t("authRecovery.signIn")}</button>
  </form>
}
