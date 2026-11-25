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
import { instances } from "../stores/instances"
import { getInstanceMetadata } from "../stores/instance-metadata"
import { getServerMeta, localServerMeta } from "../lib/server-meta"
import { loadInstanceProjectMetadata } from "../lib/hooks/use-instance-metadata"
import { keepRecoveredWorkspaceFileDraft, refreshWorkspaceFileDraft, restoredWorkspaceFileDraft, updateWorkspaceFileDraft } from "../stores/client-state"

// Retain unsaved text when the reader closes or another file/session is opened.
// Readers of the same draft share its baseline and pending-write state, so a
// reopened reader cannot reload over a revert before the old save completes.
type DraftValue = { original?: string; fingerprint: string; text: string; pending: boolean; limited?: boolean }
type Draft = { value: Accessor<DraftValue>; update: Setter<DraftValue>; readers: number }
const drafts = new Map<string, Draft>()
function release(identity: string, draft: Draft) {
  const value = draft.value()
  if (!draft.readers && !value.pending && value.original === value.text && drafts.get(identity) === draft) drafts.delete(identity)
}
function createDraft(fingerprint: string, text: string, original?: string): Draft {
  const [value, update] = createSignal<DraftValue>({ original, fingerprint, text, pending: false })
  return { value, update, readers: 0 }
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

function fileIdentity(instanceId: string, target: FilePreviewTarget, installation: string | undefined) {
  const instance = instances().get(instanceId)
  const backend = instance && backendIdOf(instance)
  if (!instance) return
  const server = backend === LOCAL_BACKEND_ID ? installation : instance.serverId
  if (!server) return
  const metadata = getInstanceMetadata(instanceId) ?? instance.metadata
  if (instance.client && (!metadata || !("project" in metadata))) return
  return JSON.stringify([backend, server, instance.folder, metadata?.project?.id ?? null, target.directory, target.path])
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
  const limited = () => draft()?.value().limited === true
  let attachedKey: string | undefined
  const text = () => draft()?.value().text ?? localText()
  const original = () => draft()?.value().original ?? localOriginal()
  const saving = () => localSaving() || (draft()?.value().pending ?? false)
  const dirty = () => draft() !== undefined && text() !== original()
  const [persistenceKey, setPersistenceKey] = createSignal<string>()
  const editable = () => !!persistenceKey() || !instances().has(options.instanceId)
  let identity = ""
  function attach(identity: string | undefined, next?: Draft) {
    const previous = draft()
    if (previous === next) return
    if (previous && attachedKey) {
      previous.readers--
      release(attachedKey, previous)
    }
    attachedKey = identity
    if (next) next.readers++
    setDraft(next)
  }
  let generation = 0, disposed = false
  onCleanup(() => { disposed = true; generation += 1; attach(undefined) })
  function reset() {
    generation += 1
    setSaving(false)
    setConflict(false)
    const target = options.target()
    setPersistenceKey(fileIdentity(options.instanceId, target, localServerMeta.meta()?.serverId))
    const fallback = JSON.stringify([options.instanceId, target.directory, target.path])
    identity = persistenceKey() ?? fallback
    const key = persistenceKey()
    const saved = key ? restoredWorkspaceFileDraft(key) : undefined
    const existing = drafts.get(identity)
    const retained = existing ?? (saved && createDraft(saved.fingerprint, saved.text))
    if (retained && !existing) drafts.set(identity, retained)
    attach(identity, retained)
    setNeedsVerification(!!retained && retained.value().original !== retained.value().text)
    setOriginal(retained?.value().original)
    setText(retained?.value().text ?? "")
    const value = retained?.value()
    return value && (value.pending || value.text !== value.original) ? value.text : undefined
  }
  async function recover() {
    const ticket = generation
    const target = options.target()
    const instance = instances().get(options.instanceId)
    if (!instance || dirty()) return
    if (!persistenceKey()) {
      const [meta] = await Promise.all([
        backendIdOf(instance) === LOCAL_BACKEND_ID ? getServerMeta().catch(() => undefined) : undefined,
        loadInstanceProjectMetadata(instance).catch(() => undefined),
      ])
      if (disposed || ticket !== generation || target !== options.target() || dirty()) return
      setPersistenceKey(fileIdentity(options.instanceId, target, meta?.serverId))
    }
    const durable = persistenceKey()
    if (!durable) return
    if (draft() && attachedKey === durable) return
    const entry = await refreshWorkspaceFileDraft(durable)
    if (disposed || ticket !== generation || target !== options.target() || dirty()) return
    identity = durable
    const existing = drafts.get(durable)
    const retained = existing ?? (entry && createDraft(entry.fingerprint, entry.text))
    if (!retained) return
    if (!existing) drafts.set(durable, retained)
    else if (entry && !existing.value().pending && existing.value().original === existing.value().text) {
      existing.update({ fingerprint: entry.fingerprint, text: entry.text, pending: false })
    }
    attach(durable, retained)
    if (entry) keepRecoveredWorkspaceFileDraft(entry)
    if (!dirty() && !retained.value().pending) return
    setNeedsVerification(dirty())
    return retained.value().text
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
    if (!identity) {
      const target = options.target()
      identity = JSON.stringify([options.instanceId, target.directory, target.path])
    }
    const existing = drafts.get(identity)
    const shared = existing ?? createDraft(hash, value, value)
    if (!existing) drafts.set(identity, shared)
    else if (!existing.value().pending && existing.value().text === existing.value().original) {
      existing.update({ original: value, fingerprint: hash, text: value, pending: false })
    }
    attach(identity, shared)
    setOriginal(value); setText(value)
  }
  function checkpoint(persisted: string | undefined, retained: Draft) {
    const { fingerprint, text, original, pending } = retained.value()
    const mark = (ok: boolean) => {
      if (retained.value().text === text && retained.value().limited !== !ok) {
        retained.update(previous => ({ ...previous, limited: !ok }))
      }
    }
    if (persisted) mark(updateWorkspaceFileDraft(persisted, text === original && !pending ? null : { fingerprint, text }, mark))
    else if (instances().has(options.instanceId)) mark(text === original)
  }
  function change(value: string) {
    if (!editable()) return
    setText(value)
    const retained = draft()
    if (!retained) return
    retained.update(previous => ({ ...previous, text: value }))
    checkpoint(persistenceKey(), retained)
  }
  function discard() {
    const shared = draft()
    if (shared) shared.update(previous => ({ ...previous, original: previous.original ?? "", text: previous.original ?? "", limited: false }))
    const persisted = persistenceKey()
    if (persisted) updateWorkspaceFileDraft(persisted, null, () => {})
    attach(undefined); setOriginal(undefined); setConflict(false); setNeedsVerification(false)
  }
  async function save(value = text()) {
    if (saving() || !options.active() || !dirty() || !editable()) return
    const target = options.target(), owned = identity, persisted = persistenceKey(), version = generation
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
      if (disk !== value) await api.writeWorkspaceFile(options.instanceId, target.path, value, {
        directory: target.directory, signal: operation?.signal, expectedVersion: snapshot.version,
      })
      if (operation && !operation.current()) return
      const latest = drafts.get(owned)
      if (latest) {
        const hash = disk === value ? workspaceFileFingerprint(snapshot) : fingerprint(utf8.encode(value))
        latest.update(previous => ({ ...previous, original: value, fingerprint: hash }))
      }
      if (current()) {
        setOriginal(value)
        setConflict(false); setNeedsVerification(false)
        showToastNotification({ category: "files", message: options.t("instanceShell.rightPanel.toast.saveSuccess"), variant: "success" })
      }
      invalidateFilesystemCaches(options.instanceId)
    } catch (error) {
      if (current()) {
        const status = error instanceof Error ? (error as { status?: unknown }).status : undefined
        const code = error instanceof Error ? (error as { code?: unknown }).code : undefined
        if (status === 409 && error instanceof Error && error.message === "File changed on disk") {
          options.onError(options.t("filesPanel.saveConflict"))
        } else if (code === "file_too_large" || status === 413 || (status === 400 && error instanceof Error && error.message === "Selected file is too large to attach")) {
          options.onError(options.t("filesPanel.saveTooLarge"))
        } else {
          options.onError(error instanceof Error ? error.message : options.t("instanceShell.rightPanel.toast.saveError"))
        }
      }
    } finally {
      writing.update(previous => ({ ...previous, pending: false }))
      const latest = drafts.get(owned)
      if (latest) {
        checkpoint(persisted, latest)
        release(owned, latest)
      }
      if (!disposed && generation === version) setSaving(false)
    }
  }
  return { text, dirty, editable, saving, reset, recover, adopt, verify, change, discard, save, needsVerification, conflict, limited }
}
