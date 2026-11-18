import { For, Show } from "solid-js"
import { useI18n } from "../lib/i18n"
import { isMissionGithubKind } from "../../../server/src/missions/mission-github-condition"
import { repositoryEvents, type MissionRepositoryCondition } from "../../../server/src/missions/mission-repository-condition"
import type { MissionCriterionDraft } from "./mission-scheduling-data"
import type { MissionRepositoryDiscovery } from "./mission-editor-repository"

/** One event menu, grouped visually by Git and the detected forge; filters stay in the card. */
export function MissionRepositoryFields(props: { row: MissionCriterionDraft; number: number; discovery?: MissionRepositoryDiscovery;
  errorID?: string; onChange(row: MissionCriterionDraft): void }) {
  const { t } = useI18n()
  const patch = (next: Partial<MissionCriterionDraft>) => props.onChange({ ...props.row, ...next })
  const repository = () => props.discovery?.repository
  const differs = () => props.row.kind === "repository-activity" && (!repository() || props.row.repository?.provider !== repository()?.provider
    || props.row.repository?.host !== repository()?.host || props.row.repository?.repository !== repository()?.repository)
  const selected = () => props.row.kind === "repository-activity" ? differs() ? "stored" : props.row.event ?? "" : props.row.kind
  const eventLabel = (event: string) => t(`missions.scheduling.repository.${props.row.repository?.provider === "gitlab" ? "merge" : "pull"}.${event}`)
  const label = () => t("missions.scheduling.repository.event", { number: props.number })
  const choose = (value: string) => {
    const detected = repository()
    if ((repositoryEvents as readonly string[]).includes(value) && detected)
      patch({ kind: "repository-activity", event: value as MissionRepositoryCondition["event"], repository: { ...detected }, source: "", author: undefined })
    else patch({ kind: value as MissionCriterionDraft["kind"], event: undefined,
      source: isMissionGithubKind(value) ? detected?.repository ?? "" : "", repository: isMissionGithubKind(value) ? detected : undefined, author: undefined })
  }
  const special = () => repository()?.provider === "github" && repository()?.host === "github.com"
    ? ["github-notification", "github-security-alert"] : []
  const legacy = () => isMissionGithubKind(props.row.kind) && !special().includes(props.row.kind)
  return <>
    <Show when={repository() || legacy() || props.row.kind === "repository-activity"} fallback={
      <label><span>{t("missions.scheduling.repository.eventLabel")}</span><output>{t("missions.scheduling.condition.branch-commits")}</output></label>}>
    <label><span>{t("missions.scheduling.repository.eventLabel")}</span>
      <select aria-label={label()} value={selected()} aria-invalid={!!props.errorID} aria-describedby={props.errorID}
        onChange={event => choose(event.currentTarget.value)}>
        <optgroup label={t("missions.scheduling.repository.git")}>
          <option value="branch-commits">{t("missions.scheduling.condition.branch-commits")}</option>
        </optgroup>
        <Show when={repository()}>{detected => <optgroup label={t(`missions.scheduling.repository.provider.${detected().provider}`)}>
          <For each={repositoryEvents}>{event => <option value={event}>{t(`missions.scheduling.repository.${detected().provider === "gitlab" ? "merge" : "pull"}.${event}`)}</option>}</For>
          <For each={special()}>{event => <option value={event}>{t(`missions.scheduling.condition.${event}`)}</option>}</For>
        </optgroup>}</Show>
        <Show when={differs()}>
          <option value="stored" disabled>{eventLabel(props.row.event ?? "")}</option>
        </Show>
        <Show when={legacy()}><option value={props.row.kind}>{t(`missions.scheduling.condition.${props.row.kind}`)}</option></Show>
      </select>
    </label>
    </Show>
    <Show when={props.row.kind === "repository-activity" || isMissionGithubKind(props.row.kind) && props.row.repository}>
      <label class="mission-repository-identity"><span>{t("missions.scheduling.repository.repository")}</span>
        <output dir="ltr">{props.row.kind === "repository-activity" ? `${props.row.repository?.host}/${props.row.repository?.repository}` : `github.com/${props.row.source}`}</output></label>
    </Show>
    <Show when={props.discovery?.loading}><span role="status">{t("missions.scheduling.repository.detecting")}</span></Show>
    <Show when={props.discovery?.failed}><div role="alert">{t("missions.scheduling.repository.failed")}
      <button type="button" class="window-action" onClick={() => props.discovery?.retry()}>{t("missions.scheduling.repository.retry")}</button></div></Show>
    <Show when={isMissionGithubKind(props.row.kind) && !props.row.repository}>
      <label><span>{t(props.row.kind === "github-notification" ? "missions.scheduling.github.repositoryOptional" : "missions.scheduling.github.repository")}</span>
        <input aria-label={t("missions.scheduling.criterionSource", { number: props.number })} value={props.row.source} maxLength={140}
          aria-invalid={!!props.errorID} aria-describedby={props.errorID} dir="ltr"
          onInput={event => patch({ source: event.currentTarget.value })} /></label>
    </Show>
    <Show when={props.row.kind === "repository-activity" || props.row.kind === "github-pull-request" || props.row.kind === "github-issue"}>
      <label><span>{t("missions.scheduling.github.author")}</span>
        <input aria-label={t("missions.scheduling.github.author")} value={props.row.author ?? ""} maxLength={100} dir="ltr"
          aria-invalid={!!props.errorID} aria-describedby={props.errorID} onInput={event => patch({ author: event.currentTarget.value })} /></label>
    </Show>
  </>
}
