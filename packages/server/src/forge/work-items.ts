import type { ForgeProvider, ForgeRepository, ForgeUnavailableReason, ForgeWorkItemKind, ForgeWorkItemsResult } from "../panel-extensions/contract"
import { FORGE_APIS, forgeWebUrl, type ForgeApi } from "./providers"
import { readForgeRemote, type ForgeRemote } from "./remote"
import {
  anonymousTransport, findTeaLogin, ForgeCliUnavailable, includedCliTransport, preferCli, runProcess, teaTransport,
  type ForgeResponse, type ForgeTransport, type ProcessRunner,
} from "./transport"

/** Public forges read anonymously when no CLI is signed in; any other host needs a CLI signed in to it. */
const PUBLIC_FORGES: Record<string, ForgeProvider> = {
  "github.com": "github", "gitlab.com": "gitlab", "codeberg.org": "gitea", "gitea.com": "gitea",
}
export const FORGE_MAX_PAGE = 50
const PAGE_TTL_MS = 30_000
const REPOSITORY_TTL_MS = 60_000
const CACHE_LIMIT = 200
// Host-wide budget of forge requests (CLI processes or anonymous fetches), whatever the number of panels.
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
type Cached<T> = { at: number; value: Promise<T>; settled: boolean }
type Shared = Cached<ForgeWorkItemsResult> & { controller: AbortController; consumers: number }

export class ForgeRequestError extends Error {}
export class ForgeBusyError extends Error {}

/**
 * Bounded, read-only issue and pull request listings for a project's forge
 * repository, through the user's signed-in CLI (gh, glab, tea) or, on public
 * forges, anonymously. Identical reads share one request, which is cancelled
 * once no caller waits for it.
 */
export class ForgeWorkItems {
  private readonly repositories = new Map<string, Cached<Resolved>>()
  private readonly pages = new Map<string, Shared>()
  private readonly run: ProcessRunner
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private running = 0
  private readonly queue: Array<() => void> = []

  constructor(options: { run?: ProcessRunner; fetcher?: typeof fetch; now?: () => number } = {}) {
    this.run = options.run ?? runProcess
    this.fetcher = options.fetcher ?? fetch
    this.now = options.now ?? Date.now
  }

  list(directory: string, request: ForgeWorkItemsQuery, signal?: AbortSignal): Promise<ForgeWorkItemsResult> {
    const query = request.query.trim()
    const key = JSON.stringify([directory, request.kind, query, request.page])
    let entry = this.pages.get(key)
    // A cancelled read still finishing is never joined: a new caller starts its own.
    const reusable = entry && !entry.controller.signal.aborted
      && (!entry.settled || (!request.fresh && this.now() - entry.at < PAGE_TTL_MS))
    if (!entry || !reusable) {
      const controller = new AbortController()
      const created: Shared = { at: this.now(), settled: false, controller, consumers: 0,
        value: this.read(directory, request.kind, query, request.page, request.fresh ?? false, controller.signal) }
      entry = created
      this.remember(this.pages, key, created)
      void created.value.then(() => { created.settled = true }, () => {
        created.settled = true
        // Failures and cancellations are never served from the cache.
        if (this.pages.get(key) === created) this.pages.delete(key)
      })
    }
    return this.consume(entry, signal)
  }

  /** The web page of one item of this project's repository, built locally (no request). */
  async itemUrl(directory: string, kind: ForgeWorkItemKind, number: number): Promise<string | undefined> {
    const resolved = await this.resolve(directory, false)
    if (typeof resolved === "string") return undefined
    return forgeWebUrl(resolved.api.provider, resolved.remote.host, resolved.remote.path, kind, number)
  }

  private consume(entry: Shared, signal: AbortSignal | undefined): Promise<ForgeWorkItemsResult> {
    if (!signal) return entry.value
    if (signal.aborted) return Promise.reject(signal.reason)
    entry.consumers += 1
    return new Promise((resolve, reject) => {
      const leave = () => {
        signal.removeEventListener("abort", abandon)
        entry.consumers -= 1
      }
      const abandon = () => {
        leave()
        // The last caller leaving cancels the shared read, its CLI process or fetch included.
        if (entry.consumers === 0 && !entry.settled) entry.controller.abort(signal.reason)
        reject(signal.reason)
      }
      signal.addEventListener("abort", abandon, { once: true })
      entry.value.then(value => { leave(); resolve(value) }, error => { leave(); reject(error) })
    })
  }

  private async read(directory: string, kind: ForgeWorkItemKind, query: string, page: number, fresh: boolean, signal: AbortSignal): Promise<ForgeWorkItemsResult> {
    const resolved = await this.resolve(directory, fresh)
    if (typeof resolved === "string") return { status: "unavailable", reason: resolved }
    const { remote, api, transport } = resolved
    const exact = /^#?(\d{1,9})$/.exec(query)
    const path = exact ? api.itemPath(remote.path, kind, Number(exact[1])) : api.listPath(remote.path, kind, query, page)
    let response: ForgeResponse
    try {
      response = await this.admit(signal, () => transport.request(path, signal))
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

  /** Runs one forge request within the host-wide budget; a full queue refuses instead of piling up. */
  private async admit<T>(signal: AbortSignal, request: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw signal.reason
    if (this.running < MAX_RUNNING && !this.queue.length) this.running += 1
    else {
      if (this.queue.length >= MAX_QUEUED) throw new ForgeBusyError("Forge requests busy")
      // A finishing request hands its slot over to the first waiter.
      await new Promise<void>((resolve, reject) => {
        const start = () => { signal.removeEventListener("abort", cancel); resolve() }
        const cancel = () => { this.queue.splice(this.queue.indexOf(start), 1); reject(signal.reason) }
        this.queue.push(start)
        signal.addEventListener("abort", cancel, { once: true })
      })
    }
    try {
      return await request()
    } finally {
      const next = this.queue.shift()
      if (next) next()
      else this.running -= 1
    }
  }

  private resolve(directory: string, fresh: boolean): Promise<Resolved> {
    const current = this.repositories.get(directory)
    if (current && (!current.settled || (!fresh && this.now() - current.at < REPOSITORY_TTL_MS))) return current.value
    const entry: Cached<Resolved> = { at: this.now(), settled: false, value: this.identify(directory) }
    this.remember(this.repositories, directory, entry)
    void entry.value.then(() => { entry.settled = true }, () => {
      entry.settled = true
      if (this.repositories.get(directory) === entry) this.repositories.delete(directory)
    })
    return entry.value
  }

  private async identify(directory: string): Promise<Resolved> {
    const remote = await readForgeRemote(directory)
    if (!remote) return "no_remote"
    const known = PUBLIC_FORGES[remote.host]
    // A self-hosted forge is identified, and read, only through a CLI the user signed in to it.
    const provider = known ?? await this.signedInProvider(remote.host)
    if (!provider) return "unsupported_host"
    const api = FORGE_APIS[provider]
    const anonymous = known ? anonymousTransport(api.anonymousBase(remote.host), this.fetcher) : undefined
    const cli = provider === "github" ? includedCliTransport("gh", remote.host, this.run)
      : provider === "gitlab" ? includedCliTransport("glab", remote.host, this.run)
      : await findTeaLogin(remote.host, this.run).then(login => login ? teaTransport(login, this.run) : undefined)
    const transport = preferCli(cli, anonymous)
    return transport ? { remote, api, transport } : "sign_in"
  }

  private async signedInProvider(host: string): Promise<ForgeProvider | undefined> {
    if ((await this.run("gh", ["auth", "status", "--hostname", host])).code === 0) return "github"
    if ((await this.run("glab", ["auth", "status", "--hostname", host])).code === 0) return "gitlab"
    if (await findTeaLogin(host, this.run)) return "gitea"
    return undefined
  }

  private remember<T>(cache: Map<string, T>, key: string, value: T): void {
    cache.delete(key)
    cache.set(key, value)
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  }
}

function classifyFailure(response: ForgeResponse): ForgeUnavailableReason | undefined {
  if (response.status >= 200 && response.status < 300) return undefined
  if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) return "rate_limited"
  // Private repositories read as missing or unsearchable without the user's sign-in.
  if ([401, 403, 404, 422].includes(response.status)) return "sign_in"
  throw new ForgeRequestError(`Forge request failed (HTTP ${response.status})`)
}
