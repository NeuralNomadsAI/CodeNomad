import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { MissionReport } from "../../../../server/src/api-types"
import { MissionReportNotification } from "../../../src/components/mission-native-execution"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import "../../../src/index.css"

const initial: MissionReport = { id: "readout", taskKey: "investigate", sessionId: "ses_coordinator",
  outcome: "completed", summary: "Coordinator read ordinary native results", evidence: [], next: [],
  delivery: "coordinator-readout", createdAt: 1 }
function Fixture() {
  const [report, setReport] = createSignal(initial)
  ;(window as any).missionReportDelivery = { replace: (patch: Partial<MissionReport>) => setReport({ ...initial, ...patch }) }
  return <main><MissionReportNotification report={report()} /></main>
}
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
