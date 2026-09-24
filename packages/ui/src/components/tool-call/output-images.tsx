import { createMemo, createSignal, For, Show } from "solid-js"
import type { ToolFileContent } from "@opencode/client"
import type { ToolState } from "../../types/tool-state"
import { isToolImageContent, toolImageSource } from "../../lib/tool-content"
import { useI18n } from "../../lib/i18n"

function OutputImage(props: { file: ToolFileContent; index: number; onContentRendered?: () => void }) {
  const { t } = useI18n()
  const source = createMemo(() => toolImageSource(props.file))
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
export function ToolOutputImages(props: { state?: ToolState; onContentRendered?: () => void }) {
  const images = createMemo(() => props.state?.status === "completed" && Array.isArray(props.state.content)
    ? props.state.content.filter(isToolImageContent) : [])
  return <Show when={images().length}>
    <div class="tool-call-output-images">
      <For each={images()}>{(file, index) => <OutputImage file={file} index={index()} onContentRendered={props.onContentRendered} />}</For>
    </div>
  </Show>
}
