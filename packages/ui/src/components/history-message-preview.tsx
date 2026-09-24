import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { useI18n } from "../lib/i18n"
import { getRootClient } from "../stores/opencode-client"
import { getOpenCodeInstanceGeneration, getOpenCodeMutationRevision } from "../stores/opencode-data"

// An explicit result click reads only that native message. Keep it outside the
// transcript store so opening historical results cannot displace its window.
export default function HistoryMessagePreview(props: { instanceId: string; sessionId: string; messageId: string }) {
  const { t } = useI18n()
  const [title, setTitle] = createSignal("")
  const [blocks, setBlocks] = createSignal<string[]>([])
  const [pending, setPending] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  createEffect(() => {
    const instanceId = props.instanceId, sessionID = props.sessionId, messageID = props.messageId
    const generation = getOpenCodeInstanceGeneration(instanceId)
    const revision = getOpenCodeMutationRevision(instanceId, sessionID)
    const controller = new AbortController()
    const current = () => !controller.signal.aborted && generation === getOpenCodeInstanceGeneration(instanceId)
      && revision === getOpenCodeMutationRevision(instanceId, sessionID)
    setTitle(""); setBlocks([]); setFailed(false); setPending(true)
    void (async () => {
      const client = getRootClient(instanceId)
      const [session, message] = await Promise.all([
        client.session.get({ sessionID }, { signal: controller.signal }),
        client.session.message.get({ sessionID, messageID }, { signal: controller.signal }),
      ])
      if (!current()) return
      setTitle(session.title ?? sessionID)
      if (message.type === "assistant") {
        setBlocks(message.content.flatMap(part => {
          if (part.type === "text" || part.type === "reasoning") return [part.text]
          if (part.type !== "tool") return []
          return [JSON.stringify({ name: part.name, state: part.state }, null, 2)]
        }))
      } else if ("text" in message) setBlocks([message.text])
      else if (message.type === "shell") setBlocks([message.command, message.output?.output ?? ""])
      else if (message.type === "compaction" && "summary" in message) setBlocks([message.summary])
    })().catch(() => { if (current()) setFailed(true) })
      .finally(() => { if (current()) setPending(false) })
    onCleanup(() => controller.abort())
  })
  return <section class="history-message-preview" aria-live="polite">
    <strong>{title()}</strong>
    <Show when={pending()}><span>{t("messageSection.search.searching")}</span></Show>
    <Show when={failed()}><span role="alert">{t("messageSection.search.failed")}</span></Show>
    <For each={blocks()}>{text => <pre>{text}</pre>}</For>
  </section>
}
