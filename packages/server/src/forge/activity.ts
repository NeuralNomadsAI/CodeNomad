import { z } from "zod"
import { forgeWebUrl } from "./providers"
import type { ForgeResponse } from "./transport"
import type { MissionRepositoryCondition } from "../missions/mission-repository-condition"

export const ACTIVITY_PAGE_SIZE = 50
const timestamp = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString())
const common = { title: z.string().min(1).max(4096).transform(value => value.slice(0, 240)), created_at: timestamp, updated_at: timestamp }
const user = z.object({ login: z.string().min(1).max(100) }).nullable()
const github = z.object({ ...common, number: z.number().int().positive().safe(), html_url: z.string(), user,
  pull_request: z.object({ merged_at: timestamp.nullable().optional() }).optional() })
const gitlab = z.object({ ...common, iid: z.number().int().positive().safe(), web_url: z.string(),
  author: z.object({ username: z.string().min(1).max(100) }).nullable(), merged_at: timestamp.nullable().optional() })
const gitea = z.object({ ...common, number: z.number().int().positive().safe(), html_url: z.string(), user,
  pull_request: z.unknown().optional(), merged: z.boolean().optional(), merged_at: timestamp.nullable().optional() })

/** Activity queries include closed work and retain timestamps; Contribute's open-item pages remain independent. */
export function forgeActivityPath(condition: MissionRepositoryCondition, page: number, since?: string) {
  const { provider, repository, event } = condition, issue = event === "issue-created"
  const query = new URLSearchParams({ page: String(page), state: "all" })
  let endpoint: string
  if (provider === "github") {
    endpoint = `repos/${repository}/issues`
    query.set("per_page", String(ACTIVITY_PAGE_SIZE)); query.set("sort", "updated"); query.set("direction", "desc")
    if (since) query.set("since", since)
    if (condition.author) query.set("creator", condition.author)
  } else if (provider === "gitlab") {
    endpoint = `projects/${encodeURIComponent(repository)}/${issue ? "issues" : "merge_requests"}`
    query.set("scope", "all"); query.set("per_page", String(ACTIVITY_PAGE_SIZE)); query.set("order_by", "updated_at"); query.set("sort", "desc")
    if (since) query.set("updated_after", since)
    if (condition.author) query.set("author_username", condition.author)
  } else {
    endpoint = `repos/${repository}/${issue ? "issues" : "pulls"}`
    query.set("limit", String(ACTIVITY_PAGE_SIZE))
    if (issue) { query.set("type", "issues"); if (since) query.set("since", since); if (condition.author) query.set("created_by", condition.author) }
    else query.set("sort", "recentupdate")
  }
  return `${endpoint}?${query}`
}

export function forgeActivityPage(response: ForgeResponse, condition: MissionRepositoryCondition, seen = 0) {
  const { provider, event, repository, host } = condition, issue = event === "issue-created"
  const values = z.array(z.unknown()).max(ACTIVITY_PAGE_SIZE).parse(JSON.parse(response.body))
  const rows = values.map(value => {
    const item = provider === "github" ? github.parse(value) : provider === "gitlab" ? gitlab.parse(value) : gitea.parse(value)
    const number = "iid" in item ? item.iid : item.number
    const pull = provider === "github" || provider === "gitea" && issue ? !!("pull_request" in item && item.pull_request) : !issue
    const mergedAt = provider === "github" ? (item as z.infer<typeof github>).pull_request?.merged_at : (item as z.infer<typeof gitlab>).merged_at
    const author = "author" in item ? item.author?.username : "user" in item ? item.user?.login : undefined
    const url = "web_url" in item ? item.web_url : item.html_url
    if (url.toLowerCase() !== forgeWebUrl(provider, host, repository, pull ? "pullRequest" : "issue", number).toLowerCase())
      throw new Error("Foreign forge activity URL")
    const at = event === "pull-request-merged" ? mergedAt : item.created_at
    if (item.updated_at < item.created_at || at && at > item.updated_at) throw new Error("Invalid forge activity time")
    return { id: String(number), at: at ?? item.created_at, updatedAt: item.updated_at, repository, title: item.title, url,
      ...(author ? { author } : {}), matches: (issue !== pull) && (event !== "pull-request-merged" || !!mergedAt)
        && (!condition.author || author?.toLowerCase() === condition.author) }
  })
  const link = response.headers.get("link"), next = response.headers.get("x-next-page")
  const total = response.headers.get("x-total") ?? response.headers.get("x-total-count")
  if (total !== undefined && (!/^\d+$/.test(total) || !Number.isSafeInteger(Number(total)))) throw new Error("Invalid forge activity total")
  // Empty or contradictory pagination is refused by the caller; never follow a forge-supplied URL.
  const more = next !== undefined ? !!next : link !== undefined ? /rel="?next"?/.test(link)
    : total !== undefined ? Number(total) > seen + values.length : values.length === ACTIVITY_PAGE_SIZE
  return { rows, more, ordered: provider !== "gitea" || !issue }
}
