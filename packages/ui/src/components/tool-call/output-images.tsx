import { createMemo, createSignal, For, Show } from "solid-js"
import type { ToolFileContent } from "@opencode/client"
import type { ToolState } from "../../types/tool-state"
import { isToolImageContent, toolImageReference } from "../../lib/tool-content"
import { useI18n } from "../../lib/i18n"
import { createMediaSource } from "../../lib/media-source"
import { blockMediaInteraction } from "../../lib/media-image-interaction"

function OutputImage(props: { file: ToolFileContent; index: number; instanceId: string; onContentRendered?: () => void }) {
  const { t } = useI18n()
  const source = createMediaSource(() => props.instanceId, () => toolImageReference(props.file))
  // Key the error to its URI: a later corrected result must be loadable in place.
  const [failedSource, setFailedSource] = createSignal<string>()
  const name = () => props.file.name?.trim() || t("toolCall.image.label", { number: props.index + 1 })
  return <figure class="tool-call-output-image"
    onContextMenu={event => { if (source.restricted()) blockMediaInteraction(event) }}
    onAuxClick={event => { if (source.restricted()) blockMediaInteraction(event) }}>
    <Show when={source() && failedSource() !== source()} fallback={<p role="status">{t("toolCall.image.unavailable")}</p>}>
      <img src={source()} alt={name()} loading="lazy" decoding="async" referrerpolicy="no-referrer"
        style={source.restricted() ? { "pointer-events": "none" } : undefined} draggable={source.restricted() ? false : undefined}
        onLoad={() => props.onContentRendered?.()}
        onError={() => { setFailedSource(source()); props.onContentRendered?.() }} />
    </Show>
    <figcaption>{name()} <span>{props.file.mime}</span></figcaption>
  </figure>
}

/** Shared by native and MCP tools, including tools with a specialized text renderer. */
export function ToolOutputImages(props: { state?: ToolState; instanceId: string; onContentRendered?: () => void }) {
  const images = createMemo(() => props.state?.status === "completed" && Array.isArray(props.state.content)
    ? props.state.content.filter(isToolImageContent) : [])
  return <Show when={images().length}>
    <div class="tool-call-output-images">
      <For each={images()}>{(file, index) => <OutputImage file={file} index={index()} instanceId={props.instanceId} onContentRendered={props.onContentRendered} />}</For>
    </div>
  </Show>
}
