import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { backendOf } from "./backend-client"
import { captureBackendOperation } from "./backend-operation"
import { isSessionMediaPath } from "../../../server/src/opencode/session-media-contract"
import { localTransport, resolveBackendUrl } from "./backend-transport"

/** A mounted media resource retains its instance's transport and attachment through body transfer. */
export function createMediaSource(instanceId: Accessor<string>, source: Accessor<string | undefined>, joinLocalMedia = true) {
  const [resolved, setResolved] = createSignal<string>()
  createEffect(() => {
    const id = instanceId(), value = source()
    setResolved(undefined)
    if (!value) return
    let backend
    try { backend = backendOf(id) } catch { return }
    if (backend.id === "local") {
      setResolved(joinLocalMedia && isSessionMediaPath(value) ? resolveBackendUrl(localTransport.baseUrl, value, "append-trimmed") : value)
      return
    }
    const controller = new AbortController()
    const operation = captureBackendOperation(id, controller.signal)
    let objectUrl: string | undefined
    const release = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      objectUrl = undefined
      setResolved(undefined)
    }
    operation.signal.addEventListener("abort", release, { once: true })
    onCleanup(() => { controller.abort(); operation.signal.removeEventListener("abort", release); release() })
    if (!operation.current()) return
    if (/^(?:data:|blob:)/i.test(value)) { setResolved(value); return }
    let url: URL
    try {
      url = new URL(backend.url(value))
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return
    } catch { return }
    const owner = backend
    const sameOrigin = url.origin === new URL(owner.url("/")).origin
    // Backend fetchers may inject device authorization, independently of cookie credentials.
    if (!sameOrigin) { setResolved(url.href); return }
    void (async () => {
      try {
        if (!operation.current()) return
        const backendMedia = isSessionMediaPath(url.pathname)
        const fetcher = backendMedia ? owner.fetch : globalThis.fetch
        const response = await fetcher(url.href, {
          signal: operation.signal,
          credentials: backendMedia ? "include" : "omit",
        })
        if (!operation.current() || !response.ok) return
        const blob = await response.blob()
        if (!operation.current()) return
        objectUrl = URL.createObjectURL(blob)
        if (!operation.current()) { release(); return }
        setResolved(objectUrl)
      } catch { /* An unavailable or revoked resource stays hidden. */ }
    })()
  })
  return resolved
}
