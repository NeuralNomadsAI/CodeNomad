import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { hexCaptureAvailable } from "../../lib/hex-capture"
import type { DeviceSpeechSnapshot, SpeechEngine } from "../../lib/native/device-speech"
import type { useDeviceSpeechSettings } from "./use-device-speech-settings"

export function deviceHexLabel(snapshot: DeviceSpeechSnapshot | undefined) {
  if (!hexCaptureAvailable()) return "settings.speech.device.hexUnavailable"
  switch (snapshot?.hex.state) {
    case "needsPreparation": return "settings.speech.device.hexNeedsPreparation"
    case "ready": return "settings.speech.device.hex"
    default: return "settings.speech.device.hexUnavailable"
  }
}

export function DeviceSpeechSettings(props: { speech: ReturnType<typeof useDeviceSpeechSettings> }) {
  const { t, locale } = useI18n()
  const speech = props.speech
  const planId = createUniqueId()
  const totalId = createUniqueId()
  let engineSelect: HTMLSelectElement | undefined
  const [removedFocus, setRemovedFocus] = createSignal<HTMLButtonElement>()
  const hex = () => speech.snapshot()?.hex
  const plan = () => {
    const capability = hex()
    return capability?.state === "needsPreparation" && hexCaptureAvailable() ? capability.plan : undefined
  }
  const downloadBytes = createMemo(() => plan()?.missing.reduce((total, part) => total + part.downloadBytes, 0) ?? 0)
  const formatSize = (bytes: number) => {
    const [unit, divisor] = bytes >= 1e6 ? ["megabyte", 1e6] : bytes >= 1e3 ? ["kilobyte", 1e3] : ["byte", 1]
    return new Intl.NumberFormat(locale(), { style: "unit", unit, maximumFractionDigits: 2 })
      .format(Math.ceil(bytes / divisor * 100) / 100)
  }
  const isolatedSize = (bytes: number) => `\u2068${formatSize(bytes)}\u2069`
  const selected = () => speech.snapshot()?.engine ?? ""
  const hexKey = () => deviceHexLabel(speech.snapshot())
  const errorKey = () => {
    switch (speech.error()) {
      case "planChanged": return "settings.speech.device.planChanged"
      case "busy": return "settings.speech.device.busy"
      default: return "settings.speech.device.failed"
    }
  }
  const phaseText = () => {
    const phase = speech.phase()
    return phase ? t(phase.state === "downloading" ? "settings.speech.device.progress" : `settings.speech.device.${phase.state}`) : ""
  }
  const transferred = () => {
    const phase = speech.phase()
    return phase?.state === "downloading" && downloadBytes() > 0
      ? { bytes: Math.min(downloadBytes(), phase.downloadedBytes) } : undefined
  }
  const statusText = () => speech.reading() && !speech.snapshot() ? t("settings.speech.status.loading") : phaseText()

  createEffect(() => {
    const source = removedFocus()
    if (!source || speech.reading()) return
    setRemovedFocus(undefined)
    if (!source.isConnected && engineSelect?.isConnected && !engineSelect.disabled
      && document.hasFocus() && document.activeElement === document.body) engineSelect.focus({ preventScroll: true })
  })

  return (
    <>
      <Show when={speech.snapshot()}>
        <label class="settings-toggle-row settings-toggle-row-compact">
          <span class="settings-toggle-title">{t("settings.speech.device.engine")}</span>
          <select
            class="selector-input w-full min-w-0 sm:max-w-[24rem]"
            ref={element => {
              engineSelect = element
              createEffect(() => { element.value = selected() })
            }}
            disabled={!speech.canChange()}
            onChange={event => {
              const engine = event.currentTarget.value as SpeechEngine
              event.currentTarget.value = selected()
              void speech.select(engine)
            }}
          >
            <Show when={speech.snapshot()?.engine === null}>
              <option value="" disabled>{t("settings.voice.unavailable")}</option>
            </Show>
            <option value="api">{t("settings.speech.device.api")}</option>
            <option value="hex" disabled={hexKey() !== "settings.speech.device.hex"}>{t(hexKey())}</option>
          </select>
        </label>
      </Show>
      <Show when={plan()}>
        {currentPlan => {
          let activation: HTMLButtonElement | undefined
          onCleanup(() => {
            if (activation && activation === document.activeElement && document.hasFocus()
              && hex()?.state === "ready" && speech.snapshot()?.engine === "hex") setRemovedFocus(activation)
          })
          return (
            <div class="settings-toggle-row settings-toggle-row-compact">
              <div class="min-w-0">
                <div id={totalId} class="settings-toggle-title">
                  {t("settings.speech.device.download", { size: formatSize(downloadBytes()) })}
                </div>
                <ul id={planId} class="settings-inline-note">
                  <For each={currentPlan().missing}>{part =>
                    <li>{t(`settings.speech.device.component.${part.component}`)} · {formatSize(part.downloadBytes)}</li>
                  }</For>
                </ul>
              </div>
              <div class="flex min-w-0 flex-col gap-2">
                <button
                  type="button"
                  ref={activation}
                  classList={{
                    "selector-button w-auto": true,
                    "selector-button-primary": !speech.phase(),
                    "selector-button-secondary": Boolean(speech.phase()),
                  }}
                  aria-describedby={speech.phase() ? undefined : `${totalId} ${planId}`}
                  aria-disabled={speech.phase()?.state === "stopping" || (!speech.phase() && !speech.canChange())}
                  onClick={() => {
                    if (speech.phase()) speech.cancel()
                    else void speech.prepare(currentPlan())
                  }}
                >
                  {t(speech.phase() ? "settings.speech.device.cancel"
                    : speech.resume() ? "settings.speech.device.resume" : "settings.speech.device.activate")}
                </button>
                <Show when={transferred()}>
                  {done => <>
                    <progress class="w-full" aria-label={t("settings.speech.device.progress")} max={downloadBytes()}
                      value={done().bytes} />
                    <span class="settings-inline-note">
                      {t("settings.speech.device.downloading", { done: isolatedSize(done().bytes), total: isolatedSize(downloadBytes()) })}
                    </span>
                  </>}
                </Show>
              </div>
            </div>
          )
        }}
      </Show>
      <div role="status" aria-atomic="true" classList={{ "settings-inline-note": Boolean(statusText()) }}>
        {statusText()}
      </div>
      <Show when={speech.readFailed()} fallback={
        <Show when={speech.error()}>
          <div class="settings-inline-note" role="alert">{t(errorKey())}</div>
        </Show>
      }>
        <div class="settings-toolbar-inline">
          <span class="settings-inline-note" role="alert">{t("settings.speech.device.readFailed")}</span>
          <button type="button" class="selector-button selector-button-secondary w-auto" disabled={speech.reading()}
            onClick={() => void speech.refresh()}>{t("settings.speech.device.retry")}</button>
        </div>
      </Show>
    </>
  )
}
