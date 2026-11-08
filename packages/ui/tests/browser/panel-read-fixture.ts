import type { Page, Request } from "playwright"
import type { BackendClient } from "../../src/lib/backend-client"

export const PANEL_READ_HEADER = "x-codenomad-fixture-panel-read"

/** Observe the backend transport shared by the per-operation API factories. */
export function observeBackendPanelReads(backend: BackendClient, backends: ReadonlyMap<string, BackendClient>) {
  const outcomes = new Map<string, Promise<boolean>>()
  const fetch = backend.fetch
  let sequence = 0
  const observedFetch: typeof fetch = (input, init) => {
    if (new URL(String(input), location.origin).pathname !== "/api/panel-extensions" || (init?.method ?? "GET") !== "GET") return fetch(input, init)
    const id = String(++sequence), signal = init?.signal
    const headers = new Headers(init?.headers)
    headers.set(PANEL_READ_HEADER, id)
    let settle!: (cancelled: boolean) => void
    outcomes.set(id, new Promise(resolve => { settle = resolve }))
    const failed = (error: unknown) => {
      settle(signal?.aborted === true && error instanceof DOMException && error.name === "AbortError")
      throw error
    }
    return fetch(input, { ...init, headers }).then(response => {
      const json = response.json.bind(response)
      response.json = () => json().then(value => { settle(false); return value }, failed)
      return response
    }, failed)
  }
  ;(backends as Map<string, BackendClient>).set(backend.id, { ...backend, fetch: observedFetch })
  return window.fixturePanelReadCancelled = async id => await outcomes.get(id) ?? false
}

/** Keep every raw failure; classify only the exact observed controller-owned read. */
export function collectPanelReadFailures(page: Page, url: string) {
  const catalog = new URL("/api/panel-extensions", url).href
  const identities = new Map<string, Request>(), checks: Promise<void>[] = []
  const rawRequestFailures: string[] = [], panelListCancellations: Array<{ failure: string; readId: string }> = []
  page.on("request", request => {
    const id = request.headers()[PANEL_READ_HEADER]
    if (request.method() === "GET" && request.url() === catalog && id && !identities.has(id)) identities.set(id, request)
  })
  return {
    rawRequestFailures, panelListCancellations,
    record(request: Request, failures: string[]) {
      const failure = `${request.url()} ${request.failure()?.errorText}`
      rawRequestFailures.push(failure)
      const readId = request.headers()[PANEL_READ_HEADER]
      if (request.method() !== "GET" || request.url() !== catalog || request.failure()?.errorText !== "net::ERR_ABORTED"
        || !readId || identities.get(readId) !== request) return false
      checks.push(page.evaluate(id => window.fixturePanelReadCancelled(id), readId).then(cancelled => {
        if (cancelled) panelListCancellations.push({ failure, readId })
        else failures.push(failure)
      }).catch(() => { failures.push(failure) }))
      return true
    },
    async drain() { for (const check of checks) await check },
  }
}

declare global {
  interface Window { fixturePanelReadCancelled(id: string): Promise<boolean> }
}
