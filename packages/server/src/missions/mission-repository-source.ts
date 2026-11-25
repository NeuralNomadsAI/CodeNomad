import { z } from "zod"
import { forgeWorkItems, type ForgeWorkItems } from "../forge/work-items"
import { forgeActivityPage, forgeActivityPath } from "../forge/activity"
import { canonicalAuthority } from "./authority-protocol"
import { missionSourceKey, type MissionSourceCheckpoint } from "./mission-document"
import { missionRepositoryConditionSchema, missionRepositoryCheckpointSchema as cursor, missionRemoteBranchConditionSchema, missionRemoteBranchCheckpointSchema as tip,
  type MissionRepositoryCondition, type MissionRepositoryIdentity, type MissionRemoteBranchCondition } from "./mission-repository-condition"
import { stableToken } from "./receipt-identity"

const DEADLINE_MS = 15_000, MAX_PAGES = 4
const unavailable = (): never => { throw new Error("Repository activity unavailable, changed or over capacity") }

async function openSource(condition: MissionRepositoryIdentity, root: string, signal: AbortSignal | undefined,
  forge: Pick<ForgeWorkItems, "openRepository">, deferAccount = false) {
  const live = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(DEADLINE_MS)])
  const expires = performance.now() + DEADLINE_MS
  let valid = true
  const current = (): true => { live.throwIfAborted(); if (!valid || performance.now() >= expires) return unavailable(); return true }
  const open = async () => {
    current()
    const connection = await forge.openRepository(root, true, live)
    current()
    if (connection.status !== "ok" || connection.repository.provider !== condition.provider || connection.repository.host !== condition.host
      || connection.repository.path !== condition.repository) return unavailable()
    return connection
  }
  const connection = await open()
  const account = async (source: typeof connection) => {
    const response = await source.transport.request("user", live); current()
    if (source.transport.access === "anonymous" && response.status === 401) return "anonymous"
    if (response.status !== 200) return unavailable()
    return z.object({ id: z.number().int().positive().safe() }).parse(JSON.parse(response.body)).id
  }
  const digest = (viewer: number | "anonymous") =>
    stableToken(canonicalAuthority([root, condition.provider, condition.host, condition.repository, viewer]), 64)
  if (deferAccount) return { connection, open, account, digest, current, live, invalidate: () => { valid = false } }
  const viewer = await account(connection)
  const placementDigest = digest(viewer)
  const reopen = async () => {
    try { const next = await open(); if (await account(next) !== viewer) return unavailable(); current(); return next }
    catch (error) { valid = false; throw error }
  }
  return { connection, open, account, digest, placementDigest, current, live, reopen, invalidate: () => { valid = false } }
}

/** Complete bounded activity windows; checkpoints advance only through ordinary successful-passage consumption. */
export async function readMissionRepositorySource(input: MissionRepositoryCondition, root: string, previous?: MissionSourceCheckpoint,
  signal?: AbortSignal, forge: Pick<ForgeWorkItems, "openRepository"> = forgeWorkItems) {
  const condition = missionRepositoryConditionSchema.parse(input), key = missionSourceKey(condition)
  const { connection, placementDigest, current, live, reopen } = await openSource(condition, root, signal, forge)
  if (previous && (previous.key !== key || previous.kind !== condition.kind || previous.placementDigest !== placementDigest)) return unavailable()
  const old = previous ? cursor.parse(previous.value) : undefined
  let baseline: string | undefined, preceding: string | undefined
  const found = new Map<string, ReturnType<typeof forgeActivityPage>["rows"][number]>()
  for (let page = 1; page <= MAX_PAGES; page++) {
    const since = old ? new Date(Math.max(0, Date.parse(old.at) - 1000)).toISOString() : undefined
    const response = await connection.transport.request(forgeActivityPath(condition, page, since), live); current()
    if (response.status !== 200) return unavailable()
    if (!baseline) {
      const date = response.headers.get("date")
      if (!date || !Number.isFinite(Date.parse(date))) return unavailable()
      baseline = new Date(date).toISOString()
      if (old && baseline < old.at) return unavailable()
    }
    const { rows, more, ordered } = forgeActivityPage(response, condition, found.size)
    for (const row of rows) {
      if (found.has(row.id) || ordered && preceding && row.orderAt > preceding) return unavailable()
      preceding = row.orderAt; found.set(row.id, row)
    }
    if (more && !rows.length) return unavailable()
    if (!more || ordered && rows.at(-1)!.orderAt < (old?.at ?? baseline)) break
    // ponytail: four REST pages; a cursor/webhook reader is needed above 200 unconsumed updates.
    if (page === MAX_PAGES) return unavailable()
  }
  const all = [...found.values()].filter(row => row.matches && row.at <= baseline!)
  const events = old ? all.filter(row => row.at > old.at || row.at === old.at && !old.ids.includes(row.id)) : []
  const value = cursor.parse({ at: baseline, ids: [...new Set([...(old && old.at === baseline ? old.ids : []), ...all.filter(row => row.at === baseline).map(row => row.id)])].sort(),
    events: events.map(({ orderAt: _order, matches: _matches, ...row }) => row).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)) })
  const revalidate = async () => { await reopen!() }
  return { checkpoint: { key, kind: condition.kind, placementDigest: placementDigest!, value: JSON.parse(canonicalAuthority(value, 32 * 1024)) } as MissionSourceCheckpoint,
    changed: !!previous && events.length > 0, current, revalidate }
}

export async function readMissionRemoteBranch(input: MissionRemoteBranchCondition, root: string, previous?: MissionSourceCheckpoint,
  signal?: AbortSignal, forge: Pick<ForgeWorkItems, "openRepository"> = forgeWorkItems) {
  const condition = missionRemoteBranchConditionSchema.parse(input), key = missionSourceKey(condition)
  const { connection, open, account, digest, current, live, invalidate } = await openSource(condition, root, signal, forge, true)
  const branch = condition.ref.slice("refs/heads/".length), encoded = encodeURIComponent(branch)
  const endpoint = condition.provider === "gitlab"
    ? `projects/${encodeURIComponent(condition.repository)}/repository/branches/${encoded}`
    : `repos/${condition.repository}/branches/${encoded}`
  const read = async (source: typeof connection) => {
    const response = await source.transport.request(endpoint, live); current()
    if (response.status !== 200) return unavailable()
    const data = z.object({ name: z.literal(branch), commit: z.object({ sha: z.string().optional(), id: z.string().optional() }) }).parse(JSON.parse(response.body))
    return tip.parse({ oid: condition.provider === "github" ? data.commit.sha : data.commit.id })
  }
  const [viewer, value] = await Promise.all([account(connection), read(connection)])
  const placementDigest = digest(viewer)
  if (previous && (previous.key !== key || previous.kind !== condition.kind || previous.placementDigest !== placementDigest)) return unavailable()
  const prior = previous && tip.parse(previous.value)
  const revalidate = async () => {
    try {
      const next = await open()
      const [nextViewer, nextValue] = await Promise.all([account(next), read(next)])
      if (nextViewer !== viewer || nextValue.oid !== value.oid) unavailable()
      current()
    } catch (error) { invalidate(); throw error }
  }
  return { checkpoint: { key, kind: condition.kind, placementDigest, value } satisfies MissionSourceCheckpoint,
    changed: !!prior && prior.oid !== value.oid, current, revalidate }
}
