import type { Page, Request } from "playwright"
import type { panelExtensionsApi } from "../../src/lib/panel-extensions-api"

export const PANEL_READ_HEADER = "x-codenomad-fixture-panel-read"

/** Observe the real list call, including cancellation during response.json(). */
export function observePanelReads(api: Pick<typeof panelExtensionsApi, "list">) {
  const outcomes = new Map<string, Promise<boolean>>()
  const list = api.list
  let sequence = 0
  api.list = signal => {
    const id = String(++sequence), originalFetch = window.fetch
    window.fetch = (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set(PANEL_READ_HEADER, id)
      return originalFetch.call(window, input, { ...init, headers })
    }
    try {
      // The real API starts fetch synchronously; restore it before yielding.
      const result = list(signal)
      outcomes.set(id, result.then(() => false, error =>
        signal?.aborted === true && error instanceof DOMException && error.name === "AbortError"))
      return result
    } finally { window.fetch = originalFetch }
  }
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
