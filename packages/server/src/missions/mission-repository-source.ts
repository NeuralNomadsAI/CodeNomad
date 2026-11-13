import { z } from "zod"
import { forgeWorkItems, type ForgeWorkItems } from "../forge/work-items"
import { forgeActivityPage, forgeActivityPath } from "../forge/activity"
import { canonicalAuthority } from "./authority-protocol"
import { missionSourceKey, type MissionSourceCheckpoint } from "./mission-document"
import { missionRepositoryConditionSchema, missionRepositoryCheckpointSchema as cursor, type MissionRepositoryCondition } from "./mission-repository-condition"
import { stableToken } from "./receipt-identity"

const DEADLINE_MS = 10_000, MAX_PAGES = 4
const unavailable = (): never => { throw new Error("Repository activity unavailable, changed or over capacity") }

/** Complete bounded activity windows; checkpoints advance only through ordinary successful-passage consumption. */
export async function readMissionRepositorySource(input: MissionRepositoryCondition, root: string, previous?: MissionSourceCheckpoint,
  signal?: AbortSignal, forge: Pick<ForgeWorkItems, "openRepository"> = forgeWorkItems) {
  const condition = missionRepositoryConditionSchema.parse(input), key = missionSourceKey(condition)
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
  const viewer = await account(connection)
  const placementDigest = stableToken(canonicalAuthority([root, condition.provider, condition.host, condition.repository, viewer]), 64)
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
  const revalidate = async () => {
    try { const next = await open(); if (await account(next) !== viewer) return unavailable(); current() }
    catch (error) { valid = false; throw error }
  }
  await revalidate()
  return { checkpoint: { key, kind: condition.kind, placementDigest, value: JSON.parse(canonicalAuthority(value, 32 * 1024)) } as MissionSourceCheckpoint,
    changed: !!previous && events.length > 0, current, revalidate }
}
