import type { SessionMessageInfo } from "@opencode/client"

/** A session's live rows, serialized when a read starts. */
export type OpenCodeRowSnapshot = Map<string, string>

/** SDK step boundaries stamp the root `time.completed` onto adjacent rows
 * without changing their content: such a row still takes the fetched
 * (terminal) version. */
function serializeRowForDiff(row: SessionMessageInfo): string {
  const record = row as unknown as { time?: { completed?: unknown } }
  return JSON.stringify({ ...(row as object), time: record.time === undefined ? undefined : { ...record.time, completed: undefined } })
}

export function snapshotRows(live: readonly SessionMessageInfo[]): OpenCodeRowSnapshot {
  const snapshot: OpenCodeRowSnapshot = new Map()
  for (const message of live) snapshot.set(message.id, serializeRowForDiff(message))
  return snapshot
}

type ContentRow = { content?: unknown }
type Fragment = { type?: unknown; text?: unknown; native?: unknown; state?: unknown; time?: { completed?: unknown } }
export type FragmentKind = "text" | "reasoning"

const partId = (part: unknown): string | undefined => {
  const id = (part as { id?: unknown } | null)?.id
  return typeof id === "string" ? id : undefined
}

const fragmentKindOf = (part: unknown): FragmentKind | undefined => {
  const type = (part as { type?: unknown } | null)?.type
  return type === "text" || type === "reasoning" ? type : undefined
}

export const fragmentKey = (messageId: string, kind: FragmentKind, ordinal: number) => `${messageId}\0${kind}\0${ordinal}`

/** Positive closure evidence only: the message completed, or the fragment's
 * own ending. The native writes a text part's provider state (`native`) only
 * when its ending commits, and stamps a reasoning part's `time.completed` then
 * (reasoning carries its provider state from its start, so that proves
 * nothing). Text stays open while reasoning or tool parts follow it, so a
 * later part proves nothing either. */
export function isCommittedFragment(row: SessionMessageInfo, kind: FragmentKind, part: Fragment): boolean {
  if ((row as unknown as { time?: { completed?: unknown } }).time?.completed !== undefined) return true
  return kind === "text" ? part.native != null || part.state != null : part.time?.completed !== undefined
}

/** A content key per part: its ID, else its kind and ordinal among parts of that kind. */
function partKeys(content: readonly unknown[]): string[] {
  const ordinals = new Map<string, number>()
  return content.map((part) => {
    const id = partId(part)
    if (id !== undefined) return `id:${id}`
    const type = String((part as { type?: unknown } | null)?.type)
    const ordinal = ordinals.get(type) ?? 0
    ordinals.set(type, ordinal + 1)
    return `${type}:${ordinal}`
  })
}

/** Inserts the `source` parts `accept` admits whose key `parts` lacks, beside
 * their `source` neighbours: after the nearest preceding one `parts` holds,
 * else before the nearest following one, else at the end. Anonymous fragments
 * pair by kind and ordinal, so an inserted part keeps its side of them. */
function insertMissingParts(parts: unknown[], source: readonly unknown[], accept: (part: unknown) => boolean): boolean {
  const sourceKeys = partKeys(source)
  const keys = partKeys(parts)
  const held = new Set(keys)
  let inserted = false
  source.forEach((part, index) => {
    if (held.has(sourceKeys[index]) || !accept(part)) return
    const anchorAfter = sourceKeys.slice(0, index).reverse().find((key) => held.has(key))
    const anchorBefore = sourceKeys.slice(index + 1).find((key) => held.has(key))
    const position = anchorAfter !== undefined ? keys.indexOf(anchorAfter) + 1
      : anchorBefore !== undefined ? keys.indexOf(anchorBefore) : parts.length
    parts.splice(position, 0, part)
    keys.splice(position, 0, sourceKeys[index])
    held.add(sourceKeys[index])
    inserted = true
  })
  return inserted
}

/** The one rule for every text and reasoning fragment, paired by kind and
 * ordinal between the live row and the page. In a row the stream changed
 * during the fetch the live fragment is newer and stays, unless it is owed
 * (its text is unproven) and the page holds it committed. Otherwise a
 * fragment the page holds committed (`isCommittedFragment`) takes the page; a
 * live fragment whose text the page's only prefixes (a stream only appends;
 * an open fragment's page text is persisted late, often empty, even when
 * other kinds follow it) keeps its live text; otherwise the page decides. A
 * fragment one side alone holds keeps that side. */
function chooseFragment(
  live: Fragment | undefined,
  page: Fragment | undefined,
  pageRow: SessionMessageInfo,
  kind: FragmentKind,
  { changed, owed }: { changed: boolean; owed: boolean },
): Fragment | undefined {
  const committed = page !== undefined && isCommittedFragment(pageRow, kind, page)
  if (changed) return owed && committed ? page : live ?? page
  if (committed) return page
  if (live && page) {
    return typeof live.text === "string" && typeof page.text === "string" && live.text.startsWith(page.text) ? live : page
  }
  return live ?? page
}

/** Applies `chooseFragment` to each fragment of `base`, a row whose structure
 * the merge already decided. */
function mergeFragments(
  base: SessionMessageInfo,
  liveRow: SessionMessageInfo,
  pageRow: SessionMessageInfo,
  changed: boolean,
  owed: ReadonlySet<string>,
): SessionMessageInfo {
  const content = (base as ContentRow).content
  if (!Array.isArray(content)) return base
  const fragmentsOf = (row: SessionMessageInfo, kind: FragmentKind) => {
    const parts = (row as ContentRow).content
    return Array.isArray(parts) ? parts.filter((part) => fragmentKindOf(part) === kind) as Fragment[] : []
  }
  const ordinals = new Map<FragmentKind, number>()
  let replaced = false
  const merged = content.map((part) => {
    const kind = fragmentKindOf(part)
    if (!kind) return part
    const ordinal = ordinals.get(kind) ?? 0
    ordinals.set(kind, ordinal + 1)
    const chosen = chooseFragment(fragmentsOf(liveRow, kind)[ordinal], fragmentsOf(pageRow, kind)[ordinal], pageRow, kind,
      { changed, owed: owed.has(fragmentKey(pageRow.id, kind, ordinal)) }) ?? part
    if (chosen !== part) replaced = true
    return chosen
  })
  return replaced ? { ...(base as object), content: merged } as SessionMessageInfo : base
}

/** A live row changed since its snapshot keeps its live version, except that
 * each identified content part (a tool call, for example) left unchanged since
 * the snapshot takes the page's version, and a part only the page holds (by ID,
 * or a fragment unless the stream created the row during the fetch) joins the
 * row: progress on one part never shadows authority for a sibling part, nor
 * hides one the live row missed. Live fragments stay aligned to native
 * ordinals because misaligned fragment events never reduce. */
function mergeChangedRow(row: SessionMessageInfo, fetched: SessionMessageInfo, snapshot: string | undefined): SessionMessageInfo {
  const content = (row as ContentRow).content
  const fetchedContent = (fetched as ContentRow).content
  const before = snapshot === undefined ? undefined : (JSON.parse(snapshot) as ContentRow).content
  if (!Array.isArray(content) || !Array.isArray(fetchedContent)) return row
  const beforeById = new Map((Array.isArray(before) ? before : []).flatMap((part) => partId(part) === undefined ? [] : [[partId(part)!, JSON.stringify(part)]]))
  const fetchedById = new Map(fetchedContent.flatMap((part) => partId(part) === undefined ? [] : [[partId(part)!, part]]))
  let replaced = false
  const parts = content.map((part) => {
    const id = partId(part)
    if (id === undefined || !fetchedById.has(id) || beforeById.get(id) !== JSON.stringify(part)) return part
    replaced = true
    return fetchedById.get(id)
  })
  // A row the stream created during the fetch keeps its live fragments.
  if (insertMissingParts(parts, fetchedContent, (part) => partId(part) !== undefined || Array.isArray(before))) replaced = true
  return replaced ? { ...(row as object), content: parts } as SessionMessageInfo : row
}

/** A live row unchanged since the read began takes the page's version; an
 * open page row also keeps the live fragments it does not hold yet. */
function mergeUnchangedRow(row: SessionMessageInfo, fetched: SessionMessageInfo): SessionMessageInfo {
  const content = (row as ContentRow).content
  const fetchedContent = (fetched as ContentRow).content
  if (!Array.isArray(content) || !Array.isArray(fetchedContent)) return fetched
  if ((fetched as unknown as { time?: { completed?: unknown } }).time?.completed !== undefined) return fetched
  const parts = [...fetchedContent]
  return insertMissingParts(parts, content, (part) => fragmentKindOf(part) !== undefined)
    ? { ...(fetched as object), content: parts } as SessionMessageInfo
    : fetched
}

/** Merges a fetched page (newest first) with the live rows: the page is the
 * base; a live row changed since `since` keeps its live structure (with
 * unchanged identified parts and parts only the page holds from the page), an
 * unchanged one takes the page's; every text and reasoning fragment of a row
 * both hold then follows `chooseFragment` (`owed`: fragment keys whose live
 * text is unproven); live rows created during the fetch and absent from the
 * page ride along newest-first. */
export function mergePageWithSnapshot(
  live: readonly SessionMessageInfo[],
  page: readonly SessionMessageInfo[],
  since: OpenCodeRowSnapshot,
  owed: ReadonlySet<string> = new Set(),
): SessionMessageInfo[] {
  const liveById = new Map(live.map((message) => [message.id, message]))
  const pageIds = new Set(page.map((message) => message.id))
  const merged = page.map((message) => {
    const row = liveById.get(message.id)
    if (row === undefined) return message
    const snapshot = since.get(row.id)
    const changed = snapshot !== serializeRowForDiff(row)
    const base = changed ? mergeChangedRow(row, message, snapshot) : mergeUnchangedRow(row, message)
    return mergeFragments(base, row, message, changed, owed)
  })
  const created = live.filter((message) => !pageIds.has(message.id) && !since.has(message.id)).reverse()
  return [...created, ...merged]
}
