import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { MissionPassageSectionContent } from "../../../src/components/mission-passage-section"
import { MissionBodyPending } from "../../../src/components/mission-reader-body"
import { I18nProvider } from "../../../src/lib/i18n"
import { ConfigProvider } from "../../../src/stores/preferences"
import { addInstance } from "../../../src/stores/instances"

addInstance({ id: "precise", folder: "/fixture", proxyPath: "/fixture", port: 0, pid: 0, status: "ready", client: null })
const source = { projectID: "project", missionID: "mission", scheduleID: "schedule", passageID: "passage", revision: 1,
  kind: "mission" as const, field: "objective" as const }
function Fixture() {
  const [page, setPage] = createSignal(0)
  const [mounted, setMounted] = createSignal(true)
  return <>
    <section id="body"><MissionBodyPending failed={false} onRetry={() => {}} /></section>
    <button onClick={() => setPage(value => value + 1)}>Next section page</button>
    <button onClick={() => setMounted(value => !value)}>Toggle section</button>
    <section id="passage"><Show when={mounted()}><MissionPassageSectionContent instanceId="precise" source={source} page={page()} raw onPageCount={() => {}} /></Show></section>
  </>
}
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
