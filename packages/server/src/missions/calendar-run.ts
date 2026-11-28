import { z } from "zod"
import type { MissionControl } from "./control"
import type { MissionCreateInput } from "./control-types"
import { runMissionExclusive } from "./exclusive"
import { missionConditionSchema, type MissionCondition } from "./launch-policy"
import { missionCheckpointsSchema, missionSourceKey, type MissionSourceCheckpoint } from "./mission-document"
import { isMissionGithubCondition } from "./mission-github-condition"
import { readMissionGithubSource } from "./mission-github-source"
import { readMissionLocalSource } from "./mission-local-sources"
import { readMissionRemoteBranch, readMissionRepositorySource } from "./mission-repository-source"
import type { MissionJsonValue, MissionMap } from "./model"
import type { MissionPanelMap } from "./mission-panel-map"

/** A Mission calendar is an OpenCode Automation whose program is this one call: its
 * `args` are the Mission to launch, and the tool does everything else. */
export const MISSION_CALENDAR_TOOL = Object.freeze({ namespace: "codenomad", name: "mission_calendar_run", permission: "codenomad_mission_calendar_run" })
// The run's answer becomes the Automation's state, where any client reads what the calendar last did.
export const MISSION_CALENDAR_CODE = `return { state: { last: await tools.${MISSION_CALENDAR_TOOL.namespace}.${MISSION_CALENDAR_TOOL.name}(args) } }`
/** Rules of the conversation that carries calendars, so OpenCode runs the program unattended. */
export const MISSION_CALENDAR_PERMISSIONS = Object.freeze([
  Object.freeze({ action: "execute", resource: "*", effect: "allow" as const }),
  Object.freeze({ action: MISSION_CALENDAR_TOOL.permission, resource: "*", effect: "allow" as const }),
])
/** Metadata key of a conversation allowed to carry calendars. */
export const MISSION_CALENDAR_CARRIER = "codenomad.mission-calendar"

/** Past launches a programmed Mission remembers: when, and how each ended. */
export const MISSION_CALENDAR_HISTORY = 20
const launchSchema = z.object({ at: z.number().int().nonnegative(), outcome: z.string().min(1).max(40) }).strict()
const slotSchema = z.object({ version: z.literal(1),
  // `outcome`: seen no longer active, so later runs need not ask Missions again.
  launched: z.object({ automationID: z.string().min(1).max(100), run: z.number().int().positive(), missionID: z.string().min(1).max(100),
    at: z.number().int().nonnegative(), outcome: z.string().min(1).max(40).optional(),
    // The prepared Mission that stands for the programmed one until its first launch starts it.
    placeholder: z.literal(true).optional() }).strict().optional(),
  /** The conversation every launch coordinates in, once the first launch created it. */
  coordinatorSessionID: z.string().min(1).max(240).optional(),
  history: z.array(launchSchema).max(MISSION_CALENDAR_HISTORY).optional(),
  /** Launches so far, the remembered ones and the older. */
  launches: z.number().int().nonnegative().optional(),
  /** Replaced Missions whose removal did not finish. */
  retiring: z.array(z.string().min(1).max(100)).max(8).optional(),
  checkpoints: missionCheckpointsSchema.optional() }).strict()/** A calendar with several date rules is several Automations naming the same calendar: they share its slot. */
export const missionCalendarIDSchema = z.string().regex(/^[A-Za-z0-9_-]{3,100}$/)
/** The calendar's latest Mission and event checkpoints, per project and calendar (its only Automation's ID when it names none). */
export const missionCalendarKey = (projectToken: string, calendar: string) => `codenomad-missions/calendar-v1/${projectToken}/${calendar}`

/** OpenCode names an Automation run's message `msg_<automationID>_<run>`; nothing else is a calendar run. */
export function missionCalendarOccurrence(messageID: string): { automationID: string; run: number } | undefined {
  const match = /^msg_(aut_[A-Za-z0-9]+)_([1-9]\d{0,14})$/.exec(messageID)
  return match ? { automationID: match[1]!, run: Number(match[2]) } : undefined
}

type MissionCalendarEvent = Exclude<MissionCondition, { kind: "schedule-success" | "mission-completed" | "conversation-message" }>
/** Events a calendar can wait for: those read from Git and the forges with this machine's own access. */
export const missionCalendarEventsSchema = z.array(missionConditionSchema).max(8).refine((events): events is MissionCalendarEvent[] =>
  events.every(event => !["schedule-success", "mission-completed", "conversation-message"].includes(event.kind)))
export type MissionCalendarNews = (previous: readonly MissionSourceCheckpoint[]) => Promise<{ checkpoints: MissionSourceCheckpoint[]; changed: boolean }>

/** Reads every event against its checkpoint: any one changed is news. The first read of an event only records where it stands. */
export const missionCalendarNews = (events: readonly MissionCalendarEvent[], root: string, signal: AbortSignal): MissionCalendarNews => async previous => {
  const reads = await Promise.all(events.map(event => {
    const old = previous.find(item => item.key === missionSourceKey(event))
    if (event.kind === "repository-activity") return readMissionRepositorySource(event, root, old, signal)
    if (event.kind === "remote-branch-commits") return readMissionRemoteBranch(event, root, old, signal)
    if (isMissionGithubCondition(event)) return readMissionGithubSource(event, root, old, signal)
    return readMissionLocalSource(event, event.kind === "branch-commits" ? event.directory : root, old, signal)
  }))
  for (const read of reads) read.current()
  return { checkpoints: reads.map(read => read.checkpoint), changed: reads.some(read => read.changed) }
}

/** What a run did; `unread` when its events could not be read. `missionID` is the programmed Mission's current launch, whatever the run did. */
export type MissionCalendarResult = { outcome: "launched" | "waiting" | "idle" | "unread"; missionID?: string; status?: string
  coordinatorSessionID?: string; history: Array<z.infer<typeof launchSchema>>; launches: number }
/** What a run needs of Missions: `MissionControl` itself, or its registered RPC. */
export type MissionCalendarControl = Pick<MissionControl, "create" | "lifecycle" | "mission" | "delete">
type Storage = { get(key: string): Promise<MissionJsonValue | undefined>; set(key: string, value: MissionJsonValue): Promise<void> }
type Occurrence = { automationID: string; run: number }
type Launch = Omit<MissionCreateInput, "requestID" | "prepared">

/** One occurrence of a programmed Mission. To its user it is one Mission launched again:
 * each launch is a new one-time Mission that replaces the previous one, in the same
 * coordinator conversation: the one the programming names, else the one its launches use,
 * else a new one, whichever first can coordinate. The previous Mission goes only once the
 * new one exists. Nothing launches while the previous launch is still active,
 * or when the events (`news`) brought nothing new since the last launch; an active
 * launch leaves the events unread, so their news waits for it. Events that cannot be read
 * now change nothing and are read by the next run. Repeating a run changes
 * nothing, and the runs of one programmed Mission follow one another. `prepared` names
 * the Mission created with the programming: the first launch starts it instead of creating one. */
export function runMissionCalendar(control: MissionCalendarControl, storage: Storage, key: string, occurrence: Occurrence,
  mission: Launch, options: { news?: MissionCalendarNews; prepared?: string; now?: () => number } = {}): Promise<MissionCalendarResult> {
  return runMissionExclusive(`calendar:${key}`, () => runOccurrence(control, storage, key, occurrence, mission, options.news, options.prepared, options.now ?? Date.now))
}

async function runOccurrence(control: MissionCalendarControl, storage: Storage, key: string, occurrence: Occurrence,
  mission: Launch, news: MissionCalendarNews | undefined, prepared: string | undefined, now: () => number): Promise<MissionCalendarResult> {
  // A Mission created by a run that never started it is started by whichever run finds it.
  const start = async (map: MissionPanelMap | MissionMap) => {
    const pending = map.control?.pending.length ? map.control : undefined
    if (map.runState !== "prepared" && pending?.action !== "start") return map
    return (await control.lifecycle({ missionID: map.id, action: "start", requestID: pending?.requestID ?? "calendar-start",
      expectedRevision: pending?.expectedRevision ?? map.revision })).mission
  }
  const slot = slotSchema.safeParse(await storage.get(key)).data
  let launched = slot?.launched, checkpoints = slot?.checkpoints, history = slot?.history ?? [], retiring = slot?.retiring ?? []
  let launches = slot?.launches ?? history.length + (launched && !launched.placeholder ? 1 : 0)
  // An edit of the programming before its first launch prepares another Mission.
  if (prepared && (!launched || launched.placeholder && launched.missionID !== prepared))
    launched = { automationID: occurrence.automationID, run: occurrence.run, missionID: prepared, at: now(), placeholder: true }
  const repeated = !!launched && !launched.placeholder && launched.automationID === occurrence.automationID && launched.run === occurrence.run
  let coordinatorSessionID = slot?.coordinatorSessionID
  const save = () => storage.set(key, JSON.parse(JSON.stringify({ version: 1, launched, coordinatorSessionID, checkpoints,
    ...(history.length ? { history } : {}), ...(launches ? { launches } : {}), ...(retiring.length ? { retiring } : {}) })) as MissionJsonValue)
  const answer = (outcome: MissionCalendarResult["outcome"], status = launched?.outcome): MissionCalendarResult => ({ outcome,
    ...(launched ? { missionID: launched.missionID } : {}), ...(status ? { status } : {}), ...(coordinatorSessionID ? { coordinatorSessionID } : {}), history, launches })
  if (repeated) {
    // The run already launched: only its start may be left to finish.
    const current = (await control.mission(launched!.missionID)).mission
    if (current) return answer("launched", (await start(current)).status)
    launched = undefined
  }
  if (launched && !launched.placeholder && !launched.outcome) {
    const previous = (await control.mission(launched.missionID)).mission
    if (previous?.status === "active") return answer("waiting", (await start(previous)).status)
    launched = { ...launched, outcome: previous?.status ?? "removed" }
  }
  if (news) {
    // A network or forge that does not answer is no failed run: OpenCode pauses an Automation after three.
    const read = await news(checkpoints ?? []).catch(() => undefined)
    if (!read) return answer("unread")
    checkpoints = read.checkpoints
    if (!read.changed) { await save(); return answer("idle") }
  }
  if (launched?.placeholder) {
    const waiting = (await control.mission(launched.missionID)).mission
    if (waiting?.status === "active" && waiting.runState === "prepared") {
      coordinatorSessionID = waiting.coordinatorSessionId
      launched = { ...occurrence, missionID: waiting.id, at: now() }
      launches++
      await save()
      return answer("launched", (await start(waiting)).status)
    }
    // A person started, ended or removed it: an ordinary previous launch from here, counted when it ran.
    const { placeholder: _placeholder, ...ordinary } = launched
    launched = waiting ? ordinary : undefined
    if (waiting) launches++
  }
  if (launched) {
    // Asked again at the moment of replacing: a person may have resumed a launch seen ended.
    const previous = (await control.mission(launched.missionID)).mission
    if (previous?.status === "active") {
      const { outcome: _outcome, ...current } = launched
      launched = current
      await save()
      return answer("waiting", (await start(previous)).status)
    }
    launched = { ...launched, outcome: previous?.status ?? launched.outcome ?? "removed" }
  }
  const requestID = `calendar_${occurrence.automationID}_${occurrence.run}`
  const { coordinatorSessionID: named, ...launch } = mission
  let created: MissionPanelMap | MissionMap | undefined
  for (const session of [...new Set([named, coordinatorSessionID].filter(Boolean)), undefined]) {
    try { created = (await control.create({ ...launch, ...(session ? { coordinatorSessionID: session } : {}), prepared: true, requestID })).mission; break }
    // A conversation that cannot coordinate leaves the launch to the next one; a launch nothing can create leaves the programmed Mission as it was.
    catch (error) { if (!session) throw error }
  }
  // The new launch replaces the previous one: its date and outcome stay, its Mission goes.
  if (launched) {
    history = [...history, { at: launched.at, outcome: launched.outcome ?? "removed" }].slice(-MISSION_CALENDAR_HISTORY)
    retiring = [...retiring, launched.missionID].slice(-8)
  }
  coordinatorSessionID = created!.coordinatorSessionId
  launched = { ...occurrence, missionID: created!.id, at: now() }
  launches++
  await save()
  for (const missionID of retiring.filter(id => id !== created!.id)) {
    const retired = (await control.mission(missionID)).mission
    // A removal that fails is tried again by the next launch; it never holds this one.
    if (retired?.status === "active") continue
    if (retired) await control.delete({ missionID, expectedRevision: retired.revision, requestID: `calendar_replace_${occurrence.automationID}_${occurrence.run}`,
      deleteManagedSessions: false }).then(() => { retiring = retiring.filter(id => id !== missionID) }, () => undefined)
    else retiring = retiring.filter(id => id !== missionID)
  }
  await save()
  return answer("launched", (await start(created!)).status)
}