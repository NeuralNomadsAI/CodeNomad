import { Show, Suspense, createEffect, createSignal, lazy, on, onCleanup } from "solid-js"
import { Save, WrapText, X } from "lucide-solid"
import { previewImageType } from "../lib/preview-image-types"
import { useI18n } from "../lib/i18n"
import { withHotkey } from "../lib/hotkeys"
import { useTheme } from "../lib/theme"
import { backendOf } from "../lib/backend-client"
import { captureBackendOperation } from "../lib/backend-operation"
import { backendEvents } from "../lib/server-events"
import { previewReads } from "../lib/background-read-queue"
import { loadMonaco } from "../lib/monaco/setup"
import { createDebouncedRefresh, filesystemInvalidationVersion } from "../lib/filesystem-events"
import type { FilePreviewTarget } from "../stores/files-preview"
import { Markdown } from "./markdown"
import { MermaidDiagram } from "./mermaid-diagram"
import { writeClientLayoutValue } from "../stores/client-state"
import { readStoredEnum, RIGHT_PANEL_FILES_WORD_WRAP_KEY } from "./instance/shell/storage"
import { decodeWorkspaceText, useWorkspaceFileEditor, workspaceFileFingerprint } from "./workspace-file-editor"
import { showConfirmDialog } from "../stores/alerts"

const MonacoFileViewer = lazy(() => import("./file-viewer/monaco-file-viewer").then(module => ({ default: module.MonacoFileViewer })))
// One light snapshot per live target; releasing a selection releases its view.
const views = new WeakMap<FilePreviewTarget, { source: boolean; scrollTop: number }>()

export function WorkspaceFileView(props: { instanceId: string; target: FilePreviewTarget; active: boolean; onClose: () => void }) {
  const { t } = useI18n(), { isDark } = useTheme()
  const [content, setContent] = createSignal<{ text?: string; image?: string; binary?: boolean } | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [recovering, setRecovering] = createSignal(false)
  const [source, setSource] = createSignal(false)
  const [wrap, setWrap] = createSignal(readStoredEnum(RIGHT_PANEL_FILES_WORD_WRAP_KEY, ["on", "off"] as const) === "on")
  const editor = useWorkspaceFileEditor({ instanceId: props.instanceId, target: () => props.target, active: () => props.active, t, onError: setError, captureOperation: captureBackendOperation })
  createEffect(() => writeClientLayoutValue(RIGHT_PANEL_FILES_WORD_WRAP_KEY, wrap() ? "on" : "off"))
  let controller: AbortController | undefined
  let pending = false
  const markdown = () => /\.(md|markdown)$/i.test(props.target.path)
  const mermaid = () => /\.mmd$/i.test(props.target.path)
  const previewable = () => markdown() || mermaid()
  async function load() {
    if (!props.active || recovering() || (editor.dirty() && !editor.needsVerification()) || editor.saving()) return
    if (loading()) { pending = true; return }
    const request = controller = new AbortController(), target = props.target
    const operation = captureBackendOperation(props.instanceId, request.signal)
    if (!operation.current()) return
    if (!previewable() && !previewImageType(target.path)) void loadMonaco().catch(() => {})
    setLoading(true)
    setError(null)
    try {
      const result = await previewReads.run(operation.signal,
        () => backendOf(props.instanceId).api.previewWorkspaceFile(props.instanceId, target.path, target.directory, operation.signal), "visible")
      if (!operation.current() || target !== props.target || editor.saving()) return
      if (editor.dirty()) {
        if (editor.needsVerification()) {
          const hash = workspaceFileFingerprint(result)
          let text: string | undefined
          try { text = decodeWorkspaceText(result) } catch { /* keep the recovered text */ }
          editor.verify(text, hash)
        }
        return
      }
      const mime = previewImageType(target.path)
      if (mime && result.encoding === "base64") setContent({ image: `data:${mime};base64,${result.contents}` })
      else {
        try {
          const text = decodeWorkspaceText(result)
          if (text.includes("\0")) setContent({ binary: true })
          else { editor.adopt(text, workspaceFileFingerprint(result)); setContent({ text }) }
        } catch { setContent({ binary: true }) }
      }
    } catch (cause) {
      if (operation.current()) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (controller === request) {
        setLoading(false)
        if (pending && operation.current()) { pending = false; void load() }
      }
    }
  }
  function cancel() { controller?.abort(); controller = undefined; pending = false; setLoading(false) }
  createEffect(on(() => props.target, () => {
    const target = props.target
    onCleanup(() => views.set(target, { source: source(), scrollTop: views.get(target)?.scrollTop ?? 0 }))
    cancel(); setContent(null); setError(null); setSource(views.get(props.target)?.source ?? false)
    const draft = editor.reset()
    setRecovering(draft === undefined)
    if (draft !== undefined) {
      setContent({ text: draft })
      void load()
    } else void editor.recover().then(text => {
      if (target !== props.target || disposed) return
      if (text !== undefined) setContent({ text })
      setRecovering(false)
      void load()
    })
  }))
  createEffect(on(() => props.active, active => { if (!active) cancel(); else void load() }, { defer: true }))
  createEffect(on(() => backendEvents.signalForInstance(props.instanceId), signal => {
    cancel()
    if (!signal.aborted) void load()
  }, { defer: true }))
  const refresh = createDebouncedRefresh(() => void load())
  createEffect(on(() => filesystemInvalidationVersion(props.instanceId), () => { if (props.active) refresh.trigger() }, { defer: true }))
  let disposed = false
  onCleanup(() => { disposed = true; cancel(); refresh.cancel() })
  async function explicitRefresh() {
    const target = props.target
    const operation = captureBackendOperation(props.instanceId)
    if (!operation.current()) return
    if (editor.dirty()) {
      const confirmed = await showConfirmDialog(t("instanceShell.rightPanel.actions.refreshDirty.message"), {
        variant: "warning", confirmLabel: t("instanceShell.rightPanel.actions.refreshDirty.confirmLabel"), cancelLabel: t("instanceShell.rightPanel.actions.refreshDirty.cancelLabel"),
      })
      if (!confirmed || !operation.current() || target !== props.target || !props.active) return
      editor.discard()
      setContent(null)
    } else if (!editor.editable()) {
      setRecovering(true)
      setContent(null)
      const draft = await editor.recover()
      if (target !== props.target || disposed) return
      setRecovering(false)
      if (!operation.current()) return
      if (draft !== undefined) setContent({ text: draft })
    }
    await load()
  }
  return <section class="git-diff-view workspace-file-view" aria-label={t("filesPanel.viewer")}>
    <header class="window-header git-diff-header">
      <div class="git-diff-heading"><strong title={props.target.path}>{props.target.path}</strong>
        <span title={props.target.directory}>{props.target.directory}<Show when={editor.dirty()}> · ●</Show><Show when={content()?.text === undefined || !editor.editable()}> · {t("filesPanel.readOnly")}</Show></span></div>
      <button class="file-viewer-toolbar-button" disabled={recovering() || loading() || editor.saving()} onClick={() => void explicitRefresh()}>{t("instanceShell.rightPanel.actions.refresh")}</button>
      <Show when={previewable() && content()?.text !== undefined}>
        <button class="file-viewer-toolbar-button" onClick={() => setSource(!source())}>{t(source() ? mermaid() ? "markdown.mermaid.preview" : "instanceShell.filesShell.previewMarkdown" : "instanceShell.filesShell.showSource")}</button>
      </Show>
      <Show when={content()?.text !== undefined && (!previewable() || source())}>
        <Show when={editor.editable()}>
          <button class="files-header-icon-button" aria-label={t("instanceShell.rightPanel.actions.save")} title={withHotkey(t("instanceShell.rightPanel.actions.save"), "file-save")} disabled={!editor.dirty() || editor.saving()} onClick={() => { setError(null); void editor.save() }}><Save size={16} /></button>
        </Show>
        <button class="files-header-icon-button icon-toggle" aria-label={t(wrap() ? "instanceShell.filesShell.disableWordWrap" : "instanceShell.filesShell.enableWordWrap")} aria-pressed={wrap()} onClick={() => setWrap(!wrap())}><WrapText size={16} /></button>
      </Show>
      <button class="files-header-icon-button" aria-label={t("gitPanel.backChat")} title={t("gitPanel.backChat")} onClick={props.onClose}><X size={16} /></button>
    </header>
    <Show when={error()}><div class="p-3 text-error" role="alert">{error()} <button onClick={() => void explicitRefresh()}>{t("instanceShell.rightPanel.actions.refresh")}</button></div></Show>
    <Show when={editor.conflict() && error() !== t("filesPanel.saveConflict")}><div class="p-3 text-error" role="alert">{t("filesPanel.draftConflict")}</div></Show>
    <Show when={editor.limited()}><div class="p-3 text-error" role="alert">{t("filesPanel.draftLimit")}</div></Show>
    <Show when={(recovering() || loading()) && !content()}><p class="p-3 text-secondary">{t("instanceInfo.loading")}</p></Show>
    <Show when={content()}>{value => <>
      <Show when={value().image}>{url => <div class="workspace-image"><img src={url()} alt={props.target.path} /></div>}</Show>
      <Show when={value().binary}><div class="p-3 text-secondary">{t("filesPanel.binary")}</div></Show>
      <Show when={value().text !== undefined}>
        <Show when={previewable() && !source()} fallback={<div class="git-diff-content"><Suspense>
          <MonacoFileViewer scopeKey={`${props.instanceId}:${props.target.directory}:workspace-editor`} path={props.target.path} content={editor.text()} wordWrap={wrap() ? "on" : "off"} readOnly={!editor.editable()} onContentChange={editor.change} onSave={value => { setError(null); void editor.save(value) }} />
        </Suspense></div>}>
          <Show when={mermaid()} fallback={<div class="workspace-markdown" ref={element => {
            queueMicrotask(() => { if (element.isConnected) element.scrollTop = views.get(props.target)?.scrollTop ?? 0 })
          }} onScroll={event => views.set(props.target, { source: source(), scrollTop: event.currentTarget.scrollTop })}>
            <Markdown instanceId={props.instanceId} part={{ type: "text", text: editor.text() }} isDark={isDark()} escapeRawHtml />
          </div>}>
            <div class="workspace-mermaid"><MermaidDiagram code={editor.text()} isDark={isDark()} showSourceOnError /></div>
          </Show>
        </Show>
      </Show>
    </>}</Show>
  </section>
}
