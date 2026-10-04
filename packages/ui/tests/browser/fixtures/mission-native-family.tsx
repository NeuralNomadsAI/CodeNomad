import { render } from "solid-js/web"
import type { V2Event } from "@opencode/client"
import type { WorkspaceEventPayload } from "../../../../server/src/api-types"
import InstanceShell from "../../../src/components/instance/instance-shell2"
import { RIGHT_PANEL_TAB_STORAGE_KEY } from "../../../src/components/instance/shell/storage"
import { initializeClientState, writeClientLayoutValue } from "../../../src/stores/client-state"
import { missionProjectView } from "../../../src/stores/mission-view-state"
import { activeSessionId, activeParentSessionId, seedRestoredSessionSelection, setSessionPage, setSessions } from "../../../src/stores/session-state"
import { getSessionDraftPrompt } from "../../../src/stores/sessions"
import { clearSessionCatalogState, refreshSessionCatalog } from "../../../src/stores/session-api"
import type { Session } from "../../../src/types/session"
import { addInstance, instances } from "../../../src/stores/instances"
import { ensureWorktreesLoaded } from "../../../src/stores/worktrees"
import { serverEvents } from "../../../src/lib/server-events"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { promptInputHeight } from "../../../src/components/prompt-input/height-state"
import "../../../src/index.css"

// Production whole-InstanceShell foundation, independent of the concurrent
// mission-cross-navigation fixture. Native HTTP/SSE transport remains fake.
await initializeClientState()
writeClientLayoutValue(RIGHT_PANEL_TAB_STORAGE_KEY, "missions")
const id = "native-family", scope = "/fixture", client = sdkManager.createClient(id, `/workspaces/${id}/instance`, () => true)
addInstance({ id, folder: scope, port: 0, pid: 0, proxyPath: `/workspaces/${id}/instance`, status: "ready", client,
  metadata: { project: { id: "project", directory: scope, canonical: scope } } })
const definitions = [["A", null], ["actor", "A"], ["child", "actor"], ["grandchild", "child"], ["B", null], ["outside", null]] as const
const initial = definitions.map(([name, parent]) => ({ id: `ses_${name}`, instanceId: id, parentId: parent ? `ses_${parent}` : null,
  title: `Conversation ${name}`, agent: "build", model: { providerId: "fixture", modelId: "fixture" }, projectID: "project", cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  status: name === "grandchild" ? "working" : "idle", runtimeStatusKnown: true,
  location: { directory: scope }, time: { created: 1, updated: 1 } } satisfies Session))
setSessions(previous => new Map(previous).set(id, new Map(initial.map(session => [session.id, session]))))
setSessionPage(id, ["ses_A", "ses_B", "ses_outside"], false, true)
seedRestoredSessionSelection(id, "ses_B", "ses_B")
await ensureWorktreesLoaded(id)
const emit = (event: V2Event) => (serverEvents as unknown as { dispatchBatch(events: WorkspaceEventPayload[]): void }).dispatchBatch([
  { type: "instance.event", instanceId: id, event } as WorkspaceEventPayload,
])
const snapshot = () => ({ session: activeSessionId().get(id), root: activeParentSessionId().get(id),
  heightPreference: promptInputHeight(),
  selectedMission: missionProjectView(scope).selected, drafts: Object.fromEntries(initial.map(session => [session.id, getSessionDraftPrompt(id, session.id)])) })
async function measureComposer() {
  await document.fonts.ready
  // Drawer transforms do not resize the textbox; wait for those too before
  // treating unchanged textbox geometry as a settled full-page capture.
  await Promise.all(document.getAnimations().filter(animation => animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => undefined)))
  const textarea = [...document.querySelectorAll<HTMLTextAreaElement>("textarea.prompt-input")].find(node => node.getBoundingClientRect().width > 0)!
  const wrapper = textarea.closest<HTMLElement>(".prompt-input-wrapper")!, footer = wrapper.querySelector<HTMLElement>(".prompt-input-footer")!
  const overlay = wrapper.querySelector<HTMLElement>(".prompt-input-overlay"), center = textarea.closest<HTMLElement>("[data-session-center-width]")!
  const rectangle = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right } }
  let previous = "", stable = 0, frames = 0
  while (stable < 8 && frames++ < 120) {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    const current = JSON.stringify([rectangle(textarea), rectangle(footer), rectangle(center), overlay && rectangle(overlay)])
    stable = current === previous ? stable + 1 : 0; previous = current
  }
  const css = getComputedStyle(textarea), text = rectangle(textarea), foot = rectangle(footer)
  const overlayVisible = !!overlay && getComputedStyle(overlay).display !== "none"
  const help = overlayVisible ? rectangle(overlay!) : null
  const firstLine = { y: text.y + parseFloat(css.paddingTop), height: parseFloat(css.lineHeight) }
  const textHit = document.elementFromPoint(text.x + text.width / 2, firstLine.y + firstLine.height / 2)
  const helpHit = help && document.elementFromPoint(help.x + help.width / 2, help.y + help.height / 2)
  const send = footer.querySelector<HTMLElement>(".send-button")!, sendRect = rectangle(send)
  const sendHit = document.elementFromPoint(sendRect.x + sendRect.width / 2, sendRect.y + sendRect.height / 2)
  const contentWidth = text.width - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)
  const context = document.createElement("canvas").getContext("2d")!
  context.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`
  const placeholderWidth = context.measureText(textarea.placeholder).width
  return { stableFrames: stable, frames, viewport: { width: innerWidth, height: innerHeight, scale: visualViewport?.scale,
    devicePixelRatio, coarse: matchMedia("(pointer: coarse)").matches }, direction: document.documentElement.dir,
    applicationZoom: getComputedStyle(document.documentElement).zoom, value: textarea.value, placeholder: textarea.placeholder,
    textarea: text, footer: foot, center: rectangle(center), compact: wrapper.dataset.compactAuto,
    inlineHeight: textarea.style.height, computedHeight: css.height, paddingTop: css.paddingTop, paddingBottom: css.paddingBottom,
    lineHeight: css.lineHeight, contentWidth, placeholderWidth, placeholderEstimatedLines: Math.ceil(placeholderWidth / contentWidth),
    firstLine, overlay: help, overlayText: overlay?.textContent,
    textContentBottom: text.bottom - parseFloat(css.paddingBottom),
    helperScrollable: !!overlay && overlay.scrollWidth > overlay.clientWidth,
    helperFocusIndex: overlay?.tabIndex,
    helperDescription: textarea.getAttribute("aria-describedby"),
    helperHitTesting: !!overlay && !!helpHit && (helpHit === overlay || overlay.contains(helpHit)),
    firstLineOverlapsHelp: !!help && firstLine.y < help.bottom && firstLine.y + firstLine.height > help.y,
    textboxAndFooterSeparate: text.bottom <= foot.y + 1,
    textboxHitTesting: textHit === textarea,
    sendHitTesting: sendHit === send || (!!sendHit && send.contains(sendHit)),
    footerInsideViewport: foot.bottom <= innerHeight + 1 && foot.x >= -1 && foot.right <= innerWidth + 1,
    buttons: [...footer.querySelectorAll<HTMLElement>("button")].map(button => ({ label: button.getAttribute("aria-label"), rect: rectangle(button) })),
    htmlOverflow: document.documentElement.scrollWidth > innerWidth }
}
function Fixture() {
  window.missionNativeFamily = {
    snapshot, emit, measureComposer,
    ask: () => {
      const question: Extract<V2Event, { type: "form.created" }>["data"]["form"] = { id: "child-question", sessionID: "ses_grandchild", title: "Child choice", fields: [
        { type: "string", key: "answer", title: "Which approach?" },
      ] }
      emit({ type: "form.created", id: "event-question", created: 1, location: { directory: scope }, data: { form: question } })
      emit({ type: "form.created", id: "event-global", created: 1, location: { directory: scope },
        data: { form: { ...question, id: "global-question", sessionID: "global", title: "Global choice" } } })
    },
    askPermission: () => {
      emit({ type: "permission.asked", id: "event-permission", created: 1, location: { directory: scope },
        data: { id: "child-permission", sessionID: "ses_grandchild", action: "read", resources: ["safe-fixture.txt"] } })
      emit({ type: "permission.asked", id: "event-global-permission", created: 1, location: { directory: scope },
        data: { id: "global-permission", sessionID: "global", action: "global-read", resources: ["global-fixture.txt"] } })
    },
    coldChild: async () => {
      await refreshSessionCatalog(id, true)
      clearSessionCatalogState(id)
      setSessions(previous => { const next = new Map(previous), catalog = new Map(next.get(id)); catalog.delete("ses_child"); next.set(id, catalog); return next })
    },
  }
  return <div style={{ height: "100vh", display: "flex", "flex-direction": "column" }}>
    <InstanceShell instance={instances().get(id)!} isActiveInstance escapeInDebounce={false} paletteCommands={() => []}
      onExecuteCommand={() => {}} onCloseSession={() => {}} onNewSession={() => {}}
      handleSidebarAgentChange={async () => {}} handleSidebarModelChange={async () => {}} tabBarOffset={0}
      mobileFullscreenMode={false} onEnterMobileFullscreen={() => {}} onExitMobileFullscreen={() => {}} />
  </div>
}
declare global {
  interface Window {
    missionNativeFamily: { snapshot(): ReturnType<typeof snapshot>; emit(event: V2Event): void; ask(): void; askPermission(): void; coldChild(): Promise<void>; measureComposer(): ReturnType<typeof measureComposer> }
  }
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
