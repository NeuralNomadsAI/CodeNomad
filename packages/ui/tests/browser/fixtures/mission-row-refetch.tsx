import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { MissionMap } from "../../../../server/src/api-types"
import type { MissionCleanup } from "../../../../server/src/missions/model"
import { MissionAttention } from "../../../src/components/mission-attention"
import { MissionCleanupPanel } from "../../../src/components/mission-cleanup"
import { replaceFormQueue, type FormWithLocation } from "../../../src/stores/forms"
import { addPermissionToQueue, removePermissionFromQueue } from "../../../src/stores/instances"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import "../../../src/index.css"

const instanceId = "row-refetch"
const initialMission = {
  id: "mission", actors: [{ sessionId: "actor-a", title: "Actor A" }, { sessionId: "actor-b", title: "Actor B" }], tasks: [],
} as unknown as MissionMap
const initialReceipt: MissionCleanup = { missionID: "mission", deletionID: "deletion", requestID: "request", expectedRevision: 1,
  deleteManagedSessions: true, objective: "Cleanup receipt", removed: 0, retained: 0, pending: 1, reasons: [], createdAt: 1 }

function Fixture() {
  const [mission, setMission] = createSignal(initialMission)
  const [forms, setForms] = createSignal<FormWithLocation[]>([{ id: "same-request", sessionID: "actor-a", title: "Form title", fields: [], location: { directory: "/fixture" } }])
  let permission = { id: "same-request", sessionID: "actor-b", action: "Permission title", resources: ["fixture.txt"] }
  const [cleanups, setCleanups] = createSignal([initialReceipt])
  const [disabled, setDisabled] = createSignal(false)
  const [active, setActive] = createSignal(true)
  const [cleanupInstance, setCleanupInstance] = createSignal(instanceId)
  const [width, setWidth] = createSignal(420)
  const [generation, setGeneration] = createSignal(0)
  const [navigation, setNavigation] = createSignal("")
  const [refreshes, setRefreshes] = createSignal(0)
  replaceFormQueue(instanceId, forms())
  addPermissionToQueue(instanceId, permission)
  const publishForms = (next: FormWithLocation[]) => { setForms(next); replaceFormQueue(instanceId, next) }
  ;(window as any).missionRowFixture = {
    width: setWidth, disabled: setDisabled, active: setActive, instance: setCleanupInstance,
    receipt: () => structuredClone(cleanups()),
    refetch: () => {
      setMission(structuredClone(mission()))
      publishForms(structuredClone(forms()))
      if (permission) addPermissionToQueue(instanceId, structuredClone(permission))
      setCleanups(structuredClone(cleanups()))
      setGeneration(value => value + 1)
    },
    update: () => {
      setMission(value => ({ ...value, actors: value.actors.map(actor => ({ ...actor, title: `${actor.title} refreshed` })) }))
      publishForms(forms().map(form => ({ ...form, title: "Fresh form title", fields: [{ type: "string", key: "answer", title: "Answer" }] })))
      permission = { ...permission, action: "Fresh permission title", resources: ["fresh.txt"] }
      addPermissionToQueue(instanceId, permission)
      setCleanups(value => value.map(item => ({ ...item, objective: "Fresh cleanup receipt", removed: 2 })))
      setGeneration(value => value + 1)
    },
    moveForm: () => publishForms(forms().map(form => ({ ...form, sessionID: "actor-b" }))),
    closeForm: () => publishForms([]),
    closePermission: () => { removePermissionFromQueue(instanceId, permission.id); permission = undefined as any },
    settle: () => setCleanups(value => value.map(item => ({ ...item, pending: 0 }))),
    replaceReceipt: () => setCleanups(value => value.map(item => ({ ...item, requestID: "replacement", expectedRevision: 2, createdAt: 2 }))),
    restoreReceipt: () => setCleanups([structuredClone(initialReceipt)]),
    replaceMission: () => setMission(value => ({ ...value, id: "replacement-mission" })),
  }
  return <>
    <div data-fixture="attention" style={{ width: `${width()}px` }}><MissionAttention instanceId={instanceId} mission={mission()}
      onOpenActor={((version: number) => async (id: string) => { setNavigation(`${id}:${version}`) })(generation())} /></div>
    <div data-fixture="cleanup" style={{ width: `${width()}px` }}><MissionCleanupPanel instanceId={cleanupInstance()} cleanups={cleanups()}
      disabled={disabled()} active={active()} refresh={async () => { setRefreshes(value => value + 1) }} /></div>
    <output data-fixture="navigation">{navigation()}</output>
    <output data-fixture="refreshes">{refreshes()}</output>
    <button type="button" data-fixture="outside">Outside control</button>
  </>
}
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
