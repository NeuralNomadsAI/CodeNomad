import type { ForgeProvider, ForgeWorkItem, ForgeWorkItemKind } from "../panel-extensions/contract"
import type { ForgeResponse } from "./transport"

export const FORGE_PAGE_SIZE = 20

export interface ForgePage { items: ForgeWorkItem[]; hasMore: boolean; total?: number }

/** Request paths and response mapping of one forge's REST API, relative to its API base. */
export interface ForgeApi {
  provider: ForgeProvider
  /** API base for anonymous access, ending with a slash. */
  anonymousBase(host: string): string
  listPath(path: string, kind: ForgeWorkItemKind, query: string, page: number): string
  itemPath(path: string, kind: ForgeWorkItemKind, number: number): string
  parseList(response: ForgeResponse, kind: ForgeWorkItemKind, page: number): ForgePage
  /** The item, or undefined when it exists but is of the other kind. */
  parseItem(body: string, kind: ForgeWorkItemKind): ForgeWorkItem | undefined
}

const encode = encodeURIComponent
const json = (body: string) => JSON.parse(body) as any
const totalHeader = (response: ForgeResponse, name: string) => {
  const value = Number(response.headers.get(name))
  return Number.isFinite(value) && response.headers.has(name) ? value : undefined
}

type GitHubItem = { number: number; title: string; state: string; draft?: boolean; html_url: string; updated_at: string
  user?: { login?: string }; labels?: Array<{ name?: string } | string>; pull_request?: { merged_at?: string | null } }

function gitHubItem(raw: GitHubItem): ForgeWorkItem {
  return {
    kind: raw.pull_request ? "pullRequest" : "issue", number: raw.number, title: raw.title,
    state: raw.state === "open" ? "open" : raw.pull_request?.merged_at ? "merged" : "closed",
    draft: Boolean(raw.draft), author: raw.user?.login, updatedAt: raw.updated_at, url: raw.html_url,
    labels: (raw.labels ?? []).map(label => typeof label === "string" ? label : label.name ?? "").filter(Boolean),
  }
}

/**
 * Search words as literal quoted terms: GitHub's search language would
 * otherwise let words such as `repo:other/project`, `OR` or `(...)` widen the
 * search beyond this repository.
 */
export function literalSearchTerms(query: string): string {
  return query.split(/\s+/).map(term => term.replace(/["():\\]/g, ""))
    .filter(term => term && !/^(?:AND|OR|NOT)$/.test(term)).map(term => `"${term}"`).join(" ")
}

export const githubApi: ForgeApi = {
  provider: "github",
  anonymousBase: host => host === "github.com" ? "https://api.github.com/" : `https://${host}/api/v3/`,
  // Search returns one kind with its open total in a single bounded request (results stop at 1,000).
  listPath: (path, kind, query, page) => `search/issues?q=${encode(`repo:${path} is:${kind === "issue" ? "issue" : "pr"} is:open ${literalSearchTerms(query)}`.trim())}`
    + `&sort=updated&order=desc&per_page=${FORGE_PAGE_SIZE}&page=${page}`,
  itemPath: (path, _kind, number) => `repos/${path}/issues/${number}`,
  parseList(response, _kind, page) {
    const body = json(response.body) as { total_count: number; items: GitHubItem[] }
    return { items: body.items.slice(0, FORGE_PAGE_SIZE).map(gitHubItem), total: body.total_count,
      hasMore: page * FORGE_PAGE_SIZE < Math.min(body.total_count, 1000) }
  },
  parseItem(body, kind) {
    const item = gitHubItem(json(body))
    return item.kind === kind ? item : undefined
  },
}

type GitLabItem = { iid: number; title: string; state: string; draft?: boolean; web_url: string; updated_at: string
  author?: { username?: string }; labels?: string[] }

function gitLabItem(raw: GitLabItem, kind: ForgeWorkItemKind): ForgeWorkItem {
  return {
    kind, number: raw.iid, title: raw.title, state: raw.state === "opened" ? "open" : raw.state === "merged" ? "merged" : "closed",
    draft: Boolean(raw.draft), author: raw.author?.username, labels: raw.labels ?? [], updatedAt: raw.updated_at, url: raw.web_url,
  }
}

const gitLabCollection = (kind: ForgeWorkItemKind) => kind === "issue" ? "issues" : "merge_requests"

export const gitlabApi: ForgeApi = {
  provider: "gitlab",
  anonymousBase: host => `https://${host}/api/v4/`,
  listPath: (path, kind, query, page) => `projects/${encode(path)}/${gitLabCollection(kind)}?state=opened&order_by=updated_at&sort=desc`
    + `&per_page=${FORGE_PAGE_SIZE}&page=${page}${query ? `&search=${encode(query)}&in=title,description` : ""}`,
  itemPath: (path, kind, number) => `projects/${encode(path)}/${gitLabCollection(kind)}/${number}`,
  parseList(response, kind, page) {
    const items = (json(response.body) as GitLabItem[]).slice(0, FORGE_PAGE_SIZE).map(item => gitLabItem(item, kind))
    const total = totalHeader(response, "x-total")
    // x-total is omitted beyond 10,000 results; x-next-page still tells whether a page follows.
    const next = response.headers.get("x-next-page")
    return { items, total, hasMore: next !== undefined ? Boolean(next) : total !== undefined && page * FORGE_PAGE_SIZE < total }
  },
  parseItem: (body, kind) => gitLabItem(json(body), kind),
}

type GiteaItem = { number: number; title: string; state: string; html_url: string; updated_at: string
  user?: { login?: string }; labels?: Array<{ name?: string }>; pull_request?: { merged?: boolean; draft?: boolean } | null }

function giteaItem(raw: GiteaItem): ForgeWorkItem {
  return {
    kind: raw.pull_request ? "pullRequest" : "issue", number: raw.number, title: raw.title,
    state: raw.state === "open" ? "open" : raw.pull_request?.merged ? "merged" : "closed",
    draft: Boolean(raw.pull_request?.draft), author: raw.user?.login, updatedAt: raw.updated_at, url: raw.html_url,
    labels: (raw.labels ?? []).map(label => label.name ?? "").filter(Boolean),
  }
}

export const giteaApi: ForgeApi = {
  provider: "gitea",
  anonymousBase: host => `https://${host}/api/v1/`,
  listPath: (path, kind, query, page) => `repos/${path}/issues?state=open&type=${kind === "issue" ? "issues" : "pulls"}`
    + `&limit=${FORGE_PAGE_SIZE}&page=${page}${query ? `&q=${encode(query)}` : ""}`,
  itemPath: (path, _kind, number) => `repos/${path}/issues/${number}`,
  parseList(response, _kind, page) {
    const items = (json(response.body) as GiteaItem[]).slice(0, FORGE_PAGE_SIZE).map(giteaItem)
    const total = totalHeader(response, "x-total-count")
    // The server may cap `limit` below the requested size; its Link header knows whether a page follows.
    const link = response.headers.get("link")
    return { items, total, hasMore: link !== undefined ? /rel="next"/.test(link)
      : total !== undefined ? page * FORGE_PAGE_SIZE < total : items.length === FORGE_PAGE_SIZE }
  },
  parseItem(body, kind) {
    const item = giteaItem(json(body))
    return item.kind === kind ? item : undefined
  },
}

export const FORGE_APIS: Record<ForgeProvider, ForgeApi> = { github: githubApi, gitlab: gitlabApi, gitea: giteaApi }

/** The page of the repository's web interface for one item. */
export function forgeWebUrl(provider: ForgeProvider, host: string, path: string, kind?: ForgeWorkItemKind, number?: number): string {
  const base = `https://${host}/${path}`
  if (!kind || !number) return base
  if (provider === "gitlab") return `${base}/-/${kind === "issue" ? "issues" : "merge_requests"}/${number}`
  if (provider === "github") return `${base}/${kind === "issue" ? "issues" : "pull"}/${number}`
  return `${base}/${kind === "issue" ? "issues" : "pulls"}/${number}`
}
