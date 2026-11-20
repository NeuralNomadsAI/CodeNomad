import type { Page, Route } from "playwright"

/** One catalogue integration as the integrations route projects it (`IntegrationView`). */
export function integrationView(id: string, overrides: Record<string, unknown> = {}) {
  const app = id[0]!.toUpperCase() + id.slice(1)
  return {
    id, displayName: `OpenCode for ${app}`, family: "native", app: { name: app, versions: ">=5.2" },
    summary: { en: `Use ${app} from OpenCode.`, fr: `Utiliser ${app} depuis OpenCode.` },
    docs: `https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/${id}`, catalogStatus: "preview",
    configured: true, plugin: { declared: true, runtime: "loaded", runtimeId: `neuralnomads.${id}` }, scopes: ["global"],
    configuredSources: [{ scope: "global", entryIndex: id === "blender" ? 2 : 3, expectedRevision: "a".repeat(64) }], configuredRules: [],
    version: "0.1.0", state: "ok",
    status: { version: "0.1.0", host: { state: "ok" }, connection: { offers: 1 } },
    ...overrides,
  }
}

export type IntegrationCall = { action: string; method: string; integration?: string; directory: string | null; sessionID?: string; body: any }

/**
 * Deterministic HTTP model of the CodeNomad integration routes. Every request is recorded; `hold` keeps the next
 * matching request pending until the test fulfils or aborts it.
 */
export async function routeIntegrations(page: Page) {
  const calls: IntegrationCall[] = []
  const model = {
    catalog: { state: "fresh", fetchedAt: "2026-11-01T12:00:00Z" } as { state: string; fetchedAt?: string },
    integrations: [integrationView("blender"), integrationView("gaffer", { family: "native" })] as any[],
    ambiguousSources: [] as Array<{ scope: string; entryIndex: number }>,
    bindings: {} as Record<string, { state: string; label?: string }>,
    offers: [{ offerID: "offer-0001", label: "Scene", document: "scene.blend", appVersion: "5.2", protocol: "ok" }] as any[],
    outcomes: { attach: "attached", detach: "detached", installHost: "installed" } as Record<string, string>,
    hold: new Set<string>(),
    held: [] as Array<{ action: string; route: Route }>,
    fail: new Map<string, "network" | number>(),
    install: undefined as undefined | ((scope: string, id: string) => void),
  }
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.pathname === "/api/panel-extensions" && request.method() === "GET") return route.fulfill({ json: [] })
    const match = url.pathname.match(/\/integrations(?:\/([a-z0-9-]+)\/(hosts|attach|detach|install-host|binding|install))?$/)
    if (url.pathname.endsWith("/plugin-sources") && request.method() === "DELETE") {
      calls.push({ action: "remove", method: "DELETE", directory: null, body: request.postDataJSON() })
      const body = request.postDataJSON()
      return route.fulfill({ json: { scope: body.scope, spec: body.target, reloadPending: true } })
    }
    if (!match) return route.fulfill({ json: {} })
    const action = match[2] ?? "read", integration = match[1]
    const body = request.method() === "GET" ? undefined : request.postDataJSON()
    calls.push({ action, method: request.method(), integration, directory: url.searchParams.get("directory"),
      ...(url.searchParams.has("sessionID") ? { sessionID: url.searchParams.get("sessionID")! } : {}), body })
    if (model.hold.has(action)) { model.held.push({ action, route }); return }
    const failure = model.fail.get(action)
    if (failure === "network") return route.abort("connectionfailed")
    if (typeof failure === "number") return route.fulfill({ status: failure, json: { error: "refused" } })
    if (action === "read") return route.fulfill({ json: { location: { directory: "/repo" }, catalog: model.catalog, integrations: model.integrations, ambiguousSources: model.ambiguousSources } })
    const key = `${url.searchParams.get("sessionID") ?? body?.sessionID}:${integration}`
    if (action === "binding") return route.fulfill({ json: model.bindings[key] ?? { state: "none" } })
    if (action === "hosts") return route.fulfill({ json: { offers: model.offers } })
    if (action === "attach") {
      const offer = model.offers.find(item => item.offerID === body.offerID)
      if (model.outcomes.attach === "attached" && offer) model.bindings[key] = { state: "attached", label: offer.label }
      return route.fulfill({ json: { outcome: model.outcomes.attach } })
    }
    if (action === "detach") { model.bindings[key] = { state: "none" }; return route.fulfill({ json: { outcome: model.outcomes.detach } }) }
    if (action === "install-host") return route.fulfill({ json: { outcome: model.outcomes.installHost } })
    if (action === "install") {
      model.install?.(body.scope, integration!)
      return route.fulfill({ json: { scope: body.scope, spec: `@neuralnomads/opencode-${integration}@^0.1`, reloadPending: true } })
    }
    return route.fulfill({ json: {} })
  })
  return { calls, model, count: (action: string) => calls.filter(call => call.action === action).length }
}

export async function waitFor(condition: () => boolean, message: string, timeout = 5_000) {
  const end = Date.now() + timeout
  while (!condition()) {
    if (Date.now() > end) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
