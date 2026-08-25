import type { SessionInboxUser } from "@opencode-ai/client"
import { For, Show } from "solid-js"
import { ListEnd, Pencil, Play, Trash2, X } from "lucide-solid"
import { useI18n } from "../lib/i18n"

interface PromptQueueProps {
  items: SessionInboxUser[]
  busyId?: string
  editingId?: string
  onDeliveryChange: (item: SessionInboxUser) => void
  onEdit: (item: SessionInboxUser) => void
  onCancelEdit: () => void
  onRemove: (item: SessionInboxUser) => void
}

export default function PromptQueue(props: PromptQueueProps) {
  const { t } = useI18n()
  const text = (item: SessionInboxUser) => {
    const display = item.payload.metadata?.displayText
    return typeof display === "string" && display ? display : item.payload.text
  }

  return (
    <Show when={props.items.length > 0}>
      <section class="prompt-queue" aria-label={t("promptQueue.title", { count: props.items.length })}>
        <header class="prompt-queue-header">{t("promptQueue.title", { count: props.items.length })}</header>
        <div class="prompt-queue-list">
          <For each={props.items}>{(item) => {
            const busy = () => props.busyId === item.id
            const editing = () => props.editingId === item.id
            const attachmentCount = () => item.payload.files?.length ?? 0
            const deliveryLabel = () => t(`promptQueue.delivery.${item.delivery}`)
            return (
              <div class="prompt-queue-row" data-delivery={item.delivery} data-editing={editing() ? "true" : undefined}>
                <div class="prompt-queue-content">
                  <div class="prompt-queue-meta">
                    <span>{deliveryLabel()}</span>
                    <Show when={attachmentCount() > 0}>
                      <span>{t(`promptQueue.attachments.${attachmentCount() === 1 ? "one" : "other"}`, { count: attachmentCount() })}</span>
                    </Show>
                  </div>
                  <div class="prompt-queue-text" title={text(item)}>{text(item)}</div>
                </div>
                <div class="prompt-queue-actions">
                  <button
                    type="button"
                    disabled={busy()}
                    title={t(item.delivery === "queue" ? "promptQueue.actions.steer" : "promptQueue.actions.queue")}
                    aria-label={t(item.delivery === "queue" ? "promptQueue.actions.steer" : "promptQueue.actions.queue")}
                    onClick={() => props.onDeliveryChange(item)}
                  >
                    <Show when={item.delivery === "queue"} fallback={<ListEnd aria-hidden="true" />}>
                      <Play aria-hidden="true" />
                    </Show>
                  </button>
                  <Show
                    when={!editing()}
                    fallback={
                      <button type="button" disabled={busy()} title={t("promptQueue.actions.cancelEdit")} aria-label={t("promptQueue.actions.cancelEdit")} onClick={props.onCancelEdit}>
                        <X aria-hidden="true" />
                      </button>
                    }
                  >
                    <button type="button" disabled={busy()} title={t("promptQueue.actions.edit")} aria-label={t("promptQueue.actions.edit")} onClick={() => props.onEdit(item)}>
                      <Pencil aria-hidden="true" />
                    </button>
                  </Show>
                  <button type="button" disabled={busy()} title={t("promptQueue.actions.remove")} aria-label={t("promptQueue.actions.remove")} onClick={() => props.onRemove(item)}>
                    <Trash2 aria-hidden="true" />
                  </button>
                </div>
              </div>
            )
          }}</For>
        </div>
      </section>
    </Show>
  )
}
