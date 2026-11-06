import { createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js"
import type { MemoryContext, MemoryUIEntry } from "../../../server/src/api-types"
import { agentMemoryApi, AgentMemoryError } from "../lib/agent-memory-api"
import { serverEvents } from "../lib/server-events"
import { showConfirmDialog } from "./alerts"
import { registerSettingsDirtyGuard } from "./settings-dirty-guard"
import { useI18n } from "../lib/i18n"

export const memoryCharacters = (text: string) => [...text].length
export const memoryTitleValid = (title: string) => !!title.trim() && memoryCharacters(title) <= 60 && !/[\x00-\x1f\x7f\u2028\u2029]/u.test(title)
type Scope = "global" | "project"
type Draft = { entry: MemoryUIEntry; title: string; type: MemoryUIEntry["type"]; text: string }
const dirty = (draft?: Draft) => !!draft && (draft.title !== draft.entry.title || draft.type !== draft.entry.type || draft.text !== draft.entry.text)
const failure = (error: unknown) => error instanceof AgentMemoryError ? error : new AgentMemoryError("unavailable")
const consultationKey = (scopeKey: string) => `codenomad.memory.seen.${scopeKey}`

/** Visit-local baselines stay frozen; only a successful read advances the persisted frontier. */
export function createAgentMemoryReview(context: () => MemoryContext | undefined, enabled: () => boolean) {
  const { t } = useI18n()
  const [scope, setScope] = createSignal<Scope>(context() ? "project" : "global")
  let scopeChosen = false
  createEffect(() => { if (context() && !scopeChosen) setScope("project") })
  const owner = createMemo(() => JSON.stringify([scope(), scope() === "project" ? context() ?? null : null]))
  const drafts = new Map<string, Draft>(), baselines = new Map<string, number>()
  const [draft, setDraft] = createSignal<Draft>()
  const [entries, setEntries] = createSignal<MemoryUIEntry[]>([])
  const [hasSnapshot, setHasSnapshot] = createSignal(false)
  const [baseline, setBaseline] = createSignal(0)
  const [loading, setLoading] = createSignal(false), [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<AgentMemoryError>()
  let generation = 0, disposed = false, pendingRead: { generation: number; promise: Promise<void> } | undefined, trailing = false
  let consent = new AbortController()
  const available = () => enabled() && (scope() === "global" || !!context())
  const remember = (next?: Draft) => { const key = owner(); if (next) drafts.set(key, next); else drafts.delete(key); setDraft(next) }
  const discard = async () => {
    if (![...drafts.values()].some(dirty)) return true
    const accepted = await showConfirmDialog(t("settings.memory.discard"), {
      confirmLabel: t("settings.memory.discardConfirm"), cancelLabel: t("settings.memory.cancel"),
    }, consent.signal)
    if (accepted) { drafts.clear(); setDraft(undefined) }
    return accepted
  }
  onCleanup(registerSettingsDirtyGuard(discard))
  const read = async (current: number) => {
    if (!available()) return
    const key = owner(), targetScope = scope(), target = targetScope === "project" ? context() : undefined
    try {
      const result = await agentMemoryApi.list(targetScope, target)
      if (disposed || current !== generation) return
      if (!result || !Array.isArray(result.entries) || typeof result.scopeKey !== "string" || !Number.isFinite(Date.parse(result.observedAt))) throw new AgentMemoryError("unreadable")
      if (!baselines.has(result.scopeKey)) {
        let seen = 0
        try { seen = Number(localStorage.getItem(consultationKey(result.scopeKey))) || 0 } catch { /* Optional display preference. */ }
        baselines.set(result.scopeKey, seen)
      }
      setBaseline(baselines.get(result.scopeKey)!); setEntries(result.entries); setHasSnapshot(true)
      setError(previous => previous?.code === "conflict" ? previous : undefined)
      const opened = drafts.get(key)
      if (opened) {
        const fresh = result.entries.find(entry => entry.id === opened.entry.id)
        if (!dirty(opened)) remember(fresh ? { entry: fresh, title: fresh.title, type: fresh.type, text: fresh.text } : undefined)
        else {
          if (!busy() && fresh?.revision !== opened.entry.revision) setError(new AgentMemoryError("conflict"))
          if (fresh) remember({ ...opened, entry: { ...opened.entry, flagged: fresh.flagged, warning: fresh.warning } })
        }
      }
      try {
        const stored = Number(localStorage.getItem(consultationKey(result.scopeKey))) || 0
        localStorage.setItem(consultationKey(result.scopeKey), String(Math.max(stored, Date.parse(result.observedAt))))
      } catch { /* Badges remain visit-local if storage is unavailable. */ }
    } catch (cause) { if (!disposed && current === generation) setError(failure(cause)) }
  }
  const load = (): Promise<void> => {
    if (!available()) return Promise.resolve()
    const current = generation
    if (pendingRead?.generation === current) { trailing = true; return pendingRead.promise }
    setLoading(true)
    const owned = { generation: current, promise: Promise.resolve() }
    owned.promise = (async () => {
      do { trailing = false; await read(current) } while (trailing && !disposed && current === generation)
    })().finally(() => {
      if (pendingRead === owned) { pendingRead = undefined; setLoading(false) }
    })
    pendingRead = owned
    return owned.promise
  }
  createEffect(() => {
    owner(); enabled()
    generation++; consent.abort(); consent = new AbortController(); pendingRead = undefined; trailing = false
    setEntries([]); setHasSnapshot(false); setError(undefined); setLoading(false); setBusy(false); setDraft(drafts.get(owner()))
    untrack(() => { void load() })
  })
  const open = async (entry: MemoryUIEntry) => {
    const current = generation
    if (draft()?.entry.id === entry.id) return
    if (dirty(draft()) && !(await discard())) return
    if (current !== generation || disposed) return
    remember({ entry, title: entry.title, type: entry.type, text: entry.text })
  }
  const changeScope = async (next: Scope) => {
    const current = generation
    if (next === scope() || (next === "project" && !context())) return
    if (!(await discard()) || current !== generation || disposed) return
    scopeChosen = true; setScope(next)
  }
  const mutate = async (remove = false) => {
    const current = generation, key = owner(), selected = draft(), targetScope = scope(), target = targetScope === "project" ? context() : undefined
    if (!selected || busy() || !available()) return
    setBusy(true); setError(undefined)
    try {
      const result = await agentMemoryApi.operation<{ revision: string; flagged: boolean }>(remove
        ? { action: "delete", scope: targetScope, id: selected.entry.id, revision: selected.entry.revision }
        : { action: "save", scope: targetScope, id: selected.entry.id, revision: selected.entry.revision,
          content: { title: selected.title, type: selected.type, text: selected.text } }, target)
      drafts.delete(key)
      if (disposed || current !== generation) return
      setError(undefined)
      if (remove) setDraft(undefined)
      else {
        const entry = { ...selected.entry, title: selected.title, type: selected.type, text: selected.text, revision: result.revision, flagged: result.flagged }
        remember({ entry, title: entry.title, type: entry.type, text: entry.text })
      }
      await load()
    } catch (cause) { if (!disposed && current === generation) setError(failure(cause)) }
    finally { if (!disposed && current === generation) setBusy(false) }
  }
  onMount(() => {
    const refresh = () => { void load() }
    const stop = serverEvents.on("memory.changed", refresh), reconnect = serverEvents.onOpen(refresh)
    onCleanup(() => { disposed = true; generation++; consent.abort(); stop(); reconnect() })
  })
  return { scope, changeScope, available, entries, hasSnapshot, baseline, draft, loading, busy, error, load, open, discard,
    consentSignal: () => consent.signal,
    dirty: () => dirty(draft()), valid: () => !!draft() && memoryTitleValid(draft()!.title) && memoryCharacters(draft()!.text) <= 2000,
    edit: (patch: Partial<Pick<Draft, "title" | "text" | "type">>) => { const current = draft(); if (current) remember({ ...current, ...patch }) },
    save: () => mutate(), remove: () => mutate(true),
    cancel: () => { const entry = draft()?.entry; remember(entry ? { entry, title: entry.title, type: entry.type, text: entry.text } : undefined) },
    reload: async () => { const current = generation; if (await discard() && current === generation && !disposed) { remember(undefined); setError(undefined); await load() } },
  }
}
