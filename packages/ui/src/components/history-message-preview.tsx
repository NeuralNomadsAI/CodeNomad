import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { useI18n } from "../lib/i18n"
import { formatRelativeTime } from "../lib/recent-folder-display"
import { openHistoryMatchSession } from "../stores/history-search-sessions"
import { getRootClient } from "../stores/opencode-client"
import { getOpenCodeInstanceGeneration, getOpenCodeMutationRevision } from "../stores/opencode-data"
import { HistoryWorktreeBadge } from "./history-search-results"

// An explicit result click reads only that native message. Keep it outside the
// transcript store so opening historical results cannot displace its window.
export default function HistoryMessagePreview(props: { instanceId: string; sessionId: string; messageId: string }) {
  const { t, locale } = useI18n()
  const [title, setTitle] = createSignal("")
  const [directory, setDirectory] = createSignal<string>()
  const [created, setCreated] = createSignal<number>()
  const [blocks, setBlocks] = createSignal<string[]>([])
  const [pending, setPending] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const [opening, setOpening] = createSignal(false)
  const [openFailed, setOpenFailed] = createSignal(false)
  let target = 0
  onCleanup(() => { target += 1 })
  createEffect(() => {
    const instanceId = props.instanceId, sessionID = props.sessionId, messageID = props.messageId
    const generation = getOpenCodeInstanceGeneration(instanceId)
    const revision = getOpenCodeMutationRevision(instanceId, sessionID)
    const controller = new AbortController()
    const current = () => !controller.signal.aborted && generation === getOpenCodeInstanceGeneration(instanceId)
      && revision === getOpenCodeMutationRevision(instanceId, sessionID)
    target += 1
    setTitle(""); setDirectory(undefined); setCreated(undefined); setBlocks([]); setFailed(false); setPending(true)
    setOpening(false); setOpenFailed(false)
    void (async () => {
      const client = getRootClient(instanceId)
      const [session, message] = await Promise.all([
        client.session.get({ sessionID }, { signal: controller.signal }),
        client.session.message.get({ sessionID, messageID }, { signal: controller.signal }),
      ])
      if (!current()) return
      setTitle(session.title ?? sessionID)
      setDirectory(session.location?.directory)
      setCreated(message.time?.created)
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
  async function open() {
    const opened = target
    const current = () => opened === target
    setOpening(true)
    setOpenFailed(false)
    const result = await openHistoryMatchSession(props.instanceId, props.sessionId, props.messageId, current).catch(() => false)
    if (!current()) return
    setOpening(false)
    setOpenFailed(!result)
  }
  return <section class="history-message-preview" aria-live="polite">
    <div class="history-message-preview-header">
      <strong>{title()}</strong>
      <HistoryWorktreeBadge instanceId={props.instanceId} directory={directory()} />
      <Show when={created()}>{time => <time class="text-xs text-muted" dateTime={new Date(time()).toISOString()}
        title={new Date(time()).toLocaleString(locale())}>{formatRelativeTime(t, time())}</time>}</Show>
      <button type="button" class="button-tertiary history-message-preview-open" disabled={opening()} onClick={() => void open()}>
        {t("history.openSession")}
      </button>
    </div>
    <Show when={pending()}><span>{t("messageSection.search.searching")}</span></Show>
    <Show when={failed()}><span role="alert">{t("messageSection.search.failed")}</span></Show>
    <Show when={openFailed()}><span role="alert">{t("history.openFailed")}</span></Show>
    <For each={blocks()}>{text => <pre>{text}</pre>}</For>
  </section>
}
