import { createSignal, onCleanup, type Accessor, type Setter } from "solid-js"
import { serverApi } from "../lib/api-client"
import { invalidateFilesystemCaches } from "../lib/filesystem-events"
import { showToastNotification } from "../lib/notifications"
import { showConfirmDialog } from "../stores/alerts"
import type { FilePreviewTarget } from "../stores/files-preview"

// Retain unsaved text when the reader closes or another file/session is opened.
// Readers of the same draft share its baseline and pending-write state, so a
// reopened reader cannot reload over a revert before the old save completes.
type DraftValue = { original: string; text: string; pending: boolean }
type Draft = { value: Accessor<DraftValue>; update: Setter<DraftValue> }
const drafts = new Map<string, Draft>()
function createDraft(original: string, text: string): Draft {
  const [value, update] = createSignal<DraftValue>({ original, text, pending: false })
  return { value, update }
}
export const decodeWorkspaceText = (result: { encoding?: string; contents: string }) => result.encoding === "base64"
  ? new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(result.contents), char => char.charCodeAt(0)))
  : result.contents

export function useWorkspaceFileEditor(options: {
  instanceId: string; target: Accessor<FilePreviewTarget>; active: Accessor<boolean>
  t: (key: string, vars?: Record<string, any>) => string; onError: (message: string) => void
}) {
  const [localText, setText] = createSignal("")
  const [localOriginal, setOriginal] = createSignal<string | undefined>()
  const [localSaving, setSaving] = createSignal(false)
  const [draft, setDraft] = createSignal<Draft>()
  const text = () => draft()?.value().text ?? localText()
  const original = () => draft()?.value().original ?? localOriginal()
  const saving = () => localSaving() || (draft()?.value().pending ?? false)
  const dirty = () => original() !== undefined && text() !== original()
  const key = () => JSON.stringify([options.instanceId, options.target().directory, options.target().path])
  let generation = 0, disposed = false
  onCleanup(() => { disposed = true; generation += 1 })
  function reset() {
    generation += 1
    setSaving(false)
    const retained = drafts.get(key())
    setDraft(retained)
    setOriginal(retained?.value().original)
    setText(retained?.value().text ?? "")
    return retained?.value().text
  }
  function adopt(value: string) { setDraft(undefined); setOriginal(value); setText(value) }
  function change(value: string) {
    const baseline = original()
    setText(value)
    if (baseline === undefined) return
    const retained = draft() ?? createDraft(baseline, value)
    retained.update(previous => ({ ...previous, text: value }))
    setDraft(retained)
    if (dirty() || retained.value().pending) drafts.set(key(), retained)
    else drafts.delete(key())
  }
  function discard() { drafts.delete(key()); setDraft(undefined); setOriginal(undefined) }
  async function save(value = text()) {
    if (saving() || !options.active() || original() === undefined || !dirty()) return
    const target = options.target(), identity = key(), version = generation, baseline = original()
    const current = () => !disposed && version === generation && target === options.target() && options.active()
    const writing = draft()!
    writing.update(previous => ({ ...previous, pending: true }))
    setSaving(true)
    try {
      // An unavailable conflict check must never silently permit an overwrite.
      const disk = decodeWorkspaceText(await serverApi.previewWorkspaceFile(options.instanceId, target.path, target.directory))
      if (!current()) return
      if (disk !== baseline && disk !== value) {
        const confirmed = await showConfirmDialog(options.t("instanceShell.rightPanel.actions.conflict.message", { path: target.path }), {
          variant: "warning", confirmLabel: options.t("instanceShell.rightPanel.actions.conflict.confirmLabel"),
          cancelLabel: options.t("instanceShell.rightPanel.actions.conflict.cancelLabel"), dismissible: true,
        })
        if (!confirmed || !current()) return
      }
      if (disk !== value) await serverApi.writeWorkspaceFile(options.instanceId, target.path, value, { directory: target.directory })
      const latest = drafts.get(identity)
      if (latest) {
        latest.update(previous => ({ ...previous, original: value }))
        if (latest.value().text === value) drafts.delete(identity)
      }
      if (current()) {
        setOriginal(value)
        showToastNotification({ message: options.t("instanceShell.rightPanel.toast.saveSuccess"), variant: "success" })
      }
      invalidateFilesystemCaches(options.instanceId)
    } catch (error) {
      if (current()) options.onError(error instanceof Error ? error.message : options.t("instanceShell.rightPanel.toast.saveError"))
    } finally {
      writing.update(previous => ({ ...previous, pending: false }))
      const latest = drafts.get(identity)
      if (latest && latest.value().text === latest.value().original && !latest.value().pending) drafts.delete(identity)
      if (!disposed && generation === version) setSaving(false)
    }
  }
  return { text, dirty, saving, reset, adopt, change, discard, save }
}
