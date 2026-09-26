import { Show, Suspense, createEffect, createSignal, lazy, on, onCleanup } from "solid-js"
import { ArrowLeft, WrapText } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { useTheme } from "../lib/theme"
import { serverApi } from "../lib/api-client"
import { backgroundReads } from "../lib/background-read-queue"
import { createDebouncedRefresh, filesystemInvalidationVersion } from "../lib/filesystem-events"
import type { FilePreviewTarget } from "../stores/files-preview"
import { Markdown } from "./markdown"
import { writeClientLayoutValue } from "../stores/client-state"
import { readStoredEnum, RIGHT_PANEL_FILES_WORD_WRAP_KEY } from "./instance/shell/storage"

const MonacoFileViewer = lazy(() => import("./file-viewer/monaco-file-viewer").then(module => ({ default: module.MonacoFileViewer })))
const imageTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp", avif: "image/avif" }

export function WorkspaceFileView(props: { instanceId: string; target: FilePreviewTarget; active: boolean; onClose: () => void }) {
  const { t } = useI18n(), { isDark } = useTheme()
  const [content, setContent] = createSignal<{ text?: string; image?: string; binary?: boolean } | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [source, setSource] = createSignal(false)
  const [wrap, setWrap] = createSignal(readStoredEnum(RIGHT_PANEL_FILES_WORD_WRAP_KEY, ["on", "off"] as const) === "on")
  createEffect(() => writeClientLayoutValue(RIGHT_PANEL_FILES_WORD_WRAP_KEY, wrap() ? "on" : "off"))
  let controller: AbortController | undefined
  let pending = false
  const markdown = () => /\.(md|markdown)$/i.test(props.target.path)
  async function load() {
    if (!props.active) return
    if (loading()) { pending = true; return }
    const request = controller = new AbortController(), target = props.target
    setLoading(true)
    setError(null)
    try {
      const result = await backgroundReads.run(request.signal,
        () => serverApi.previewWorkspaceFile(props.instanceId, target.path, target.directory, request.signal), "visible")
      if (request.signal.aborted) return
      const mime = imageTypes[target.path.split(".").pop()!.toLowerCase()]
      if (mime && result.encoding === "base64") setContent({ image: `data:${mime};base64,${result.contents}` })
      else {
        try {
          const text = result.encoding === "base64"
            ? new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(result.contents), character => character.charCodeAt(0)))
            : result.contents
          setContent(text.includes("\0") ? { binary: true } : { text })
        } catch { setContent({ binary: true }) }
      }
    } catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (controller === request) {
        setLoading(false)
        if (pending) { pending = false; void load() }
      }
    }
  }
  function cancel() { controller?.abort(); controller = undefined; pending = false; setLoading(false) }
  createEffect(on(() => props.target, () => { cancel(); setContent(null); setError(null); setSource(false); void load() }))
  createEffect(on(() => props.active, active => { if (!active) cancel(); else void load() }, { defer: true }))
  const refresh = createDebouncedRefresh(() => void load())
  createEffect(on(() => filesystemInvalidationVersion(props.instanceId), () => { if (props.active) refresh.trigger() }, { defer: true }))
  onCleanup(() => { cancel(); refresh.cancel() })
  return <section class="git-diff-view workspace-file-view" aria-label={t("filesPanel.viewer")}>
    <header class="window-header git-diff-header">
      <button class="files-header-icon-button" aria-label={t("gitPanel.backChat")} title={t("gitPanel.backChat")} onClick={props.onClose}><ArrowLeft size={16} /></button>
      <div class="git-diff-heading"><strong title={props.target.path}>{props.target.path}</strong>
        <span title={props.target.directory}>{props.target.directory} · {t("filesPanel.readOnly")}</span></div>
      <button class="file-viewer-toolbar-button" disabled={loading()} onClick={() => void load()}>{t("instanceShell.rightPanel.actions.refresh")}</button>
      <Show when={markdown() && content()?.text !== undefined}>
        <button class="file-viewer-toolbar-button" onClick={() => setSource(!source())}>{t(source() ? "instanceShell.filesShell.previewMarkdown" : "instanceShell.filesShell.showSource")}</button>
      </Show>
      <Show when={content()?.text !== undefined && (!markdown() || source())}>
        <button class="files-header-icon-button icon-toggle" aria-label={t(wrap() ? "instanceShell.filesShell.disableWordWrap" : "instanceShell.filesShell.enableWordWrap")} aria-pressed={wrap()} onClick={() => setWrap(!wrap())}><WrapText size={16} /></button>
      </Show>
    </header>
    <Show when={error()}><div class="p-3 text-error" role="alert">{error()} <button onClick={() => void load()}>{t("instanceShell.rightPanel.actions.refresh")}</button></div></Show>
    <Show when={loading() && !content()}><p class="p-3 text-secondary">{t("instanceInfo.loading")}</p></Show>
    <Show when={content()}>{value => <>
      <Show when={value().image}>{url => <div class="workspace-image"><img src={url()} alt={props.target.path} /></div>}</Show>
      <Show when={value().binary}><div class="p-3 text-secondary">{t("filesPanel.binary")}</div></Show>
      <Show when={value().text !== undefined}>
        <Show when={markdown() && !source()} fallback={<div class="git-diff-content"><Suspense>
          <MonacoFileViewer scopeKey={`${props.instanceId}:${props.target.slug}:workspace-readonly`} path={props.target.path} content={value().text!} wordWrap={wrap() ? "on" : "off"} readOnly />
        </Suspense></div>}>
          <div class="workspace-markdown"><Markdown part={{ type: "text", text: value().text! }} isDark={isDark()} escapeRawHtml /></div>
        </Show>
      </Show>
    </>}</Show>
  </section>
}
