import { Show, createEffect, createSignal, onCleanup, untrack } from "solid-js"
import { render } from "solid-js/web"
import { MissionEditor } from "../../../src/components/mission-editor"
import type { MissionEditorAction } from "../../../src/stores/mission-editor-state"
import { missionScheduleEditorHold } from "../../../src/stores/mission-schedule-editor-holds"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { addInstance, updateInstance } from "../../../src/stores/instances"
import { getRootClient } from "../../../src/stores/opencode-client"
import { activateMissionDemand, deactivateMissionDemand } from "../../../src/stores/missions"
import { createMissionLifecycle } from "../../../src/components/mission-lifecycle-controls"
import { serverApi } from "../../../src/lib/api-client"
import type { MissionPanelMap } from "../../../../server/src/api-types"
import { initializeClientState } from "../../../src/stores/client-state"
import "../../../src/index.css"

await initializeClientState()
addInstance({ id: "fixture", folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client: null,
  metadata: { project: { id: "project", directory: "/fixture", canonical: "/fixture" } } })
function Fixture() {
  const [directory, setDirectory] = createSignal("/fixture")
  const [mounted, mount] = createSignal(true), [active, activate] = createSignal(true)
  const [action, setAction] = createSignal<MissionEditorAction>(), [saved, setSaved] = createSignal(0)
  const [prepared, setPrepared] = createSignal<MissionPanelMap>()
  createEffect(() => {
    if (!prepared()) return
    untrack(() => activateMissionDemand("fixture"))
    onCleanup(() => deactivateMissionDemand("fixture"))
  })
  const Lifecycle = (props: { mission: MissionPanelMap }) => {
    const lifecycle = createMissionLifecycle({ instanceId: "fixture", get mission() { return props.mission } })
    return <Show when={lifecycle.primary()}>{item => <button aria-label={item().ariaLabel} disabled={item().disabled}
      onClick={() => void item().onSelect()}>{item().label}</button>}</Show>
  }
  window.schedulingEditor = {
    prepared: mission => { updateInstance("fixture", { client: getRootClient("fixture") }); setPrepared(mission); setAction({ kind: "edit", mission }) },
    create: () => setAction({ kind: "create" }), mount, activate,
    directory: value => { setDirectory(value); updateInstance("fixture", { folder: value }) },
    journal: async () => {
      const read = await serverApi.fetchMission("fixture", "msn_fixture")
      if (!read.available || !read.mission) throw new Error("Fixture mission unavailable")
      setAction({ kind: "edit", mission: read.mission })
    },
    draft: () => action()?.draft,
    held: () => missionScheduleEditorHold(JSON.stringify([JSON.stringify(["fixture", directory(), "project"]), action()?.kind === "create" ? "create" : action()?.mission?.id ?? "msn_fixture"])),
  }
  return <main style={{ "max-width": "600px", margin: "auto", color: "var(--text-primary)" }}>
    <output data-saved hidden>{saved()}</output>
    <Show when={!action() && prepared()}>{mission => <Lifecycle mission={mission()} />}</Show>
    <Show when={mounted() && action()} keyed>{open => <MissionEditor instanceId="fixture" directory={directory()} viewDirectory={directory()}
      projectID="project" action={open} active={active}
      onDispose={draft => { if (draft && action() === open) setAction({ ...open, draft }) }}
      onSaved={async () => {
        const mission = prepared()
        if (mission) {
          const read = await serverApi.fetchMission("fixture", mission.id)
          if (read.available && read.mission) setPrepared(read.mission)
        }
        setAction(undefined)
        setSaved(value => value + 1)
      }} onCancel={() => setAction(undefined)} />}</Show>
  </main>
}
declare global {
   interface Window { schedulingEditor: { create(): void; journal(): Promise<void>; directory(value: string): void; prepared(mission: MissionPanelMap): void; mount(value: boolean): void; activate(value: boolean): void
    draft(): MissionEditorAction["draft"]; held(): ReturnType<typeof missionScheduleEditorHold> } }
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
