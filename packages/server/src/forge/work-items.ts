import type { ForgeProvider, ForgeRepository, ForgeUnavailableReason, ForgeWorkItemKind, ForgeWorkItemsResult } from "../panel-extensions/contract"
import { FORGE_APIS, forgeWebUrl, type ForgeApi } from "./providers"
import { readForgeRemote, type ForgeRemote } from "./remote"
import {
  anonymousTransport, findTeaLogin, includedCliTransport, preferCli, runProcess, teaTransport,
  type ForgeResponse, type ForgeTransport, type ProcessRunner,
} from "./transport"

const KNOWN_HOSTS: Record<string, ForgeProvider> = {
  "github.com": "github", "gitlab.com": "gitlab", "codeberg.org": "gitea", "gitea.com": "gitea",
}
const PAGE_TTL_MS = 30_000
const REPOSITORY_TTL_MS = 60_000
const CACHE_LIMIT = 200

export interface ForgeWorkItemsQuery {
  kind: ForgeWorkItemKind
  query: string
  page: number
  /** Bypass cached pages (an explicit refresh). */
  fresh?: boolean
}

type Resolved = { remote: ForgeRemote; api: ForgeApi; transport: ForgeTransport } | ForgeUnavailableReason
type Cached<T> = { at: number; value: Promise<T> }

export class ForgeRequestError extends Error {}

/**
 * Bounded, read-only issue and pull request listings for a project's forge
 * repository, through the user's signed-in CLI (gh, glab, tea) or anonymously.
 */
export class ForgeWorkItems {
  private readonly repositories = new Map<string, Cached<Resolved>>()
  private readonly pages = new Map<string, Cached<ForgeWorkItemsResult>>()
  private readonly hosts = new Map<string, Promise<ForgeProvider | undefined>>()
  private readonly run: ProcessRunner
  private readonly fetcher: typeof fetch
  private readonly now: () => number

  constructor(options: { run?: ProcessRunner; fetcher?: typeof fetch; now?: () => number } = {}) {
    this.run = options.run ?? runProcess
    this.fetcher = options.fetcher ?? fetch
    this.now = options.now ?? Date.now
  }

  async list(directory: string, request: ForgeWorkItemsQuery): Promise<ForgeWorkItemsResult> {
    const query = request.query.trim()
    const key = JSON.stringify([directory, request.kind, query, request.page])
    return this.cached(this.pages, key, PAGE_TTL_MS, request.fresh ?? false, () => this.read(directory, request.kind, query, request.page, request.fresh ?? false))
  }

  /** The web page of one item of this project's repository, built locally (no request). */
  async itemUrl(directory: string, kind: ForgeWorkItemKind, number: number): Promise<string | undefined> {
    const resolved = await this.resolve(directory, false)
    if (typeof resolved === "string") return undefined
    return forgeWebUrl(resolved.api.provider, resolved.remote.host, resolved.remote.path, kind, number)
  }

  private async read(directory: string, kind: ForgeWorkItemKind, query: string, page: number, fresh: boolean): Promise<ForgeWorkItemsResult> {
    const resolved = await this.resolve(directory, fresh)
    if (typeof resolved === "string") return { status: "unavailable", reason: resolved }
    const { remote, api, transport } = resolved
    const exact = /^#?(\d{1,9})$/.exec(query)
    const response = await transport.request(exact ? api.itemPath(remote.path, kind, Number(exact[1])) : api.listPath(remote.path, kind, query, page))
    const repository: ForgeRepository = { provider: api.provider, host: remote.host, path: remote.path,
      webUrl: forgeWebUrl(api.provider, remote.host, remote.path), access: transport.access }
    if (exact && response.status === 404) return { status: "ok", repository, items: [], page: 1, hasMore: false }
    const failure = classifyFailure(response)
    if (failure) return { status: "unavailable", reason: failure }
    if (exact) {
      const item = api.parseItem(response.body, kind)
      return { status: "ok", repository, items: item ? [item] : [], page: 1, hasMore: false }
    }
    return { status: "ok", repository, page, ...api.parseList(response, kind, page) }
  }

  private resolve(directory: string, fresh: boolean): Promise<Resolved> {
    return this.cached(this.repositories, directory, REPOSITORY_TTL_MS, fresh, async () => {
      const remote = await readForgeRemote(directory)
      if (!remote) return "no_remote"
      const provider = await this.detect(remote.host)
      if (!provider) return "unsupported_host"
      const api = FORGE_APIS[provider]
      const anonymous = anonymousTransport(api.anonymousBase(remote.host), this.fetcher)
      if (provider === "github") return { remote, api, transport: preferCli(includedCliTransport("gh", remote.host, this.run), anonymous) }
      if (provider === "gitlab") return { remote, api, transport: preferCli(includedCliTransport("glab", remote.host, this.run), anonymous) }
      const login = await findTeaLogin(remote.host, this.run)
      return { remote, api, transport: preferCli(login ? teaTransport(login, this.run) : undefined, anonymous) }
    })
  }

  /** Known public forges, then a CLI signed in to the host, then anonymous API probes. */
  private detect(host: string): Promise<ForgeProvider | undefined> {
    const known = KNOWN_HOSTS[host]
    if (known) return Promise.resolve(known)
    let detected = this.hosts.get(host)
    if (!detected) {
      detected = this.probe(host)
      this.hosts.set(host, detected)
      // An unreachable host may come back; only a positive answer is remembered.
      void detected.then(provider => { if (!provider) this.hosts.delete(host) })
    }
    return detected
  }

  private async probe(host: string): Promise<ForgeProvider | undefined> {
    if ((await this.run("gh", ["auth", "status", "--hostname", host])).code === 0) return "github"
    if ((await this.run("glab", ["auth", "status", "--hostname", host])).code === 0) return "gitlab"
    if (await findTeaLogin(host, this.run)) return "gitea"
    const get = (path: string) => this.fetcher(`https://${host}/${path}`, {
      headers: { Accept: "application/json", "User-Agent": "CodeNomad" }, redirect: "error", signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined)
    const gitea = await get("api/v1/version")
    if (gitea?.ok && typeof (await gitea.json().catch(() => ({})))?.version === "string") return "gitea"
    const gitlab = await get("api/v4/version")
    if (gitlab && [...gitlab.headers.keys()].some(name => /^(x-)?gitlab-/i.test(name))) return "gitlab"
    const github = await get("api/v3/meta")
    if (github?.headers.has("x-github-request-id")) return "github"
    return undefined
  }

  private cached<T>(cache: Map<string, Cached<T>>, key: string, ttl: number, fresh: boolean, load: () => Promise<T>): Promise<T> {
    const current = cache.get(key)
    if (current && !fresh && this.now() - current.at < ttl) return current.value
    const value = load()
    cache.delete(key)
    cache.set(key, { at: this.now(), value })
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
    // Failures are never served from the cache.
    void value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key) })
    return value
  }
}

function classifyFailure(response: ForgeResponse): ForgeUnavailableReason | undefined {
  if (response.status >= 200 && response.status < 300) return undefined
  if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) return "rate_limited"
  // Private repositories read as missing or unsearchable without the user's sign-in.
  if ([401, 403, 404, 422].includes(response.status)) return "sign_in"
  throw new ForgeRequestError(`Forge request failed (HTTP ${response.status})`)
}
