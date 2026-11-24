import { For, Show, type Component } from "solid-js"
import { Expand } from "lucide-solid"
import type { Attachment } from "../../types/attachment"
import { useI18n } from "../../lib/i18n"
import { getInlineFileUsage } from "./device-file-selection"

interface PromptAttachmentsBarProps {
  attachments: Attachment[]
  onRemoveAttachment: (attachmentId: string) => void
  onExpandTextAttachment: (attachmentId: string) => void
}

const PromptAttachmentsBar: Component<PromptAttachmentsBarProps> = (props) => {
  const { t } = useI18n()

  return (
    <div class="flex flex-wrap items-center gap-1.5 border-t px-3 py-2" style="border-color: var(--border-base);">
      <For each={props.attachments}>
        {(attachment) => {
          const isText = attachment.source.type === "text"
          const detail = () => attachment.source.type !== "file" ? undefined : /^data:/i.test(attachment.url)
            ? t("promptInput.attachFiles.deviceDetail", { name: attachment.filename, bytes: getInlineFileUsage([attachment]).bytes })
            : t("promptInput.attachFiles.projectDetail", { path: attachment.source.path })
          return (
            <div class="attachment-chip" title={detail()}>
              <span class="font-mono">{attachment.display}</span>
              <Show when={detail()}><span class="text-xs text-secondary">{detail()}</span></Show>
              <Show when={isText}>
                <button
                  type="button"
                  class="attachment-expand"
                  onClick={() => props.onExpandTextAttachment(attachment.id)}
                  aria-label={t("sessionView.attachments.expandPastedTextAriaLabel")}
                  title={t("sessionView.attachments.insertPastedTextTitle")}
                >
                  <Expand class="h-3 w-3" aria-hidden="true" />
                </button>
              </Show>
              <button
                type="button"
                class="attachment-remove"
                onClick={() => props.onRemoveAttachment(attachment.id)}
                aria-label={t("sessionView.attachments.removeAriaLabel")}
              >
                ×
              </button>
            </div>
          )
        }}
      </For>
    </div>
  )
}

export default PromptAttachmentsBar
