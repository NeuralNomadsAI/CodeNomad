import { fileURLToPath } from "node:url"
import type { FixtureDefinition } from "./fixture-daemon/server"
import type { DaemonEndpoint } from "./fixture-daemon/run"

const uiRoot = fileURLToPath(new URL("../..", import.meta.url))

export interface BorrowedFixture {
  readonly url: string
  close(): Promise<void>
}

export interface BorrowOptions {
  /** Test seam: attach to an explicit endpoint instead of the environment's. */
  endpoint?: DaemonEndpoint
}

/** Borrowed routes are namespaced under the fixture's name so distinct
 * fixtures never collide on common paths like "/fixture". The original path
 * is preserved verbatim after the prefix: tests derive sibling route URLs
 * from the borrowed url by string substitution, and a uniform prefix keeps
 * those derivations working. (A fixture whose own name contained a replaced
 * substring would still be at risk — keep names free of route fragments.) */
function namespaced(definition: FixtureDefinition): FixtureDefinition {
  return {
    name: definition.name,
    routes: definition.routes.map(route => ({
      path: `/${definition.name}${route.path}`,
      html: route.html,
    })),
  }
}

/** The endpoint a runner handed this process through the environment, if
 * any. A file invoked on its own (no runner) gets a standalone daemon child
 * below instead. */
function endpointFromEnvironment(): DaemonEndpoint | null {
  const url = process.env.CODENOMAD_FIXTURE_URL
  const secret = process.env.CODENOMAD_FIXTURE_SECRET
  return url && secret ? { url, secret, pid: 0 } : null
}

async function registerOn(endpoint: DaemonEndpoint, definition: FixtureDefinition): Promise<string> {
  const response = await fetch(new URL("/__daemon/register", endpoint.url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-fixture-secret": endpoint.secret },
    body: JSON.stringify(definition),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`fixture registration failed: ${await response.text()}`)
  return (await response.json()).url
}

let standalone: Promise<DaemonEndpoint> | null = null

/** A file invoked outside a runner gets one daemon child for the whole
 * process — no discovery directory, the endpoint arrives over the spawn,
 * warmup stays off (the first fixture page pays the cold graph, exactly
 * like the old per-file owned servers), and the child follows its parent
 * to the grave, surviving even a SIGKILLed borrower. */
async function ensureStandaloneDaemon(): Promise<DaemonEndpoint> {
  standalone ??= import("./fixture-daemon/run").then(({ spawnDaemon }) =>
    spawnDaemon({ uiRoot, warmup: false, logPrefix: "codenomad-fixture-standalone-" })
      .catch(error => { standalone = null; throw error }))
      .then(daemon => ({ url: daemon.url, secret: daemon.secret, pid: daemon.pid }))
  return standalone
}

/** Borrows a fixture page: registered on the runner's daemon when the
 * environment carries its endpoint, otherwise on this process's own
 * standalone daemon child. Nothing is written to the filesystem and no
 * signal is ever sent by pid. */
export async function borrowFixture(definition: FixtureDefinition, options: BorrowOptions = {}): Promise<BorrowedFixture> {
  const request = namespaced(definition)
  const endpoint = options.endpoint ?? endpointFromEnvironment()
  if (endpoint) {
    try {
      return { url: await registerOn(endpoint, request), close: async () => {} }
    } catch { /* the runner's daemon fell over mid-run; the standalone child takes it */ }
  }
  const standaloneEndpoint = await ensureStandaloneDaemon()
  return { url: await registerOn(standaloneEndpoint, request), close: async () => {} }
}
