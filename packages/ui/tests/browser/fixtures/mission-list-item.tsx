import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { ArrowUpRight, Eye, Minus, Pencil, RefreshCw } from "lucide-solid"
import { MissionListItem } from "../../../src/components/mission-list-item"
import { createMissionRecoveryAction } from "../../../src/components/mission-recovery-button"
import { MissionHistory } from "../../../src/components/mission-history"
import { MissionCleanupPanel } from "../../../src/components/mission-cleanup"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import type { MissionMap } from "../../../../../server/src/api-types"
import "../../../src/index.css"

const mission = {
  id: "fixture-mission", revision: 1, status: "active", runState: "running", coordinatorSessionId: "coordinator",
  actors: [{ sessionId: "coordinator", title: "Coordinator" }], tasks: [],
  history: [{ revision: 1, createdAt: 1700000000000, source: "user", reason: "A long plan change reason for the shared history item reader" }],
} as unknown as MissionMap

function Fixture() {
  const { t } = useI18n()
  const [width, setWidth] = createSignal(520)
  const [compact, setCompact] = createSignal(false)
  const [status, setStatus] = createSignal("Running")
  const [count, setCount] = createSignal(0)
  const [disabled, setDisabled] = createSignal(false)
  const [focusAction, setFocusAction] = createSignal(false)
  const [generation, setGeneration] = createSignal(0)
  const [reverse, setReverse] = createSignal(false)
  const [checked, setChecked] = createSignal<boolean>()
  const [omitRecovery, setOmitRecovery] = createSignal(false)
  const [lastSelection, setLastSelection] = createSignal("")
  const [lastHover, setLastHover] = createSignal("")
  const recovery = createMissionRecoveryAction({ instanceId: "fixture", mission, target: "coordinator", activity: "unknown", onAdmitted: () => {} })
  ;(window as any).missionListFixture = { width: setWidth, compact: setCompact, status: setStatus, disabled: setDisabled, focusAction: setFocusAction,
    refresh: () => setGeneration(value => value + 1), reverse: setReverse, checked: setChecked, omitRecovery: setOmitRecovery }
  const selected = () => {
    setCount(value => value + 1)
    if (focusAction()) document.querySelector<HTMLButtonElement>('[data-fixture="reader-focus"]')?.focus()
  }
  return <>
    <div data-fixture="main" style={{ width: `${width()}px` }}>
      <MissionListItem text="A deliberately long mission objective that fills two lines and should remain separated from its status and all actions"
        status={status()} statusKind="running" compact={compact()} selected onSelect={selected}
        actions={(() => {
          const version = generation()
          const items = [
          { key: "read", label: t("missions.control.read"), icon: <Eye />, onSelect: selected },
          { key: "coordinator", label: t("missions.control.openCoordinator"), icon: <ArrowUpRight />, onSelect: selected },
          { key: "recover", label: t("missions.recovery.coordinator"), icon: <RefreshCw />, onSelect: selected },
          { key: "edit", label: t("missions.control.edit"), icon: <Pencil />, disabled: disabled(), onSelect: selected },
          { key: "delete", label: t("missions.control.delete"), icon: <Minus />, onSelect: selected },
          ].filter(item => !omitRecovery() || item.key !== "recover")
          if (reverse()) items.reverse()
          return items.map(item => ({ ...item, label: `${item.label}${version ? ` ${version}` : ""}`, description: `generation ${version}`,
            checked: item.key === "edit" ? checked() : undefined,
            onSelect: () => { setLastSelection(`${item.key}:${version}`); selected() },
            onMouseEnter: () => setLastHover(`${item.key}:${version}:enter`), onMouseLeave: () => setLastHover(`${item.key}:${version}:leave`),
          }))
        })()} />
    </div>
    <output data-fixture="count">{count()}</output>
    <output data-fixture="selection">{lastSelection()}</output>
    <output data-fixture="hover">{lastHover()}</output>
    <button type="button" data-fixture="reader-focus">Reader focus target</button>
    <div data-fixture="recovery" style={{ width: `${Math.min(width(), 180)}px` }}><MissionListItem text="Recovery fixture" status="Running"
      actions={recovery.action() ? [recovery.action()!] : []}>{recovery.feedback}</MissionListItem></div>
    <div data-fixture="history" style={{ width: "220px" }}><MissionHistory mission={mission} onRead={selected} /></div>
    <div data-fixture="cleanup" style={{ width: "220px" }}><MissionCleanupPanel instanceId="fixture" disabled={false} active
      cleanups={[{ deletionID: "deletion", missionID: mission.id, objective: "Cleanup objective that has a long description", removed: 1, retained: 1,
        pending: 0, reasons: ["coordinator"], requestID: "request", expectedRevision: 1, deleteManagedSessions: true } as any]}
      refresh={async () => {}} /></div>
  </>
}
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
