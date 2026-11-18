import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { MissionCleanup } from "../../../../server/src/missions/model"
import { MissionCleanupPanel } from "../../../src/components/mission-cleanup"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import "../../../src/index.css"

const instanceId = "row-refetch"
const initialReceipt: MissionCleanup = { missionID: "mission", deletionID: "deletion", requestID: "request", expectedRevision: 1,
  deleteManagedSessions: true, objective: "Cleanup receipt", removed: 0, retained: 0, pending: 1, reasons: [], createdAt: 1 }

function Fixture() {
  const [cleanups, setCleanups] = createSignal([initialReceipt])
  const [disabled, setDisabled] = createSignal(false)
  const [active, setActive] = createSignal(true)
  const [cleanupInstance, setCleanupInstance] = createSignal(instanceId)
  const [width, setWidth] = createSignal(420)
  const [refreshes, setRefreshes] = createSignal(0)
  ;(window as any).missionRowFixture = {
    width: setWidth, disabled: setDisabled, active: setActive, instance: setCleanupInstance,
    receipt: () => structuredClone(cleanups()),
    refetch: () => setCleanups(structuredClone(cleanups())),
    update: () => setCleanups(value => value.map(item => ({ ...item, objective: "Fresh cleanup receipt", removed: 2 }))),
    settle: () => setCleanups(value => value.map(item => ({ ...item, pending: 0 }))),
    replaceReceipt: () => setCleanups(value => value.map(item => ({ ...item, requestID: "replacement", expectedRevision: 2, createdAt: 2 }))),
    restoreReceipt: () => setCleanups([structuredClone(initialReceipt)]),
  }
  return <>
    <div data-fixture="cleanup" style={{ width: `${width()}px` }}><MissionCleanupPanel instanceId={cleanupInstance()} cleanups={cleanups()}
      disabled={disabled()} active={active()} refresh={async () => { setRefreshes(value => value + 1) }} /></div>
    <output data-fixture="refreshes">{refreshes()}</output>
    <button type="button" data-fixture="outside">Outside control</button>
  </>
}
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
