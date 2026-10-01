import { createSignal, onCleanup, type Accessor } from "solid-js"
import { serverApi } from "../lib/api-client"
import { invalidateFilesystemCaches } from "../lib/filesystem-events"
import { showToastNotification } from "../lib/notifications"
import { showConfirmDialog } from "../stores/alerts"
import type { FilePreviewTarget } from "../stores/files-preview"

// Retain unsaved text when the reader closes or another file/session is opened.
// Only dirty files live here; saved content remains in the ordinary lazy reader.
const drafts = new Map<string, { original: string; text: string }>()
// A clean revert during an outstanding write becomes dirty against its new
// baseline. Retain it even if the reader closes before that write completes.
const pendingWrites = new Map<string, number>()
export const decodeWorkspaceText = (result: { encoding?: string; contents: string }) => result.encoding === "base64"
  ? new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(result.contents), char => char.charCodeAt(0)))
  : result.contents

export function useWorkspaceFileEditor(options: {
  instanceId: string; target: Accessor<FilePreviewTarget>; active: Accessor<boolean>
  t: (key: string, vars?: Record<string, any>) => string; onError: (message: string) => void
}) {
  const [text, setText] = createSignal("")
  const [original, setOriginal] = createSignal<string | undefined>()
  const [saving, setSaving] = createSignal(false)
  const dirty = () => original() !== undefined && text() !== original()
  const key = () => JSON.stringify([options.instanceId, options.target().directory, options.target().path])
  let generation = 0, disposed = false
  onCleanup(() => { disposed = true; generation += 1 })
  function reset() {
    generation += 1
    setSaving(false)
    const draft = drafts.get(key())
    setOriginal(draft?.original)
    setText(draft?.text ?? "")
    return draft?.text
  }
  function adopt(value: string) { setOriginal(value); setText(value) }
  function change(value: string) {
    setText(value)
    if (original() === undefined) return
    if (dirty() || pendingWrites.has(key())) drafts.set(key(), { original: original()!, text: value })
    else drafts.delete(key())
  }
  function discard() { drafts.delete(key()); setOriginal(undefined) }
  async function save(value = text()) {
    if (saving() || !options.active() || original() === undefined || !dirty()) return
    const target = options.target(), identity = key(), version = generation, baseline = original()
    const current = () => !disposed && version === generation && target === options.target() && options.active()
    setSaving(true)
    pendingWrites.set(identity, (pendingWrites.get(identity) ?? 0) + 1)
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
      if (latest && latest.text !== value) drafts.set(identity, { original: value, text: latest.text })
      else drafts.delete(identity)
      if (current()) {
        setOriginal(value)
        showToastNotification({ message: options.t("instanceShell.rightPanel.toast.saveSuccess"), variant: "success" })
      }
      invalidateFilesystemCaches(options.instanceId)
    } catch (error) {
      if (current()) options.onError(error instanceof Error ? error.message : options.t("instanceShell.rightPanel.toast.saveError"))
    } finally {
      const remaining = pendingWrites.get(identity)! - 1
      if (remaining) pendingWrites.set(identity, remaining)
      else {
        pendingWrites.delete(identity)
        const draft = drafts.get(identity)
        if (draft?.text === draft?.original) drafts.delete(identity)
      }
      if (!disposed && generation === version) setSaving(false)
    }
  }
  return { text, dirty, saving, reset, adopt, change, discard, save }
}
