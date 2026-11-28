import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { MissionLaunchPolicy } from "../../../../server/src/missions/launch-policy"
import { MissionScheduling } from "../../../src/components/mission-scheduling"
import { newMissionCriterion, newMissionSchedulingDraft, type MissionCriterionKind } from "../../../src/components/mission-scheduling-data"
import { decodeMissionSchedulingPolicy } from "../../../src/components/mission-scheduling-decode"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

const query = new URLSearchParams(location.search)
await applyUiSettings({ locale: (query.get("locale") || "en") as any })
function Fixture() {
  // `?zone=system` starts on the browser's own zone, like a new editor draft.
  const [draft, change] = createSignal(query.get("zone") === "system" ? newMissionSchedulingDraft() : newMissionSchedulingDraft("UTC"))
  const [policy, setPolicy] = createSignal<MissionLaunchPolicy>()
  const [started, setStarted] = createSignal(false)
  const [sources, setSources] = createSignal({ "branch-commits": [{ id: "refs/heads/dev", label: "dev" }],
    "conversation-message": [{ id: "ses_followed", label: "Followed conversation" }] })
  ;(window as any).schedulingFixture = { change: (patch: object) => change(value => ({ ...value, ...patch })),
    draft, policy, started: setStarted, sources: setSources,
    row: (kind: MissionCriterionKind, patch: object = {}) => ({ ...newMissionCriterion(kind), ...patch }),
    load: (policy: MissionLaunchPolicy) => change(decodeMissionSchedulingPolicy(policy, "/fixture", "UTC")) }
  return <main class="mission-editor window-shell" style={{ width: "min(420px, 100%)", margin: "auto", color: "var(--text-primary)" }}>
    <div class="window-body"><MissionScheduling draft={draft()} directory="/fixture" sources={sources()}
      repository={{ repository: { provider: "github", host: "github.com", repository: "acme/repo" }, loading: false, failed: false, retry() {} }}
      started={started()}
      onChange={change} onPolicy={setPolicy} /></div>
  </main>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
