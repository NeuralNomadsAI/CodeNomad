import { createMemo, createSignal, For, Show } from "solid-js"
import type { ToolFileContent } from "@opencode/client"
import type { ToolState } from "../../types/tool-state"
import { isToolFileContent, isToolImageContent, toolImageSource } from "../../lib/tool-content"
import { useI18n } from "../../lib/i18n"
import { createContentMediaPolicy } from "../../lib/content-media-policy"
import { authorizedMediaSource, restrictedMediaPolicy, type MediaPolicy } from "../../lib/media-policy"
import { CODENOMAD_API_BASE } from "../../lib/api-base"

function OutputFile(props: { file: ToolFileContent; policy: MediaPolicy }) {
  const { t } = useI18n()
  const source = () => authorizedMediaSource(props.file, props.policy, CODENOMAD_API_BASE, false)
  const name = () => props.file.name?.trim() || t("messageItem.attachment.defaultName")
  return <figure class="tool-call-output-image">
    <figcaption>{name()} <span>{props.file.mime}</span></figcaption>
    <Show when={source()} fallback={<p role="status">{t("messageItem.attachment.unavailable")}</p>}>
      <button type="button" class="attachment-download" onClick={() => {
        const href = source()
        if (!href) return
        const anchor = document.createElement("a")
        anchor.href = href
        anchor.download = name()
        anchor.rel = "noopener noreferrer"
        anchor.click()
      }}>{t("messageItem.attachment.downloadAriaLabel", { name: name() })}</button>
    </Show>
  </figure>
}

function OutputImage(props: { file: ToolFileContent; index: number; policy: MediaPolicy; onContentRendered?: () => void }) {
  const { t } = useI18n()
  const source = createMemo(() => toolImageSource(props.file, undefined, props.policy))
  // Key the error to its URI: a later corrected result must be loadable in place.
  const [failedSource, setFailedSource] = createSignal<string>()
  const name = () => props.file.name?.trim() || t("toolCall.image.label", { number: props.index + 1 })
  return <figure class="tool-call-output-image">
    <Show when={source() && failedSource() !== source()} fallback={<p role="status">{t("toolCall.image.unavailable")}</p>}>
      <img src={source()} alt={name()} loading="lazy" decoding="async" referrerpolicy="no-referrer"
        onLoad={() => props.onContentRendered?.()}
        onError={() => { setFailedSource(source()); props.onContentRendered?.() }} />
    </Show>
    <figcaption>{name()} <span>{props.file.mime}</span></figcaption>
  </figure>
}

/** Shared by native and MCP tools, including tools with a specialized text renderer. */
export function ToolOutputImages(props: { state?: ToolState; instanceId?: string; sessionId?: string; onContentRendered?: () => void }) {
  const policy = createContentMediaPolicy(() => props.instanceId, () => props.sessionId, restrictedMediaPolicy)
  const images = createMemo(() => props.state?.status === "completed" && Array.isArray(props.state.content)
    ? props.state.content.filter(isToolFileContent) : [])
  return <Show when={images().length}>
    <div class="tool-call-output-images">
      <For each={images()}>{(file, index) => isToolImageContent(file)
        ? <OutputImage file={file} index={index()} policy={policy()} onContentRendered={props.onContentRendered} />
        : <OutputFile file={file} policy={policy()} />}</For>
    </div>
  </Show>
}
