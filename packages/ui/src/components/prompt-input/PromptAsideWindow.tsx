import { createEffect, createSignal, Show } from "solid-js"
import { Copy, Loader2, X } from "lucide-solid"
import DismissibleWindow from "../dismissible-window"
import { Markdown } from "../markdown"
import { copyToClipboard } from "../../lib/clipboard"
import { useI18n } from "../../lib/i18n"
import type { PromptAsideController } from "./usePromptAside"

export default function PromptAsideWindow(props: { id: string; controller: PromptAsideController }) {
  const { t } = useI18n()
  const aside = props.controller
  const [copied, setCopied] = createSignal(false)
  const [copyFailed, setCopyFailed] = createSignal(false)
  let input: HTMLTextAreaElement | undefined
  let closeButton: HTMLButtonElement | undefined
  createEffect(() => {
    aside.answer()
    aside.open()
    setCopied(false)
    setCopyFailed(false)
  })

  return (
    <DismissibleWindow id={props.id} open={aside.open()} onClose={aside.close}
      title={t("promptInput.btw.title")} description={t("promptInput.btw.description")}
      class="session-aside-window" initialFocus={() => aside.pending() ? closeButton : input}>
      <div class="window-header">
        <h2 class="window-title">{t("promptInput.btw.title")}</h2>
        <button ref={closeButton} type="button" class="window-icon-button" aria-label={t("promptInput.btw.close")} onClick={aside.close}><X /></button>
      </div>
      <div class="window-body">
        <p class="session-aside-description">{t("promptInput.btw.description")}</p>
        <form onSubmit={event => { event.preventDefault(); void aside.ask() }}>
          <label class="session-aside-label" for={`${props.id}-question`}>{t("promptInput.btw.question")}</label>
          <textarea ref={input} id={`${props.id}-question`} class="session-aside-question" rows={3}
            value={aside.question()} disabled={aside.pending()}
            onInput={event => aside.setQuestion(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
                event.preventDefault()
                void aside.ask()
              }
            }} />
          <div class="session-aside-actions">
            <Show when={aside.pending()} fallback={
              <button type="submit" class="window-action" disabled={!aside.question().trim()}>{t("promptInput.btw.ask")}</button>
            }>
              <span role="status" class="session-aside-loading"><Loader2 class="animate-spin" size={14} />{t("promptInput.btw.loading")}</span>
              <button type="button" class="window-action" onClick={aside.cancel}>{t("promptInput.btw.cancel")}</button>
            </Show>
          </div>
        </form>
        <Show when={aside.error()}><p role="alert">{aside.error()}</p></Show>
        <Show when={aside.answer()}>
          <section class="session-aside-answer" aria-label={t("promptInput.btw.answer")} tabindex="0">
            <Markdown part={{ type: "text", text: aside.answer() }} escapeRawHtml />
          </section>
        </Show>
      </div>
      <Show when={aside.answer()}>
        <div class="window-footer">
          <Show when={copyFailed()}><span role="alert">{t("promptInput.btw.copyFailed")}</span></Show>
          <button type="button" class="window-action" onClick={async () => {
            const answer = aside.answer()
            const success = await copyToClipboard(answer)
            if (aside.answer() !== answer) return
            setCopied(success)
            setCopyFailed(!success)
          }}><Copy size={14} />{t(copied() ? "promptInput.btw.copied" : "promptInput.btw.copy")}</button>
        </div>
      </Show>
    </DismissibleWindow>
  )
}
