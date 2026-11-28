import { Show } from "solid-js"
import { useI18n } from "../../lib/i18n"

export default function DictationNotice(props: {
  recordingLimitReached: boolean
  focusDraft: () => void
  onTranscribe: (restoreFocus: boolean) => void
  onCancelRecording: () => void
  transcript?: string
  canInsertTranscript: boolean
  onInsertTranscript: () => void
  onDiscardTranscript: () => void
}) {
  const { t } = useI18n()
  const dismiss = (button: HTMLButtonElement, action: () => void) => {
    if (button === button.ownerDocument.activeElement) props.focusDraft()
    action()
  }
  return <>
    <Show when={props.recordingLimitReached}><div class="composer-notice">
      <div class="composer-notice-text" role="status">{t("promptInput.voiceInput.limitReached")}</div>
      <button type="button" class="window-action composer-notice-action"
        onClick={({ currentTarget }) => props.onTranscribe(currentTarget === currentTarget.ownerDocument.activeElement)}>{t("promptInput.voiceInput.transcribe")}</button>
      <button type="button" class="window-action composer-notice-action" onClick={event => dismiss(event.currentTarget, props.onCancelRecording)}>{t("alertDialog.actions.cancel")}</button>
    </div></Show>
    <Show when={props.transcript}>{text => <div class="composer-notice">
      <div class="composer-notice-text" role="status" aria-live="polite">{t("promptInput.voiceInput.recovery.saved")}</div>
      <div class="composer-notice-text text-xs" dir="auto">{text().slice(0, 200)}</div>
      <button type="button" class="window-action composer-notice-action" disabled={!props.canInsertTranscript}
        title={!props.canInsertTranscript ? t("voice.command.composerUnavailable") : undefined}
        onClick={props.onInsertTranscript}>{t("promptInput.voiceInput.recovery.insert")}</button>
      <button type="button" class="window-action composer-notice-action" onClick={event => dismiss(event.currentTarget, props.onDiscardTranscript)}>{t("promptInput.voiceInput.recovery.discard")}</button>
    </div>}</Show>
  </>
}
