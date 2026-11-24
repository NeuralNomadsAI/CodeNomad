import { Show, createMemo } from "solid-js"
import { compareArtifact, comparisonText } from "../../../server/src/missions/compare-artifact"
import { compareModelNames, type MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import { useI18n } from "../lib/i18n"
import { MissionReaderSection } from "./mission-reader"

export function MissionComparisonVerdict(props: { verdict: string; models: readonly string[] }) {
  const { t } = useI18n()
  return <article><h3>{t("missions.compare.verdict")}</h3><p>{t(`missions.compare.verdict.${props.verdict}`)}</p>
    <p>A: <code>{props.models[0]}</code> · B: <code>{props.models[1]}</code></p></article>
}

export function MissionComparisonReport(props: { artifact: unknown; profiles?: MissionProfiles; identity: string; instanceId: string }) {
  const value = createMemo(() => { const parsed = compareArtifact.safeParse(props.artifact); return parsed.success ? parsed.data : undefined })
  return <Show when={value()}>{value => <>
    <MissionComparisonVerdict verdict={value().verdict} models={compareModelNames(props.profiles)} />
    <MissionReaderSection label="missions.compare.criteria" text={comparisonText(value())} identity={props.identity} instanceId={props.instanceId} />
  </>}</Show>
}
