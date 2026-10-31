import { For, Show, createMemo } from "solid-js"
import type { MissionMap, MissionReport } from "../../../server/src/api-types"
import { coordinatorDecisionArtifact, humanDecisionArtifact, missionDecisionMaker } from "../../../server/src/missions/decision-artifact"
import { useI18n } from "../lib/i18n"
import { MissionReaderSection } from "./mission-reader"

/** Who settled a report's Wayfinder decision, read only from gated reports; undefined otherwise. */
export function missionReportDecisionMaker(mission: MissionMap, report: MissionReport) {
  return missionDecisionMaker(mission.template, mission.tasks.find(task => task.key === report.taskKey), report)
}

/** A settled decision: who decided (the coordinator, or the human in CodeNomad), then the
 * question and its outcome, from `artifact`, the report's artifact as its reader read it. */
export function MissionDecisionReport(props: { mission: MissionMap; report: MissionReport; artifact: unknown; identity: string; instanceId: string }) {
  const { t } = useI18n()
  const maker = createMemo(() => missionReportDecisionMaker(props.mission, { ...props.report, artifact: props.artifact as MissionReport["artifact"] }))
  const sections = createMemo((): Array<{ label: string; text: string }> => {
    const by = maker()
    if (by === "coordinator") {
      const value = coordinatorDecisionArtifact.parse(props.artifact)
      return [{ label: "missions.decision.question", text: value.question }, { label: "missions.decision.decision", text: value.decision },
        { label: "missions.decision.rationale", text: value.rationale },
        { label: "missions.decision.alternatives", text: value.alternatives?.join("\n\n") ?? "" },
        { label: "missions.decision.reversal", text: value.reversal ?? "" }].filter(section => section.text)
    }
    if (by !== "human") return []
    const value = humanDecisionArtifact.parse(props.artifact)
    return [{ label: "missions.decision.question", text: value.question },
      { label: "missions.decision.answer", text: Array.isArray(value.answer) ? value.answer.join("\n\n") : value.answer }]
  })
  return <Show when={maker()}>{by => <>
    <article class="mission-decision" data-decided-by={by()}>
      <h3>{t(`missions.decision.${by()}`)}</h3>
      <p>{t(`missions.decision.${by()}.detail`)}</p>
    </article>
    <For each={sections().map(section => section.label)}>{label =>
      <MissionReaderSection label={label} text={sections().find(section => section.label === label)?.text ?? ""}
        identity={`${props.identity}:decision`} instanceId={props.instanceId} />}</For>
  </>}</Show>
}
