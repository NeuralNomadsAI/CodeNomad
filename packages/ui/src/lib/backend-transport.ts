import { CODENOMAD_API_BASE } from "./api-base"

export type BackendId = string

export type EventSourceFactory = (url: string, init: EventSourceInit) => EventSource

/** Where one CodeNomad backend answers: HTTP base, events stream and EventSource constructor. */
export interface BackendTransport {
  readonly id: BackendId
  readonly baseUrl: string | undefined
  readonly eventsUrl: string
  url(path: string): string
  openEventSource: EventSourceFactory
}

/** A transport plus the authenticated fetch of the same backend. */
export interface BackendHttp extends BackendTransport {
  fetch: typeof fetch
}

export interface BackendTransportOptions {
  id: BackendId
  baseUrl: string | undefined
  /** Absolute URL, or a path joined to `baseUrl`; defaults to `/api/events`. */
  eventsUrl?: string
  eventSource?: EventSourceFactory
}

/** URL resolution for backend routes; append modes preserve injected local resource contracts. */
export function resolveBackendUrl(base: string | undefined, path: string, joining: "url" | "append" | "append-trimmed" = "url"): string {
  if (joining === "append") return `${base ?? ""}${path}`
  if (joining === "append-trimmed") return `${(base ?? "").replace(/\/+$/, "")}${path}`
  return base ? new URL(path, base).toString() : path
}

function buildEventsUrl(base: string | undefined, path: string, local = false): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path
  }
  if (base) {
    const normalized = path.startsWith("/") ? path : `/${path}`
    return resolveBackendUrl(base, normalized, local || !/^https?:\/\//i.test(base) ? "append" : "url")
  }
  return path
}

function makeBackendTransport(options: BackendTransportOptions, local = false): BackendTransport {
  const { id, baseUrl } = options
  return {
    id,
    baseUrl,
    eventsUrl: buildEventsUrl(baseUrl, options.eventsUrl ?? "/api/events", local),
    url: (path) => resolveBackendUrl(baseUrl, path),
    // Resolved per connection, so tests and embedders may install EventSource after import.
    openEventSource: options.eventSource ?? ((url, init) => new EventSource(url, init)),
  }
}

export function createBackendTransport(options: BackendTransportOptions): BackendTransport {
  return makeBackendTransport(options)
}

/** The backend that served this page; the only reader of the injected base and events URL. */
export const localTransport = makeBackendTransport({
  id: "local",
  baseUrl: CODENOMAD_API_BASE,
  eventsUrl: typeof window !== "undefined" ? window.__CODENOMAD_EVENTS_URL__ ?? "/api/events" : "/api/events",
}, true)
