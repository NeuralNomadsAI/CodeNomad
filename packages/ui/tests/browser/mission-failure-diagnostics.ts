import type { TestContext } from "node:test"
import type { Page, Request } from "playwright"

// Passive, fixture-only observations. Install before navigation; emit only in catch.
export function createMissionFailureDiagnostics() {
  const events: Array<{ at: number; kind: string; detail: unknown }> = []
  let dropped = 0, page: Page
  const discard = (log: typeof events) => log.splice(Math.max(0,
    log.findIndex(event => !["route-post", "fixture-control", "console-error", "page-error"].includes(event.kind))), 1)
  const record = (kind: string, detail: unknown) => {
    const text = JSON.stringify(detail)
    events.push({ at: Date.now(), kind, detail: text.length > 900 ? { truncated: text.slice(0, 800) } : JSON.parse(text) })
    while (Buffer.byteLength(JSON.stringify(events)) > 6_000) { discard(events); dropped++ }
  }
  return {
    record,
    async observe(target: Page) {
      page = target
      const requests = new WeakMap<Request, number>()
      let sequence = 0
      page.on("request", request => {
        const path = new URL(request.url()).pathname
        if (!/^\/api\/workspaces\/[^/]+\/missions(?:\/|$)/.test(path)) return
        const id = ++sequence
        requests.set(request, id)
        record("request", { id, method: request.method(), path, body: request.postData()?.slice(0, 500) })
      })
      page.on("response", response => {
        const id = requests.get(response.request())
        if (id) record("response", { id, status: response.status() })
      })
      page.on("requestfinished", request => {
        const id = requests.get(request)
        if (id) record("finished", { id })
      })
      page.on("requestfailed", request => {
        const id = requests.get(request)
        if (id) record("failed", { id, error: request.failure()?.errorText })
      })
      page.on("console", message => {
        if (message.type() === "error") record("console-error", { text: message.text().slice(0, 500) })
      })
      page.on("pageerror", error => record("page-error", { message: error.message.slice(0, 500) }))
      await page.addInitScript(`(() => {
        const text = (value, limit = 120) => String(value ?? "").slice(0, limit)
        const button = node => node ? { label: text(node.getAttribute("aria-label")), disabled: node.disabled,
          nativeDisabled: node.matches(":disabled"), ariaDisabled: node.getAttribute("aria-disabled"),
          pressed: node.getAttribute("aria-pressed"), visible: !!node.getClientRects().length } : null
        const describe = node => node instanceof Element ? { tag: node.tagName, class: text(node.getAttribute("class")),
          button: button(node.closest("button")), row: node.closest("[data-mission-key]")?.getAttribute("data-mission-key") } : null
        const snapshot = (compact = false) => {
          const controls = [...document.querySelectorAll(compact
            ? ".mission-picker-actions > button:last-child,.mission-picker-selection-actions .mission-action-bar > button:first-child"
            : ".mission-picker button")].slice(0, 20).map(button)
          const rows = [...document.querySelectorAll(".mission-row")]
          return { controls, rowCount: rows.length, rows: rows.slice(0, 8).map(row => {
            const selected = row.querySelector('.mission-row-select[aria-current="true"]') !== null
            return { key: row.getAttribute("data-mission-key"), title: text(row.querySelector(".session-item-title")?.textContent),
              selected, status: text(row.querySelector(".sr-only")?.textContent),
              // Only the selected row owns mounted controls. null means absent, not eligible.
              pause: selected ? controls.filter(control => control.label.startsWith("Pause schedule ")) : null }
          }), detail: [...document.querySelectorAll("section.mission-detail")].slice(0, 4).map(node => ({
            label: text(node.getAttribute("aria-label")), hidden: !node.getClientRects().length })),
            notices: [...document.querySelectorAll('.mission-control [role="status"],.mission-control [role="alert"]')]
              .slice(0, 6).map(node => text(node.textContent, 180)) }
        }
        const state = window.__missionFailureDiagnostics = { clicks: [], dropped: 0, snapshot }
        for (const type of ["pointerdown", "pointerup", "click"]) document.addEventListener(type, event => {
          if (!(event.target instanceof Element)) return
          state.clicks.push({ at: Date.now(), type, trusted: event.isTrusted, x: event.clientX, y: event.clientY,
            target: describe(event.target), hit: describe(document.elementFromPoint(event.clientX, event.clientY)), ...snapshot(true) })
          while (new TextEncoder().encode(JSON.stringify(state.clicks)).length > 5_000) { state.clicks.shift(); state.dropped++ }
        }, { capture: true, passive: true })
      })()`)
    },
    async dump(t: TestContext, fixture: unknown) {
      // A closed/unresponsive page must not replace the test's original failure.
      let timer: ReturnType<typeof setTimeout> | undefined
      let browser: unknown
      try {
        browser = await Promise.race([
          page.evaluate(() => {
            const diagnostic = (window as any).__missionFailureDiagnostics
            const state = (window as any).missionFixture?.snapshot?.() ?? (window as any).missionEditorLifetime?.state?.("fixture")
            return { ...diagnostic?.snapshot(), clicks: diagnostic?.clicks, droppedClicks: diagnostic?.dropped,
              header: state && { status: state.status, projectID: state.projectID,
                missions: state.missions?.slice(0, 4).map((map: any) => ({ id: map.id, revision: map.revision,
                  status: map.status, runState: map.runState, control: map.panelControl ?? map.control })),
                summaries: state.summaries?.slice(0, 8).map((row: any) => ({ id: row.id, revision: row.revision, runState: row.runState })) } }
          }),
          new Promise(resolve => { timer = setTimeout(() => resolve({ unavailable: "page observation exceeded 1500ms" }), 1_500) }),
        ])
      } catch (error) { browser = { unavailable: String(error).slice(0, 300) } }
      finally { clearTimeout(timer) }
      try {
        const evidence = { kind: "mission-failure", test: t.name, fixture, browser, events: [...events], dropped }
        let json = JSON.stringify(evidence)
        while (Buffer.byteLength(json) >= 16_000 && evidence.events.length) {
          discard(evidence.events); evidence.dropped++; json = JSON.stringify(evidence)
        }
        // The fixture payload is test-authored; preserve valid JSON even if it unexpectedly grows.
        if (Buffer.byteLength(json) >= 16_000) json = JSON.stringify({ kind: evidence.kind, test: t.name.slice(0, 160),
          truncated: true, fixture: JSON.stringify(fixture).slice(0, 700), browser: JSON.stringify(browser).slice(0, 1_000) })
        t.diagnostic(json)
      } catch { t.diagnostic('{"kind":"mission-failure","unavailable":"diagnostic serialization failed"}') }
    },
  }
}
