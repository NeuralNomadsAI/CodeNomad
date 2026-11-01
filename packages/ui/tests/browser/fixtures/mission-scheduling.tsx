import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { MissionLaunchPolicy } from "../../../../server/src/missions/launch-policy"
import { MissionScheduling, type MissionSchedulingLock } from "../../../src/components/mission-scheduling"
import { newMissionSchedulingDraft } from "../../../src/components/mission-scheduling-data"
import { decodeMissionSchedulingPolicy } from "../../../src/components/mission-scheduling-decode"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

const query = new URLSearchParams(location.search)
await applyUiSettings({ locale: (query.get("locale") || "en") as any })
function Fixture() {
  const [draft, change] = createSignal(newMissionSchedulingDraft("UTC"))
  const [policy, setPolicy] = createSignal<MissionLaunchPolicy>()
  const [lock, setLock] = createSignal<MissionSchedulingLock | null>(null)
  const [capability, setCapability] = createSignal<"available" | "activatable" | "missing" | "loading">("available")
  const [sources, setSources] = createSignal({
    "schedule-success": [{ id: "msn_schedule", label: "Daily checks" }],
    "mission-completed": [{ id: "msn_oneoff", label: "Deliver feature" }],
    "branch-commits": [{ id: "refs/heads/dev", label: "dev" }],
    "conversation-message": [{ id: "ses_followed", label: "Followed conversation" }],
  })
  ;(window as any).schedulingFixture = { change: (patch: object) => change(value => ({ ...value, ...patch })),
    draft, policy, lock: setLock, capability: setCapability, sources: setSources,
    load: (policy: MissionLaunchPolicy) => change(decodeMissionSchedulingPolicy(policy, "/fixture", "UTC")) }
  return <main class="mission-editor window-shell" style={{ width: "min(420px, 100%)", margin: "auto", color: "var(--text-primary)" }}>
    <div class="window-body"><MissionScheduling draft={draft()} directory="/fixture" sources={sources()}
      capability={capability()} lockReason={lock()} anchorAt={Date.parse("2026-03-07T12:00:00Z")}
      onChange={change} onPolicy={setPolicy} /></div>
  </main>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
