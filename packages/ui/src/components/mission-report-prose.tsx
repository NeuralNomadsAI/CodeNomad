import { Show } from "solid-js"
import type { MissionPanelMap, MissionPanelReport, MissionReport } from "../../../server/src/api-types"
import { isFullMissionReport } from "../../../server/src/missions/mission-panel-map"
import { missionBodyPresent, missionOwnBody } from "../lib/mission-bodies"
import { MissionComparisonReport } from "./mission-comparison-report"
import { MissionDecisionReport } from "./mission-decision-report"
import type { MissionPassageSection } from "./mission-passage-section"
import { MissionReaderSection } from "./mission-reader"
import { missionReaderBody, useReaderValue, type MissionBodyRead, type MissionReaderBody } from "./mission-reader-body"

/** Whether `report` records its `field` with content: a passage's full report from its own
 * value, a compact row from its descriptor in the map's reports (`missionBodyPresent`). */
export function missionReportHas(mission: MissionPanelMap | undefined, report: MissionPanelReport | undefined, field: "summary" | "next" | "evidence" | "artifact") {
  if (!report) return false
  const shape = field === "summary" ? "text" : field === "artifact" ? "value" : "list"
  if (isFullMissionReport(report)) {
    const value: unknown = report[field]
    return shape === "text" ? Boolean(value) : shape === "list" ? Array.isArray(value) && value.length > 0 : value !== undefined
  }
  return missionBodyPresent(mission, { kind: "report", reportId: report.id, field }, shape)
}

interface ReportSource {
  instanceId: () => string
  mission: () => MissionPanelMap | undefined
  report: () => MissionPanelReport | undefined
  /** A one-time mission's bodies come from the content route; a passage's from its own map. */
  oneTime: () => boolean
  /** False while the report is hidden: nothing is read. */
  active?: () => boolean
}
type Whole<T> = { value: () => T | undefined; settled: () => boolean; read: () => MissionBodyRead }

/** A report's bodies as its readers show them, from the copy the map's readers prefer
 * (`missionReports`): a task's current result, read whole as that task's own `report`;
 * else a late return, from that task's `lateReports`, read whole; else the mission's
 * report, field by field, its summary paged. Readers of one report share its reads. */
export function useReportBodies(props: ReportSource) {
  const owned = () => {
    const report = props.report(), tasks = props.mission()?.tasks ?? []
    if (!report) return undefined
    const current = tasks.find(task => task.report?.id === report.id)
    if (current) return { task: current, field: "report" as const, pick: (value: unknown) => value as MissionReport | undefined }
    const late = tasks.find(task => task.lateReports?.some(item => item.id === report.id))
    return late && { task: late, field: "lateReports" as const, pick: (value: unknown) => (value as MissionReport[] | undefined)?.find(item => item.id === report.id) }
  }
  const reading = { instanceId: props.instanceId, mission: props.mission, oneTime: props.oneTime, active: props.active }
  const copy = useReaderValue<unknown>({ ...reading,
    selector: () => { const place = owned(); return place && { kind: "task", taskKey: place.task.key, field: place.field } } })
  const ownCopy = () => owned()?.pick(copy.value())
  const field = <K extends "next" | "evidence" | "artifact">(name: K): Whole<MissionReport[K]> => {
    const own = useReaderValue<MissionReport[K]>({ ...reading, selector: () => {
      const report = props.report()
      return report && !owned() && missionReportHas(props.mission(), report, name) ? { kind: "report", reportId: report.id, field: name } : undefined
    } })
    const read = () => owned() ? copy : own
    return { value: () => owned() ? ownCopy()?.[name] : own.value(), settled: () => read().settled(), read: () => read().read() }
  }
  return {
    /** The summary: a paged body (a passage's own text), or text from the task's copy once read. */
    summary: (): { text: string; body?: MissionReaderBody; read?: MissionBodyRead } => {
      const report = props.report(), mission = props.mission()
      if (!report) return { text: "" }
      const selector = { kind: "report" as const, reportId: report.id, field: "summary" }
      if (!owned()) return { text: missionOwnBody<string>(mission, selector) ?? "", body: missionReaderBody(props.instanceId(), mission, props.oneTime(), selector) }
      return { text: copy.settled() ? ownCopy()?.summary ?? "" : "", read: copy.read() }
    },
    next: field("next"), evidence: field("evidence"), artifact: field("artifact"),
  }
}

interface ReportProps {
  instanceId: string; mission: MissionPanelMap; report: MissionPanelReport; identity: string
  /** A one-time mission's bodies come from the content route; a passage's from its own map. */
  oneTime: boolean
}
const source = (props: ReportProps, active?: () => boolean): ReportSource => ({ instanceId: () => props.instanceId, mission: () => props.mission,
  report: () => props.report, oneTime: () => props.oneTime, active })

/** A report's prose (summary, next steps, evidence) and its Compare and decision readouts. */
export function MissionReportProse(props: ReportProps & { source: (label: string) => MissionPassageSection | undefined }) {
  const bodies = useReportBodies(source(props))
  const listSection = (label: string, field: "next" | "evidence") => <Show when={missionReportHas(props.mission, props.report, field)}>
    <MissionReaderSection label={label} text={bodies[field].settled() ? (bodies[field].value() ?? []).join("\n\n") : ""}
      read={bodies[field].read()} identity={props.identity} instanceId={props.instanceId} source={props.source(label)} />
  </Show>
  return <>
    <Show when={missionReportHas(props.mission, props.report, "summary")}><MissionReaderSection label="missions.control.summary" text={bodies.summary().text}
      body={bodies.summary().body} read={bodies.summary().read}
      identity={props.identity} instanceId={props.instanceId} source={props.source("missions.control.summary")} /></Show>
    {listSection("missions.control.report.next", "next")}
    {listSection("missions.control.report.evidence", "evidence")}
    <MissionComparisonReport artifact={bodies.artifact.value()} profiles={props.mission.profiles} identity={props.identity} instanceId={props.instanceId} />
    <MissionDecisionReport mission={props.mission} report={props.report} artifact={bodies.artifact.value()} identity={props.identity} instanceId={props.instanceId} />
  </>
}

/** A report's raw artifact, read only while `active` (its open disclosure). */
export function MissionReportArtifact(props: ReportProps & { active: boolean; source?: MissionPassageSection }) {
  const bodies = useReportBodies(source(props, () => props.active))
  return <Show when={missionReportHas(props.mission, props.report, "artifact")}><MissionReaderSection label="missions.control.artifact" raw
    text={bodies.artifact.settled() ? JSON.stringify(bodies.artifact.value(), null, 2) : ""} read={bodies.artifact.read()}
    identity={props.identity} instanceId={props.instanceId} source={props.source} /></Show>
}
