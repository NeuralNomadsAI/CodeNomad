import { Show, Suspense, createEffect, createSignal, lazy, on, onCleanup } from "solid-js"
import { ArrowLeft, WrapText } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { serverApi } from "../lib/api-client"
import { backgroundReads } from "../lib/background-read-queue"
import { createDebouncedRefresh, filesystemInvalidationVersion } from "../lib/filesystem-events"
import type { FilePreviewTarget } from "../stores/files-preview"
import DiffToolbar from "./instance/shell/right-panel/components/DiffToolbar"
import type { DiffViewMode, DiffContextMode } from "./instance/shell/right-panel/types"
import { writeClientLayoutValue } from "../stores/client-state"
import { readStoredEnum, RIGHT_PANEL_CHANGES_DIFF_VIEW_MODE_KEY, RIGHT_PANEL_CHANGES_DIFF_CONTEXT_MODE_KEY, RIGHT_PANEL_CHANGES_DIFF_WORD_WRAP_KEY } from "./instance/shell/storage"

const MonacoDiffViewer = lazy(() => import("./file-viewer/monaco-diff-viewer").then(module => ({ default: module.MonacoDiffViewer })))

export function GitDiffView(props: { instanceId: string; target: FilePreviewTarget; active: boolean; onClose: () => void; onInsertComment?: (text: string) => void }) {
  const { t } = useI18n()
  const [content, setContent] = createSignal<{ before: string; after: string } | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [view, setView] = createSignal<DiffViewMode>(readStoredEnum(RIGHT_PANEL_CHANGES_DIFF_VIEW_MODE_KEY, ["unified", "split"] as const) ?? "unified")
  const [context, setContext] = createSignal<DiffContextMode>(readStoredEnum(RIGHT_PANEL_CHANGES_DIFF_CONTEXT_MODE_KEY, ["collapsed", "expanded"] as const) ?? "collapsed")
  const [wrap, setWrap] = createSignal(readStoredEnum(RIGHT_PANEL_CHANGES_DIFF_WORD_WRAP_KEY, ["on", "off"] as const) !== "off")
  createEffect(() => writeClientLayoutValue(RIGHT_PANEL_CHANGES_DIFF_VIEW_MODE_KEY, view()))
  createEffect(() => writeClientLayoutValue(RIGHT_PANEL_CHANGES_DIFF_CONTEXT_MODE_KEY, context()))
  createEffect(() => writeClientLayoutValue(RIGHT_PANEL_CHANGES_DIFF_WORD_WRAP_KEY, wrap() ? "on" : "off"))
  let controller: AbortController | undefined
  let pending = false

  async function load() {
    if (!props.active) return
    if (loading()) { pending = true; return }
    const request = controller = new AbortController(), target = props.target
    setLoading(true)
    setError(null)
    try {
      const result = await backgroundReads.run<{ before: string; after: string; isBinary?: boolean }>(request.signal, () => target.commit
        ? serverApi.fetchGitCommitDiff(props.instanceId, target.slug, target.commit, target.path, request.signal)
        : serverApi.fetchWorktreeGitDiff(props.instanceId, target.slug, {
          path: target.path, originalPath: target.originalPath, scope: target.scope ?? "unstaged",
        }, request.signal), "visible")
      if (request.signal.aborted) return
      if (result.isBinary) { setContent(null); setError(t("instanceShell.gitChanges.binaryViewer")) }
      else setContent(result)
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
  createEffect(on(() => props.target, () => { cancel(); setContent(null); setError(null); void load() }))
  createEffect(on(() => props.active, active => { if (!active) cancel(); else void load() }, { defer: true }))
  const refresh = createDebouncedRefresh(() => void load())
  createEffect(on(() => filesystemInvalidationVersion(props.instanceId), () => {
    if (props.active && !props.target.commit) refresh.trigger()
  }, { defer: true }))
  onCleanup(() => { cancel(); refresh.cancel() })

  function insertContext(selection: { startLine: number; endLine: number }) {
    if (!props.active) return
    const revision = props.target.commit ? `Commit: ${props.target.commit} : ` : ""
    props.onInsertComment?.(`Git Diff: ${revision}File: ${props.target.path} : ${selection.startLine}-${selection.endLine}`)
  }

  return <section class="git-diff-view" aria-label={t("gitPanel.diff")}>
    <header class="window-header git-diff-header">
      <button class="files-header-icon-button" aria-label={t("gitPanel.backChat")} title={t("gitPanel.backChat")} onClick={props.onClose}><ArrowLeft size={16} /></button>
      <div class="git-diff-heading">
        <strong title={props.target.path}>{props.target.path}</strong>
        <span title={props.target.directory}>{props.target.slug} · {props.target.commit
          ? `${props.target.commit.slice(0, 8)} · ${props.target.subject ?? ""} · ${t("gitPanel.parentDiff")}`
          : t(props.target.scope === "staged" ? "instanceShell.gitChanges.sections.staged" : "instanceShell.gitChanges.sections.unstaged")}</span>
      </div>
      <DiffToolbar viewMode={view()} contextMode={context()} onViewModeChange={setView} onContextModeChange={setContext} />
      <button class="files-header-icon-button icon-toggle" aria-label={t(wrap() ? "instanceShell.filesShell.disableWordWrap" : "instanceShell.filesShell.enableWordWrap")} aria-pressed={wrap()} onClick={() => setWrap(!wrap())}><WrapText size={16} /></button>
    </header>
    <Show when={error()}><div class="p-3 text-error" role="alert">{error()} <button onClick={() => void load()}>{t("instanceShell.rightPanel.actions.refresh")}</button></div></Show>
    <Show when={loading() && !content()}><div class="p-3 text-secondary">{t("instanceInfo.loading")}</div></Show>
    <Show when={content()}>{value => <div class="git-diff-content">
      <Suspense fallback={<div class="p-3">{t("instanceInfo.loading")}</div>}>
        <MonacoDiffViewer scopeKey={`${props.instanceId}:${props.target.slug}:${props.target.commit ?? props.target.scope}`} path={props.target.path}
          onRequestInsertContext={insertContext} insertContextLabel={t("instanceShell.gitChanges.actions.insertContext")}
          before={value().before} after={value().after} viewMode={view()} contextMode={context()} wordWrap={wrap() ? "on" : "off"} />
      </Suspense>
    </div>}</Show>
  </section>
}
