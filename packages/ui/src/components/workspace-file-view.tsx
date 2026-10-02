import { Show, Suspense, createEffect, createSignal, lazy, on, onCleanup } from "solid-js"
import { Save, WrapText, X } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { useTheme } from "../lib/theme"
import { serverApi } from "../lib/api-client"
import { previewReads } from "../lib/background-read-queue"
import { loadMonaco } from "../lib/monaco/setup"
import { createDebouncedRefresh, filesystemInvalidationVersion } from "../lib/filesystem-events"
import type { FilePreviewTarget } from "../stores/files-preview"
import { Markdown } from "./markdown"
import { writeClientLayoutValue } from "../stores/client-state"
import { readStoredEnum, RIGHT_PANEL_FILES_WORD_WRAP_KEY } from "./instance/shell/storage"
import { decodeWorkspaceText, useWorkspaceFileEditor } from "./workspace-file-editor"
import { showConfirmDialog } from "../stores/alerts"

const MonacoFileViewer = lazy(() => import("./file-viewer/monaco-file-viewer").then(module => ({ default: module.MonacoFileViewer })))
const imageTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp", avif: "image/avif" }

export function WorkspaceFileView(props: { instanceId: string; target: FilePreviewTarget; active: boolean; onClose: () => void }) {
  const { t } = useI18n(), { isDark } = useTheme()
  const [content, setContent] = createSignal<{ text?: string; image?: string; binary?: boolean } | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [source, setSource] = createSignal(false)
  const [wrap, setWrap] = createSignal(readStoredEnum(RIGHT_PANEL_FILES_WORD_WRAP_KEY, ["on", "off"] as const) === "on")
  const editor = useWorkspaceFileEditor({ instanceId: props.instanceId, target: () => props.target, active: () => props.active, t, onError: setError })
  createEffect(() => writeClientLayoutValue(RIGHT_PANEL_FILES_WORD_WRAP_KEY, wrap() ? "on" : "off"))
  let controller: AbortController | undefined
  let pending = false
  const markdown = () => /\.(md|markdown)$/i.test(props.target.path)
  async function load() {
    if (!props.active || editor.dirty() || editor.saving()) return
    if (loading()) { pending = true; return }
    const request = controller = new AbortController(), target = props.target
    if (!markdown() && !imageTypes[target.path.split(".").pop()!.toLowerCase()]) void loadMonaco().catch(() => {})
    setLoading(true)
    setError(null)
    try {
      const result = await previewReads.run(request.signal,
        () => serverApi.previewWorkspaceFile(props.instanceId, target.path, target.directory, request.signal), "visible")
      if (request.signal.aborted || editor.dirty() || editor.saving()) return
      const mime = imageTypes[target.path.split(".").pop()!.toLowerCase()]
      if (mime && result.encoding === "base64") setContent({ image: `data:${mime};base64,${result.contents}` })
      else {
        try {
          const text = decodeWorkspaceText(result)
          if (text.includes("\0")) setContent({ binary: true })
          else { editor.adopt(text); setContent({ text }) }
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
  createEffect(on(() => props.target, () => {
    cancel(); setContent(null); setError(null); setSource(false)
    const draft = editor.reset()
    if (draft !== undefined) setContent({ text: draft })
    else void load()
  }))
  createEffect(on(() => props.active, active => { if (!active) cancel(); else void load() }, { defer: true }))
  const refresh = createDebouncedRefresh(() => void load())
  createEffect(on(() => filesystemInvalidationVersion(props.instanceId), () => { if (props.active) refresh.trigger() }, { defer: true }))
  onCleanup(() => { cancel(); refresh.cancel() })
  async function explicitRefresh() {
    const target = props.target
    if (editor.dirty()) {
      const confirmed = await showConfirmDialog(t("instanceShell.rightPanel.actions.refreshDirty.message"), {
        variant: "warning", confirmLabel: t("instanceShell.rightPanel.actions.refreshDirty.confirmLabel"), cancelLabel: t("instanceShell.rightPanel.actions.refreshDirty.cancelLabel"),
      })
      if (!confirmed || target !== props.target || !props.active) return
      editor.discard()
    }
    await load()
  }
  return <section class="git-diff-view workspace-file-view" aria-label={t("filesPanel.viewer")}>
    <header class="window-header git-diff-header">
      <div class="git-diff-heading"><strong title={props.target.path}>{props.target.path}</strong>
        <span title={props.target.directory}>{props.target.directory}<Show when={editor.dirty()}> · ●</Show><Show when={content()?.text === undefined}> · {t("filesPanel.readOnly")}</Show></span></div>
      <button class="file-viewer-toolbar-button" disabled={loading() || editor.saving()} onClick={() => void explicitRefresh()}>{t("instanceShell.rightPanel.actions.refresh")}</button>
      <Show when={markdown() && content()?.text !== undefined}>
        <button class="file-viewer-toolbar-button" onClick={() => setSource(!source())}>{t(source() ? "instanceShell.filesShell.previewMarkdown" : "instanceShell.filesShell.showSource")}</button>
      </Show>
      <Show when={content()?.text !== undefined && (!markdown() || source())}>
        <button class="files-header-icon-button" aria-label={t("instanceShell.rightPanel.actions.save")} title={t("instanceShell.rightPanel.actions.save")} disabled={!editor.dirty() || editor.saving()} onClick={() => void editor.save()}><Save size={16} /></button>
        <button class="files-header-icon-button icon-toggle" aria-label={t(wrap() ? "instanceShell.filesShell.disableWordWrap" : "instanceShell.filesShell.enableWordWrap")} aria-pressed={wrap()} onClick={() => setWrap(!wrap())}><WrapText size={16} /></button>
      </Show>
      <button class="files-header-icon-button" aria-label={t("gitPanel.backChat")} title={t("gitPanel.backChat")} onClick={props.onClose}><X size={16} /></button>
    </header>
    <Show when={error()}><div class="p-3 text-error" role="alert">{error()} <button onClick={() => void explicitRefresh()}>{t("instanceShell.rightPanel.actions.refresh")}</button></div></Show>
    <Show when={loading() && !content()}><p class="p-3 text-secondary">{t("instanceInfo.loading")}</p></Show>
    <Show when={content()}>{value => <>
      <Show when={value().image}>{url => <div class="workspace-image"><img src={url()} alt={props.target.path} /></div>}</Show>
      <Show when={value().binary}><div class="p-3 text-secondary">{t("filesPanel.binary")}</div></Show>
      <Show when={value().text !== undefined}>
        <Show when={markdown() && !source()} fallback={<div class="git-diff-content"><Suspense>
          <MonacoFileViewer scopeKey={`${props.instanceId}:${props.target.directory}:workspace-editor`} path={props.target.path} content={editor.text()} wordWrap={wrap() ? "on" : "off"} onContentChange={editor.change} onSave={value => void editor.save(value)} />
        </Suspense></div>}>
          <div class="workspace-markdown"><Markdown part={{ type: "text", text: editor.text() }} isDark={isDark()} escapeRawHtml /></div>
        </Show>
      </Show>
    </>}</Show>
  </section>
}
