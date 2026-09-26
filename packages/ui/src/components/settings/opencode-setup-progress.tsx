import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { Loader2 } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import { openCodeSetupAction, openCodeSetupPhase, openCodeSetupStartedAt } from "../../stores/opencode-setup"

export function OpenCodeSetupProgress() {
  const { t } = useI18n()
  const [seconds, setSeconds] = createSignal(0)
  createEffect(() => {
    const started = openCodeSetupStartedAt()
    if (started === undefined) return
    const update = () => setSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000)))
    update()
    const timer = window.setInterval(update, 1000)
    onCleanup(() => window.clearInterval(timer))
  })
  const elapsed = () => `${Math.floor(seconds() / 60)}:${String(seconds() % 60).padStart(2, "0")}`
  const label = () => openCodeSetupPhase() === "check" ? "settings.opencode.update.checking"
    : `settings.opencode.setup.progress.${openCodeSetupPhase()}`
  return <Show when={openCodeSetupPhase()}>
    <div class="opencode-setup-progress">
      <div class="opencode-setup-progress-heading" role="status">
        <Loader2 class="w-5 h-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <strong>{t(label())}</strong>
      </div>
      <p class="settings-toggle-caption" role="timer" aria-live="off">{t("settings.opencode.setup.elapsed", { elapsed: elapsed() })}</p>
      <Show when={openCodeSetupAction() === "install"}>
        <p>{t("settings.opencode.setup.keepOpen")}</p>
      </Show>
    </div>
  </Show>
}
