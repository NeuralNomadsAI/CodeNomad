import type { Page } from "playwright"

const maxEvents = 48, maxString = 256, snapshotDeadline = 2000
const bounded = (value: string) => value.slice(0, maxString)
const errorText = (error: unknown) => bounded(error instanceof Error ? error.message : String(error))
function locationLabel(value: string) {
  try {
    const url = new URL(value)
    // Never retain credentials, arbitrary query values or fragments.
    return bounded(url.origin + url.pathname + (url.searchParams.has("v") ? `?v=${bounded(url.searchParams.get("v")!)}` : ""))
  } catch { return bounded(value.split(/[?#]/)[0]) }
}

// Installed only on observed composer pages, before their entry module loads.
// No console output or async work: stages/errors stay in a small document-local ring.
export const headerBootScript = `(() => {
  const entries = [];
  const mark = (phase, detail = '') => {
    entries.push({ phase: String(phase).slice(0, 64), detail: String(detail).slice(0, 256), at: performance.now() });
    if (entries.length > 16) entries.shift();
  };
  window.__headerFixtureBoot = { entries, mark };
  mark('document-init');
  addEventListener('error', e => mark('window-error', e.message || 'resource error'));
  addEventListener('unhandledrejection', e => mark('rejection', String(e.reason)));
})()`

export function observeHeaderFixture(page: Page) {
  const events: Array<Record<string, string | number>> = []
  let dropped = 0, detached = false
  const push = (event: Record<string, string | number>) => {
    events.push(event)
    if (events.length > maxEvents) { events.shift(); dropped++ }
  }
  const consoleMessage = (message: import("playwright").ConsoleMessage) => push({ kind: "console", level: message.type(), text: bounded(message.text()) })
  const pageError = (error: Error) => push({ kind: "pageerror", text: errorText(error) })
  const requestFailed = (request: import("playwright").Request) => push({ kind: "requestfailed", url: locationLabel(request.url()), text: bounded(request.failure()?.errorText ?? "") })
  const response = (result: import("playwright").Response) => {
    const request = result.request(), url = new URL(result.url())
    if (["script", "fetch", "xhr", "eventsource", "document"].includes(request.resourceType()) || url.pathname.includes("/api/")) {
      push({ kind: "response", url: locationLabel(result.url()), status: result.status() })
    }
  }
  const navigation = (frame: import("playwright").Frame) => {
    if (frame === page.mainFrame()) push({ kind: "navigation", url: locationLabel(frame.url()) })
  }
  page.on("console", consoleMessage)
  page.on("pageerror", pageError)
  page.on("requestfailed", requestFailed)
  page.on("response", response)
  page.on("framenavigated", navigation)

  return {
    install: () => page.addInitScript(headerBootScript),
    async diagnose(emit: (message: string) => void) {
      let timer: ReturnType<typeof setTimeout> | undefined
      let snapshot: unknown, observationError: string | undefined
      try {
        snapshot = await Promise.race([
          page.evaluate(() => {
            const boot = (window as any).__headerFixtureBoot
            return { readyState: document.readyState, fixture: typeof (window as any).fixture,
              boot: boot?.entries?.slice(-16).map((entry: any) => ({ phase: String(entry.phase).slice(0, 64), detail: String(entry.detail).slice(0, 256), at: typeof entry.at === "number" ? entry.at : undefined })),
              dom: { rootChildren: document.getElementById("root")?.childElementCount ?? 0,
                textarea: Boolean(document.querySelector("textarea.prompt-input")), footer: Boolean(document.querySelector(".prompt-input-footer")) } }
          }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("header snapshot deadline (2000ms)")), snapshotDeadline) }),
        ])
      } catch (error) { observationError = errorText(error) }
      finally { if (timer !== undefined) clearTimeout(timer) }
      emit(JSON.stringify({ kind: "header-fixture-diagnostic", url: locationLabel(page.url()), dropped, detached, events: events.slice(), snapshot, observationError }))
    },
    detach() {
      if (detached) return
      detached = true
      page.off("console", consoleMessage)
      page.off("pageerror", pageError)
      page.off("requestfailed", requestFailed)
      page.off("response", response)
      page.off("framenavigated", navigation)
    },
  }
}
