import { For, Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js"
import type { MissionTemplateId } from "../../../server/src/missions/model"
import type { MissionPlaybookDetails } from "../../../server/src/missions/playbook-details"
import type { MissionTaskMode } from "../../../server/src/missions/task-execution-mode"
import { serverApi } from "../lib/api-client"
import { openExternalUrl } from "../lib/external-url"
import { helpUrl } from "../lib/help-url"
import { useI18n } from "../lib/i18n"

/** One playbook as this backend defines it: steps and roles, then, folded, the complete English
 * texts its coordinator and task actors receive. Read from the server's recipes, never copied. */
export function MissionPlaybookReader(props: { playbook: MissionTemplateId; taskMode: MissionTaskMode }) {
  const { t, locale } = useI18n()
  const [details, setDetails] = createSignal<MissionPlaybookDetails>()
  const [failed, setFailed] = createSignal(false)
  const [attempt, setAttempt] = createSignal(0)
  const [helpFailed, setHelpFailed] = createSignal(false)
  createEffect(() => {
    const taskMode = props.taskMode
    attempt()
    let current = true
    setFailed(false)
    serverApi.fetchMissionPlaybooks(taskMode).then(value => { if (current) setDetails(value) }, () => { if (current) setFailed(true) })
    onCleanup(() => { current = false })
  })
  const shown = () => details()?.taskMode === props.taskMode ? details() : undefined
  const playbook = () => shown()?.playbooks.find(value => value.id === props.playbook)
  const roleLabel = (id: string, fallback: string) => {
    const key = `missions.control.profiles.role.${id}`, label = t(key)
    return label === key ? fallback : label
  }
  const guideUrl = () => `${helpUrl(locale(), "playbooks")}#${props.playbook}`
  const openGuide = async () => { setHelpFailed(false); setHelpFailed(!await openExternalUrl(guideUrl(), "help")) }
  const text = (value: string) => <pre lang="en" dir="ltr">{value}</pre>
  // One fold per recipient: each holds the complete text it receives.
  const prompt = (title: string, body: JSX.Element) => <details class="mission-playbook-prompt">
    <summary>{title}</summary>{body}
  </details>

  return <div class="mission-playbook-reader">
    <p>{t(`missions.control.template.${props.playbook}.description`)}</p>
    <p><button type="button" class="window-text-button" onClick={() => void openGuide()}>{t("missions.playbook.guide")}</button></p>
    <Show when={helpFailed()}><p role="alert">{t("missions.playbook.guideFailed", { url: guideUrl() })}</p></Show>
    <Show when={!shown() && !failed()}><p role="status">{t("missions.playbook.loading")}</p></Show>
    <Show when={failed() && !shown()}>
      <p role="alert" class="mission-playbook-failure">{t("missions.playbook.unavailable")}{" "}
        <button type="button" class="window-text-button" onClick={() => setAttempt(value => value + 1)}>{t("missionsPanel.reader.retry")}</button></p>
    </Show>
    <Show when={playbook()}>{value => <>
      <p class="mission-playbook-note">{t("missions.playbook.english")}</p>
      <section aria-label={t("missions.playbook.steps")}>
        <h3>{t("missions.playbook.steps")}</h3>
        <ol class="mission-playbook-steps" lang="en" dir="ltr"><For each={value().sequence}>{step => <li>{step}</li>}</For></ol>
      </section>
      <section aria-label={t("missions.playbook.roles")}>
        <h3>{t("missions.playbook.roles")}</h3>
        <dl class="mission-playbook-roles">
          <dt>{t("missions.control.profiles.role.coordinator")}</dt><dd>{t("missions.playbook.coordinator")}</dd>
          <For each={value().roles}>{role => <><dt>{roleLabel(role.id, role.title)}</dt><dd lang="en" dir="ltr">{role.purpose}</dd></>}</For>
        </dl>
      </section>
      <details class="mission-report-technical mission-playbook-instructions">
        <summary>{t("missions.playbook.instructions")}</summary>
        <p class="mission-playbook-note">{t("missions.playbook.instructionsNote", { mode: t(`missions.taskMode.${shown()!.taskMode}`) })}</p>
        {prompt(t("missions.playbook.coordinatorOnce"), text(value().prompts.coordinator.once))}
        {prompt(t("missions.playbook.coordinatorDaily"), text(value().prompts.coordinator.daily))}
        <For each={value().roles}>{role => {
          const received = () => value().prompts.roles[role.id]
          return prompt(roleLabel(role.id, role.title), <Show when={received().session} fallback={text(received().assignment)}>{session => <>
            <h4>{t("missions.playbook.assignment")}</h4>{text(received().assignment)}
            <h4>{t("missions.playbook.session")}</h4>{text(session())}
          </>}</Show>)
        }}</For>
      </details>
    </>}</Show>
  </div>
}
