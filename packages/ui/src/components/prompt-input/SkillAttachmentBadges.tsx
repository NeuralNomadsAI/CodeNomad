import { For, Show } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { getAttachments, removeAttachment } from "../../stores/attachments"

export default function SkillAttachmentBadges(props: {
  instanceId: string
  sessionId: string
  disabled: boolean
}) {
  const { t } = useI18n()
  const selected = () => getAttachments(props.instanceId, props.sessionId).filter(item => item.source.type === "skill")
  return <Show when={selected().length}><div class="prompt-skill-attachments">
    <For each={selected()}>{item => <button type="button" class="badge-shape selector-button" disabled={props.disabled}
      aria-label={t("promptInput.skills.remove", { name: item.filename })}
      onClick={() => removeAttachment(props.instanceId, props.sessionId, item.id)}>{item.filename} ×</button>}</For>
  </div></Show>
}
