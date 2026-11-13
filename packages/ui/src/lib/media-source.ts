import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { backendOf } from "./backend-client"
import { captureBackendOperation } from "./backend-operation"
import { isSessionMediaPath } from "../../../server/src/opencode/session-media-contract"
import { localTransport, resolveBackendUrl } from "./backend-transport"
import { passiveImageType } from "./passive-image"

/** A mounted media resource retains its instance's transport and attachment through body transfer. */
export function createMediaSource(instanceId: Accessor<string>, source: Accessor<string | undefined>, joinLocalMedia = true) {
  const [resolved, setResolved] = createSignal<string>()
  const [restricted, setRestricted] = createSignal(false)
  createEffect(() => {
    const id = instanceId(), value = source()
    setResolved(undefined)
    setRestricted(false)
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
    // Raw blob references may name active documents at the renderer's origin.
    if (/^blob:/i.test(value)) return
    let url: URL
    try {
      url = new URL(isSessionMediaPath(value) ? backend.url(value) : value)
      if (!/^(?:https?:|data:)$/.test(url.protocol) || url.username || url.password) return
    } catch { return }
    const owner = backend
    const inline = url.protocol === "data:"
    const root = new URL(owner.url("/"))
    root.search = ""
    const sameOrigin = url.origin === root.origin
    // UI- and backend-origin sources must stay inside this owner's namespace.
    if ((sameOrigin || url.origin === window.location.origin) && !url.href.startsWith(root.href)) return
    // Backend fetchers may inject device authorization, independently of cookie credentials.
    if (!inline && !sameOrigin) { setResolved(url.href); return }
    void (async () => {
      try {
        if (!operation.current()) return
        const backendMedia = !inline && sameOrigin && isSessionMediaPath(url.pathname.slice(root.pathname.length - 1))
        const fetcher = backendMedia ? owner.fetch : globalThis.fetch
        const response = await fetcher(url.href, {
          signal: operation.signal,
          credentials: backendMedia ? "include" : "omit",
        })
        if (!operation.current() || !response.ok) return
        const blob = await response.blob()
        if (!operation.current()) return
        const bytes = new Uint8Array(await blob.arrayBuffer())
        if (!operation.current()) return
        const type = passiveImageType(bytes)
        if (!type) return
        objectUrl = URL.createObjectURL(new Blob([bytes], { type }))
        if (!operation.current()) { release(); return }
        setRestricted(true)
        setResolved(objectUrl)
      } catch { /* An unavailable or revoked resource stays hidden. */ }
    })()
  })
  return Object.assign(resolved, { restricted })
}
