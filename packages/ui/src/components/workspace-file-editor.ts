import { createSignal, onCleanup, type Accessor, type Setter } from "solid-js"
import { backendOf } from "../lib/backend-client"
import { invalidateFilesystemCaches } from "../lib/filesystem-events"
import { showToastNotification } from "../lib/notifications"
import { showConfirmDialog } from "../stores/alerts"
import type { FilePreviewTarget } from "../stores/files-preview"
import type { captureBackendOperation } from "../lib/backend-operation"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { backendIdOf, LOCAL_BACKEND_ID } from "../lib/backend-identity"
import { normalizeWorkspacePath } from "../stores/app-session-reconciliation"
import { instances } from "../stores/instances"
import { restoredWorkspaceFileDraft, updateWorkspaceFileDraft } from "../stores/client-state"

// Retain unsaved text when the reader closes or another file/session is opened.
// Readers of the same draft share its baseline and pending-write state, so a
// reopened reader cannot reload over a revert before the old save completes.
type DraftValue = { original?: string; fingerprint: string; text: string; pending: boolean }
type Draft = { value: Accessor<DraftValue>; update: Setter<DraftValue> }
const drafts = new Map<string, Draft>()
function createDraft(fingerprint: string, text: string, original?: string): Draft {
  const [value, update] = createSignal<DraftValue>({ original, fingerprint, text, pending: false })
  return { value, update }
}
const utf8 = new TextEncoder()
const fingerprint = (bytes: Uint8Array) => bytesToHex(sha256(bytes))
type FileContents = { encoding?: string; contents: string }
export function workspaceFileFingerprint(result: FileContents) {
  return fingerprint(result.encoding === "base64"
    ? Uint8Array.from(atob(result.contents), char => char.charCodeAt(0)) : utf8.encode(result.contents))
}
export const decodeWorkspaceText = (result: FileContents) => result.encoding === "base64"
  ? new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(result.contents), char => char.charCodeAt(0))) : result.contents

function fileIdentity(instanceId: string, target: FilePreviewTarget) {
  const instance = instances().get(instanceId)
  const backend = instance && backendIdOf(instance)
  // A remote backend must identify its installation before it can adopt text.
  if (!instance || (backend !== LOCAL_BACKEND_ID && !instance.serverId)) return
  return JSON.stringify([backend, instance.serverId ?? null, normalizeWorkspacePath(instance.folder),
    normalizeWorkspacePath(target.directory), target.path])
}

export function useWorkspaceFileEditor(options: {
  instanceId: string; target: Accessor<FilePreviewTarget>; active: Accessor<boolean>
  t: (key: string, vars?: Record<string, any>) => string; onError: (message: string) => void
  captureOperation?: typeof captureBackendOperation
}) {
  const [localText, setText] = createSignal("")
  const [localOriginal, setOriginal] = createSignal<string | undefined>()
  const [localSaving, setSaving] = createSignal(false)
  const [draft, setDraft] = createSignal<Draft>()
  const [needsVerification, setNeedsVerification] = createSignal(false)
  const [conflict, setConflict] = createSignal(false)
  const [limited, setLimited] = createSignal(false)
  let baselineFingerprint: string | undefined
  const text = () => draft()?.value().text ?? localText()
  const original = () => draft()?.value().original ?? localOriginal()
  const saving = () => localSaving() || (draft()?.value().pending ?? false)
  const dirty = () => draft() !== undefined && text() !== original()
  const durableKey = () => fileIdentity(options.instanceId, options.target())
  const key = () => durableKey() ?? JSON.stringify([options.instanceId, options.target().directory, options.target().path])
  let generation = 0, disposed = false
  onCleanup(() => { disposed = true; generation += 1 })
  function reset() {
    generation += 1
    setSaving(false)
    setConflict(false); setLimited(false)
    const identity = durableKey()
    const saved = identity ? restoredWorkspaceFileDraft(identity) : undefined
    const existing = drafts.get(key())
    const retained = existing ?? (saved && createDraft(saved.fingerprint, saved.text))
    if (retained && !existing) drafts.set(key(), retained)
    baselineFingerprint = retained?.value().fingerprint
    setNeedsVerification(!!retained && retained.value().original === undefined)
    setDraft(retained)
    setOriginal(retained?.value().original)
    setText(retained?.value().text ?? "")
    return retained?.value().text
  }
  function verify(value: string | undefined, hash: string) {
    const retained = draft()
    if (!retained) return
    const same = hash === retained.value().fingerprint
    if (same && value !== undefined) retained.update(previous => ({ ...previous, original: value }))
    setConflict(!same)
    setNeedsVerification(false)
  }
  function adopt(value: string, hash = fingerprint(utf8.encode(value))) {
    baselineFingerprint = hash
    setOriginal(value); setText(value)
  }
  function checkpoint(identity: string | undefined, retained: Draft) {
    if (!identity) return
    const { fingerprint, text, original, pending } = retained.value()
    setLimited(!updateWorkspaceFileDraft(identity, text === original && !pending ? undefined : { fingerprint, text }))
  }
  function change(value: string) {
    const baseline = original()
    setText(value)
    if (baselineFingerprint === undefined) return
    const retained = draft() ?? drafts.get(key()) ?? createDraft(baselineFingerprint, value, baseline)
    retained.update(previous => ({ ...previous, text: value }))
    setDraft(retained)
    if (dirty() || retained.value().pending) drafts.set(key(), retained)
    else drafts.delete(key())
    checkpoint(durableKey(), retained)
  }
  function discard() {
    drafts.delete(key())
    const identity = durableKey()
    if (identity) updateWorkspaceFileDraft(identity)
    baselineFingerprint = undefined
    setDraft(undefined); setOriginal(undefined); setConflict(false); setNeedsVerification(false); setLimited(false)
  }
  async function save(value = text()) {
    if (saving() || !options.active() || !dirty()) return
    const target = options.target(), identity = key(), persisted = durableKey(), version = generation
    const operation = options.captureOperation?.(options.instanceId)
    const current = () => !disposed && version === generation && target === options.target() && options.active() && (operation?.current() ?? true)
    if (!current()) return
    const writing = draft()!
    writing.update(previous => ({ ...previous, pending: true }))
    setSaving(true)
    try {
      // An unavailable conflict check must never silently permit an overwrite.
      const api = backendOf(options.instanceId).api
      const snapshot = await api.previewWorkspaceFile(options.instanceId, target.path, target.directory, operation?.signal)
      const disk = decodeWorkspaceText(snapshot)
      if (!current()) return
      if (workspaceFileFingerprint(snapshot) !== writing.value().fingerprint && disk !== value) {
        const confirmed = await showConfirmDialog(options.t("instanceShell.rightPanel.actions.conflict.message", { path: target.path }), {
          variant: "warning", confirmLabel: options.t("instanceShell.rightPanel.actions.conflict.confirmLabel"),
          cancelLabel: options.t("instanceShell.rightPanel.actions.conflict.cancelLabel"), dismissible: true,
        })
        if (!confirmed || !current()) return
      }
      if (disk !== value) await api.writeWorkspaceFile(options.instanceId, target.path, value, { directory: target.directory, signal: operation?.signal })
      if (operation && !operation.current()) return
      const latest = drafts.get(identity)
      if (latest) {
        const hash = disk === value ? workspaceFileFingerprint(snapshot) : fingerprint(utf8.encode(value))
        latest.update(previous => ({ ...previous, original: value, fingerprint: hash }))
      }
      if (current()) {
        setOriginal(value)
        baselineFingerprint = latest?.value().fingerprint
        setConflict(false); setNeedsVerification(false)
        showToastNotification({ category: "files", message: options.t("instanceShell.rightPanel.toast.saveSuccess"), variant: "success" })
      }
      invalidateFilesystemCaches(options.instanceId)
    } catch (error) {
      if (current()) options.onError(error instanceof Error ? error.message : options.t("instanceShell.rightPanel.toast.saveError"))
    } finally {
      writing.update(previous => ({ ...previous, pending: false }))
      const latest = drafts.get(identity)
      if (latest) {
        checkpoint(persisted, latest)
        if (latest.value().text === latest.value().original && !latest.value().pending) drafts.delete(identity)
      }
      if (!disposed && generation === version) setSaving(false)
    }
  }
  return { text, dirty, saving, reset, adopt, verify, change, discard, save, needsVerification, conflict, limited }
}
