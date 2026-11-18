import { z } from "zod"
import { includedCliTransport, type ForgeTransport } from "../forge/transport"
import { canonicalAuthority } from "./authority-protocol"
import { missionSourceKey, type MissionSourceCheckpoint } from "./mission-document"
import { githubRepositorySchema, missionGithubConditionSchema, missionGithubCheckpointSchema as cursor,
  type MissionGithubCondition, type MissionGithubEvent } from "./mission-github-condition"
import { stableToken } from "./receipt-identity"

const PAGE_SIZE = 50, MAX_PAGES = 4, DEADLINE_MS = 10_000
const timestamp = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString())
const identifier = z.string().min(1).max(240).regex(/^\d+$/)
const title = z.string().min(1).max(4096).transform(value => value.slice(0, 240))
type Row = MissionGithubEvent & { matches: boolean }
const rawIssue = z.object({ number: z.number().int().positive().safe(), created_at: timestamp, title,
  html_url: z.string(), user: z.object({ login: z.string().max(100) }).nullable(), pull_request: z.object({}).optional() })
const rawAlert = z.object({ number: z.number().int().positive().safe(), created_at: timestamp, html_url: z.string(),
  security_advisory: z.object({ summary: title }).nullable(), dependency: z.object({ package: z.object({ name: title }) }) })
const rawNotification = z.object({ id: identifier, updated_at: timestamp, repository: z.object({ full_name: githubRepositorySchema }),
  subject: z.object({ title, url: z.string().nullable() }) })
const unavailable = (): never => { throw new Error("Mission GitHub source unavailable, changed or over capacity") }

function ownedUrl(value: string, repository: string, path: string) {
  const url = new URL(value)
  if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash
    || url.pathname.toLowerCase() !== `/${repository}/${path}`.toLowerCase()) return unavailable()
  return value
}

function rows(input: unknown, condition: MissionGithubCondition): Row[] {
  const body = z.array(z.unknown()).max(PAGE_SIZE).parse(input)
  if (condition.kind === "github-notification") return body.map(value => {
    const item = rawNotification.parse(value), repository = item.repository.full_name
    if (condition.repository && repository !== condition.repository) return unavailable()
    if (item.subject.url) {
      const url = new URL(item.subject.url)
      if (url.origin !== "https://api.github.com" || url.username || url.password || url.search || url.hash
        || !url.pathname.toLowerCase().startsWith(`/repos/${repository}/`)) return unavailable()
    }
    return { id: item.id, at: item.updated_at, repository, title: item.subject.title,
      url: item.subject.url ?? "https://github.com/notifications", matches: true }
  })
  if (condition.kind === "github-security-alert") return body.map(value => {
    const item = rawAlert.parse(value)
    return { id: String(item.number), at: item.created_at, repository: condition.repository,
      title: item.security_advisory?.summary ?? item.dependency.package.name,
      url: ownedUrl(item.html_url, condition.repository, `security/dependabot/${item.number}`), matches: true }
  })
  return body.map(value => {
    const item = rawIssue.parse(value), pull = !!item.pull_request, author = item.user?.login
    return { id: String(item.number), at: item.created_at, repository: condition.repository, title: item.title,
      url: ownedUrl(item.html_url, condition.repository, `${pull ? "pull" : "issues"}/${item.number}`),
      ...(author ? { author } : {}), matches: pull === (condition.kind === "github-pull-request")
        && (!condition.author || author?.toLowerCase() === condition.author) }
  })
}

/** Read-only native event observation. Authentication stays in the existing gh
 * login; no token, notification-read mutation or persistent backend is involved. */
export async function readMissionGithubSource(input: MissionGithubCondition, root: string,
  previous?: MissionSourceCheckpoint, signal?: AbortSignal, transport: ForgeTransport = includedCliTransport("gh", "github.com")) {
  const condition = missionGithubConditionSchema.parse(input), key = missionSourceKey(condition)
  const expires = performance.now() + DEADLINE_MS
  const live = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(DEADLINE_MS)])
  let valid = true
  const check = (): true => { live.throwIfAborted(); if (!valid || performance.now() >= expires) return unavailable(); return true }
  const request = async (path: string) => {
    live.throwIfAborted()
    if (performance.now() >= expires) return unavailable()
    const response = await transport.request(path, live)
    live.throwIfAborted()
    if (performance.now() >= expires || response.status !== 200) return unavailable()
    return response
  }
  try {
    const viewer = z.object({ id: z.number().int().positive().safe() }).parse(JSON.parse((await request("user")).body))
    const placementDigest = stableToken(canonicalAuthority(["github.com", root, viewer.id]), 64)
    if (previous && (previous.key !== key || previous.kind !== condition.kind || previous.placementDigest !== placementDigest)) return unavailable()
    const old = previous ? cursor.parse(previous.value) : undefined
    let baseline: string | undefined
    const snapshot = async () => {
      const found = new Map<string, Row>()
      let preceding: string | undefined
      let after: string | undefined
      for (let page = 1; page <= MAX_PAGES; page++) {
        const query = new URLSearchParams({ per_page: String(PAGE_SIZE) })
        if (condition.kind === "github-security-alert") { if (after) query.set("after", after) }
        else query.set("page", String(page))
        const reference = old?.at ?? baseline
        let endpoint: string
        if (condition.kind === "github-notification") {
          endpoint = condition.repository ? `repos/${condition.repository}/notifications` : "notifications"
          query.set("all", "true")
        } else if (condition.kind === "github-security-alert") {
          endpoint = `repos/${condition.repository}/dependabot/alerts`
          query.set("sort", "created"); query.set("direction", "desc")
        } else {
          endpoint = `repos/${condition.repository}/issues`
          query.set("state", "all"); query.set("sort", "created"); query.set("direction", "desc")
          if (condition.author) query.set("creator", condition.author)
        }
        if (reference && condition.kind !== "github-security-alert")
          query.set("since", new Date(Math.max(0, Date.parse(reference) - 1000)).toISOString())
        const response = await request(`${endpoint}?${query}`)
        if (!old && !baseline) {
          const date = response.headers.get("date")
          if (!date || !Number.isFinite(Date.parse(date))) return unavailable()
          baseline = new Date(date).toISOString()
        }
        const cutoff = old?.at ?? baseline!, values = rows(JSON.parse(response.body), condition)
        for (const value of values) {
          if (preceding && value.at > preceding || found.has(value.id)) return unavailable()
          preceding = value.at
          found.set(value.id, value)
        }
        const link = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")
        if (condition.kind === "github-security-alert" && link) {
          const next = new URL(link[1]), token = next.searchParams.get("after")
          if (next.origin !== "https://api.github.com" || next.username || next.password || !token || token.length > 512
            || /[\x00-\x20\x7f]/.test(token) || token === after) return unavailable()
          // Keep only the opaque cursor, never the returned URL or its filters.
          after = token
        }
        const more = !!link || condition.kind !== "github-security-alert" && values.length === PAGE_SIZE
        if (!more || !values.length || values.at(-1)!.at < cutoff) break
        // ponytail: four bounded REST pages; a webhook/cursor adapter is needed
        // for repositories whose unconsumed window exceeds this observation budget.
        if (page === MAX_PAGES) return unavailable()
      }
      const all = [...found.values()].filter(value => value.matches)
      const fresh = old ? all.filter(value => value.at > old.at || value.at === old.at && !old.ids.includes(value.id)) : []
      const at = fresh.length ? fresh.reduce((latest, value) => value.at > latest ? value.at : latest, old!.at) : old?.at ?? baseline!
      const ids = [...new Set([...(old?.at === at ? old.ids : []), ...all.filter(value => value.at >= at).map(value => value.id)])].sort()
      return cursor.parse({ at, ids, events: fresh.map(({ matches: _matches, ...value }) => value)
        .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)) })
    }
    const value = await snapshot()
    canonicalAuthority(value, 32 * 1024)
    const revalidate = async () => {
      check(); valid = false
      const account = z.object({ id: z.number().int().positive().safe() }).parse(JSON.parse((await request("user")).body))
      // Events already observed are historical input, not a live state grant.
      // Recheck the account without polling the notification collection twice.
      if (account.id !== viewer.id) return unavailable()
      valid = true; check()
    }
    await revalidate()
    return { checkpoint: { key, kind: condition.kind, placementDigest, value: JSON.parse(canonicalAuthority(value, 32 * 1024)) } as MissionSourceCheckpoint,
      changed: !!previous && value.events.length > 0, current: check, revalidate }
  } catch { live.throwIfAborted(); return unavailable() }
}
