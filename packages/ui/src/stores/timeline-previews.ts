import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { backendOf } from "../lib/backend-client"
import { captureBackendOperation } from "../lib/backend-operation"
import { getOpenCodeInstanceGeneration, getOpenCodeMutationRevision } from "./opencode-data"
import { sessions } from "./session-state"

type Preview = { id: string; text: string; tools: string }
// Separate from structural indexes: at most 512 bounded excerpts (~8 MiB UTF-16).
const cache = new Map<string, { preview: Preview; readAt: number; signal: AbortSignal }>()

export function createTimelinePreviews(props: { instanceId: Accessor<string>; sessionId: Accessor<string>;
  active: Accessor<boolean>; requested: Accessor<string[]> }) {
  const [revision, setRevision] = createSignal(0)
  const identity = createMemo(() => JSON.stringify([props.instanceId(), props.sessionId(),
    getOpenCodeInstanceGeneration(props.instanceId()), getOpenCodeMutationRevision(props.instanceId(), props.sessionId()),
    sessions().get(props.instanceId())?.get(props.sessionId())?.revert?.messageID]))
  const requested = createMemo(() => [...new Set(props.requested())].slice(0, 96).join("\0"))
  createEffect(() => {
    const scope = identity(), instanceId = props.instanceId(), sessionID = props.sessionId()
    const attachment = captureBackendOperation(instanceId)
    const ids = requested().split("\0").filter(Boolean)
    if (!props.active() || !ids.length) return
    const controller = new AbortController()
    const operation = captureBackendOperation(instanceId, controller.signal)
    const current = () => operation.current() && identity() === scope
    const timer = setTimeout(() => {
      void (async () => {
        const missing = ids.filter(id => {
          const entry = cache.get(`${scope}\0${id}`)
          return entry?.signal !== attachment.signal || Date.now() - entry.readAt > 30_000
        })
        for (let offset = 0; offset < missing.length; offset += 12) {
          if (!current()) return
          const result = await backendOf(instanceId).api.fetchOutlinePreviews(instanceId, sessionID, missing.slice(offset, offset + 12), operation.signal)
          if (!current() || result.status !== "previews") return
          for (const entry of result.entries) {
            const key = `${scope}\0${entry.id}`
            cache.delete(key); cache.set(key, { preview: entry, readAt: Date.now(), signal: attachment.signal })
          }
          while (cache.size > 512) cache.delete(cache.keys().next().value!)
          setRevision(value => value + 1)
        }
      })().catch(() => { /* Optional preview: leave it absent; navigation stays usable. */ })
    }, 80)
    onCleanup(() => { clearTimeout(timer); controller.abort() })
  })
  return (id: string): Preview | undefined => {
    revision()
    const key = `${identity()}\0${id}`, value = cache.get(key)
    if (value) { cache.delete(key); cache.set(key, value) }
    return value?.preview
  }
}
