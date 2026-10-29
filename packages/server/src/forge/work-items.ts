import type { ForgeProvider, ForgeRepository, ForgeUnavailableReason, ForgeWorkItemKind, ForgeWorkItemsResult } from "../panel-extensions/contract"
import { FORGE_APIS, forgeWebUrl, type ForgeApi } from "./providers"
import { readForgeRemote, type ForgeRemote } from "./remote"
import { RequestBudget, SharedLoads } from "./shared-loads"
import {
  anonymousTransport, findTeaLogin, ForgeCliUnavailable, includedCliTransport, preferCli, runProcess, teaTransport,
  type ForgeResponse, type ForgeTransport, type ProcessRunner,
} from "./transport"

export { ForgeBusyError } from "./shared-loads"

/** Public forges read anonymously when no CLI is signed in; any other host needs a CLI signed in to it. */
const PUBLIC_FORGES: Record<string, ForgeProvider> = {
  "github.com": "github", "gitlab.com": "gitlab", "codeberg.org": "gitea", "gitea.com": "gitea",
}
export const FORGE_MAX_PAGE = 50
const PAGE_TTL_MS = 30_000
const REPOSITORY_TTL_MS = 60_000
const CACHE_LIMIT = 200
// Host-wide budget of forge processes and fetches, whatever the number of panels.
const MAX_RUNNING = 4
const MAX_QUEUED = 16

export interface ForgeWorkItemsQuery {
  kind: ForgeWorkItemKind
  query: string
  page: number
  /** Bypass cached pages (an explicit refresh); joins an identical read still in flight. */
  fresh?: boolean
}

type Resolved = { remote: ForgeRemote; api: ForgeApi; transport: ForgeTransport } | ForgeUnavailableReason

export class ForgeRequestError extends Error {}

/**
 * Bounded, read-only issue and pull request listings for a project's forge
 * repository, through the user's signed-in CLI (gh, glab, tea) or, on public
 * forges, anonymously. Repository discovery and page reads are shared loads,
 * cancelled once no caller waits, and every CLI process or fetch runs within
 * one host-wide budget.
 */
export class ForgeWorkItems {
  private readonly repositories: SharedLoads<Resolved>
  private readonly pages: SharedLoads<ForgeWorkItemsResult>
  private readonly budget = new RequestBudget(MAX_RUNNING, MAX_QUEUED)
  private readonly run: ProcessRunner
  private readonly fetcher: typeof fetch

  constructor(options: { run?: ProcessRunner; fetcher?: typeof fetch; now?: () => number } = {}) {
    const now = options.now ?? Date.now
    this.repositories = new SharedLoads(REPOSITORY_TTL_MS, CACHE_LIMIT, now)
    this.pages = new SharedLoads(PAGE_TTL_MS, CACHE_LIMIT, now)
    this.run = options.run ?? runProcess
    this.fetcher = options.fetcher ?? fetch
  }

  list(directory: string, request: ForgeWorkItemsQuery, signal?: AbortSignal): Promise<ForgeWorkItemsResult> {
    const query = request.query.trim()
    const fresh = request.fresh ?? false
    return this.pages.get(JSON.stringify([directory, request.kind, query, request.page]), fresh,
      shared => this.read(directory, request.kind, query, request.page, fresh, shared), signal)
  }

  /** The web page of one item of this project's repository, built locally once the repository is known. */
  async itemUrl(directory: string, kind: ForgeWorkItemKind, number: number, signal?: AbortSignal): Promise<string | undefined> {
    const resolved = await this.resolve(directory, false, signal)
    if (typeof resolved === "string") return undefined
    return forgeWebUrl(resolved.api.provider, resolved.remote.host, resolved.remote.path, kind, number)
  }

  private async read(directory: string, kind: ForgeWorkItemKind, query: string, page: number, fresh: boolean, signal: AbortSignal): Promise<ForgeWorkItemsResult> {
    const resolved = await this.resolve(directory, fresh, signal)
    if (typeof resolved === "string") return { status: "unavailable", reason: resolved }
    const { remote, api, transport } = resolved
    const exact = /^#?(\d{1,9})$/.exec(query)
    const path = exact ? api.itemPath(remote.path, kind, Number(exact[1])) : api.listPath(remote.path, kind, query, page)
    let response: ForgeResponse
    try {
      response = await this.budget.run(signal, () => transport.request(path, signal))
    } catch (error) {
      if (error instanceof ForgeCliUnavailable) return { status: "unavailable", reason: "sign_in" }
      throw error
    }
    const repository: ForgeRepository = { provider: api.provider, host: remote.host, path: remote.path,
      webUrl: forgeWebUrl(api.provider, remote.host, remote.path), access: transport.access }
    if (exact && response.status === 404) return { status: "ok", repository, items: [], page: 1, hasMore: false }
    const failure = classifyFailure(response)
    if (failure) return { status: "unavailable", reason: failure }
    // Only items of this repository are published, whatever the forge returned.
    const owned = (url: string) => url.toLowerCase().startsWith(`${repository.webUrl.toLowerCase()}/`)
    if (exact) {
      const item = api.parseItem(response.body, kind)
      return { status: "ok", repository, items: item && owned(item.url) ? [item] : [], page: 1, hasMore: false }
    }
    const parsed = api.parseList(response, kind, page)
    return { status: "ok", repository, page, items: parsed.items.filter(item => owned(item.url)), total: parsed.total,
      hasMore: parsed.hasMore && page < FORGE_MAX_PAGE }
  }

  private resolve(directory: string, fresh: boolean, signal?: AbortSignal): Promise<Resolved> {
    return this.repositories.get(directory, fresh, shared => this.identify(directory, shared), signal)
  }

  private async identify(directory: string, signal: AbortSignal): Promise<Resolved> {
    const remote = await readForgeRemote(directory)
    if (signal.aborted) throw signal.reason
    if (!remote) return "no_remote"
    const known = PUBLIC_FORGES[remote.host]
    const run: ProcessRunner = (command, args) => this.budget.run(signal, () => this.run(command, args, signal))
    // A self-hosted forge is identified, and read, only through a CLI the user signed in to it.
    const provider = known ?? await this.signedInProvider(remote.host, run)
    if (!provider) return "unsupported_host"
    const api = FORGE_APIS[provider]
    const anonymous = known ? anonymousTransport(api.anonymousBase(remote.host), this.fetcher) : undefined
    const cli = provider === "github" ? includedCliTransport("gh", remote.host, this.run)
      : provider === "gitlab" ? includedCliTransport("glab", remote.host, this.run)
      : await findTeaLogin(remote.host, run).then(login => login ? teaTransport(login, this.run) : undefined)
    const transport = preferCli(cli, anonymous)
    return transport ? { remote, api, transport } : "sign_in"
  }

  private async signedInProvider(host: string, run: ProcessRunner): Promise<ForgeProvider | undefined> {
    if ((await run("gh", ["auth", "status", "--hostname", host])).code === 0) return "github"
    if ((await run("glab", ["auth", "status", "--hostname", host])).code === 0) return "gitlab"
    if (await findTeaLogin(host, run)) return "gitea"
    return undefined
  }
}

function classifyFailure(response: ForgeResponse): ForgeUnavailableReason | undefined {
  if (response.status >= 200 && response.status < 300) return undefined
  if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) return "rate_limited"
  // Private repositories read as missing or unsearchable without the user's sign-in.
  if ([401, 403, 404, 422].includes(response.status)) return "sign_in"
  throw new ForgeRequestError(`Forge request failed (HTTP ${response.status})`)
}
