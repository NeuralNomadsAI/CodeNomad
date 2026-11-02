import type { Page, Request } from "playwright"
import type { serverApi } from "../../src/lib/api-client"

export const MISSION_READ_HEADER = "x-codenomad-fixture-mission-read"
type Reads = Pick<typeof serverApi, "fetchMissionSchedule" | "fetchMissionSchedules" | "fetchMissionRecurrence">

/** The queue can defer fetch: bind its exact originating signal until the real API settles. */
export function observeMissionReads(api: Reads) {
  const pending = new Set<{ id: string; path: string; signal: AbortSignal; used: boolean }>()
  const outcomes = new Map<string, Promise<boolean>>()
  const originalFetch = window.fetch
  let sequence = 0
  window.fetch = (input, init) => {
    const path = new URL(input instanceof globalThis.Request ? input.url : String(input), location.href).pathname
    // Panel reads derive a transfer signal inside the API. Observe that exact
    // native fetch/stream, including abort after headers, without changing it.
    if ((init?.method ?? "GET") === "POST" && /^\/api\/workspaces\/[^/]+\/missions\/panel-page$/.test(path) && init?.signal) {
      const id = String(++sequence), signal = init.signal, headers = new Headers(init.headers)
      headers.set(MISSION_READ_HEADER, id)
      let finish!: (cancelled: boolean) => void
      outcomes.set(id, new Promise(resolve => { finish = resolve }))
      const failed = (error: unknown) => finish(signal.aborted && error instanceof DOMException && error.name === "AbortError")
      return originalFetch.call(window, input, { ...init, headers }).then(response => {
        if (!response.body) { finish(false); return response }
        const getReader = response.body.getReader.bind(response.body)
        response.body.getReader = (() => {
          const reader = getReader(), read = reader.read.bind(reader)
          const cancel = reader.cancel.bind(reader)
          reader.cancel = reason => {
            // The bounded reader cancels with its native originating abort reason;
            // pending read() can resolve done instead of rejecting in this path.
            if (signal.aborted && reason === signal.reason && reason instanceof DOMException && reason.name === "AbortError") finish(true)
            return cancel(reason)
          }
          reader.read = () => read().then(value => { if (value.done) finish(false); return value }, error => { failed(error); throw error })
          return reader
        }) as typeof response.body.getReader
        return response
      }, error => { failed(error); throw error })
    }
    const read = [...pending].find(read => !read.used && read.path === path && read.signal === init?.signal && (init?.method ?? "GET") === "GET")
    if (!read) return originalFetch.call(window, input, init)
    read.used = true
    const headers = new Headers(init?.headers); headers.set(MISSION_READ_HEADER, read.id)
    return originalFetch.call(window, input, { ...init, headers })
  }
  const observe = <T>(signal: AbortSignal | undefined, path: string, call: () => Promise<T>) => {
    if (!signal) return call()
    const read = { id: String(++sequence), signal, path, used: false }
    pending.add(read)
    const result = call()
    outcomes.set(read.id, result.then(() => false, error =>
      read.used && signal.aborted && error instanceof DOMException && error.name === "AbortError").finally(() => pending.delete(read)))
    return result
  }
  const point = api.fetchMissionSchedule, list = api.fetchMissionSchedules, recurrence = api.fetchMissionRecurrence
  api.fetchMissionSchedule = (instance, id, input, signal) => observe(signal,
    `/api/workspaces/${encodeURIComponent(instance)}/missions/${encodeURIComponent(id)}/schedule`, () => point(instance, id, input, signal))
  api.fetchMissionSchedules = (instance, input, signal) => observe(signal,
    `/api/workspaces/${encodeURIComponent(instance)}/missions/scheduled`, () => list(instance, input, signal))
  api.fetchMissionRecurrence = (instance, signal) => observe(signal,
    `/api/workspaces/${encodeURIComponent(instance)}/missions/recurrence`, () => recurrence(instance, signal))
  window.fixtureMissionReadCancelled = async id => await outcomes.get(id) ?? false
}

export function collectMissionReadFailures(page: Page, url: string) {
  const origin = new URL(url).origin, identities = new Map<string, Request>(), reused = new Set<string>(), checks: Promise<void>[] = []
  const raw: string[] = [], cancelled: Array<{ failure: string; id: string }> = []
  page.on("request", request => {
    const id = request.headers()[MISSION_READ_HEADER]
    if (!id || new URL(request.url()).origin !== origin || !["GET", "POST"].includes(request.method())) return
    if (identities.has(id)) reused.add(id)
    else identities.set(id, request)
  })
  return { raw, cancelled,
    record(request: Request, failures: string[]) {
      const failure = `${request.url()} ${request.failure()?.errorText}`, id = request.headers()[MISSION_READ_HEADER]
      raw.push(failure)
      if (!["GET", "POST"].includes(request.method()) || new URL(request.url()).origin !== origin || request.failure()?.errorText !== "net::ERR_ABORTED"
        || !id || reused.has(id) || identities.get(id) !== request) { failures.push(`${failure} [unidentified read ${id}]`); return }
      checks.push(page.evaluate(id => window.fixtureMissionReadCancelled(id), id).then(owned => {
        if (owned && !reused.has(id)) cancelled.push({ failure, id })
        else failures.push(`${failure} [uncorrelated read ${id}]`)
      }).catch(() => { failures.push(failure) }))
    },
    async drain() { for (const check of checks) await check },
  }
}

declare global { interface Window { fixtureMissionReadCancelled(id: string): Promise<boolean> } }
