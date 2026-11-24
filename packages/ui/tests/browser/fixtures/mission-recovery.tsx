import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { MissionActorActivity, MissionMap } from "../../../../server/src/api-types"
import { MissionRecoveryButton } from "../../../src/components/mission-recovery-button"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import "../../../src/index.css"

const initial: MissionMap = {
  version: 1, id: "mission-recovery", projectID: "fixture", projectCanonical: "/fixture", objective: "Fixture",
  template: "custom", coordinatorSessionId: "ses_coordinator", status: "active", runState: "running", revision: 1,
  actors: ["coordinator", "specialist"].map(kind => ({ sessionId: `ses_${kind}`, kind: kind as "coordinator" | "specialist",
    managed: true, title: kind, roles: [], location: { directory: "/fixture" }, joinedAt: 1, runtimeStatus: "unknown" })),
  tasks: [{ id: "task-report", key: "task-report", title: "Existing work", brief: "Existing brief", role: "research", status: "queued",
    actorSessionId: "ses_specialist", admissionId: "msg_admitted", blockedBy: [], outstandingExecution: true, createdAt: 1, updatedAt: 1 }],
  frontier: [], claims: [], reports: [], createdAt: 1, updatedAt: 1, history: [], historyTruncated: false,
}
function Fixture() {
  const [mission, setMission] = createSignal(initial)
  const [activity, setActivity] = createSignal<MissionActorActivity["state"] | undefined>("idle-without-report")
  const [mounted, setMounted] = createSignal(true)
  const [disabled, setDisabled] = createSignal(false)
  const refreshes: string[] = []
  let failRefresh = false
  const refresh = (target: string) => {
    refreshes.push(target)
    if (failRefresh) throw new Error("Fixture display refresh failed")
  }
  ;(window as any).recoveryFixture = {
    mount: setMounted,
    disabled: setDisabled,
    failRefresh: (value: boolean) => { failRefresh = value },
    activity: setActivity,
    patch: (patch: Partial<MissionMap>) => setMission(value => ({ ...value, ...patch })),
    task: (patch: Partial<MissionMap["tasks"][number]>) => setMission(value => ({ ...value, tasks: [{ ...value.tasks[0], ...patch }] })),
    runtime: (runtimeStatus: "working" | "idle" | "unknown") => setMission(value => ({ ...value, actors: value.actors.map(actor => ({ ...actor, runtimeStatus })) })),
    refreshes: () => refreshes,
  }
  return <main style={{ padding: "16px" }}><Show when={mounted()}>
    <section data-target="coordinator"><MissionRecoveryButton instanceId="fixture" mission={mission()} target="coordinator"
      activity={activity()} disabled={disabled()} onAdmitted={() => refresh("coordinator")} /></section>
    <section data-target="report"><MissionRecoveryButton instanceId="fixture" mission={mission()} target="report" taskKey="task-report"
      activity={activity()} disabled={disabled()} onAdmitted={() => refresh("report")} /></section>
  </Show></main>
}
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
