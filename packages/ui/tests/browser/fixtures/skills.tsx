import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import PromptInput from "../../../src/components/prompt-input"
import PromptAttachmentsBar from "../../../src/components/prompt-input/PromptAttachmentsBar"
import type { PromptInputApi } from "../../../src/components/prompt-input/types"
import { addInstance, setActiveInstanceId } from "../../../src/stores/instances"
import MessageSection from "../../../src/components/message-section"
import type { SessionMessageUser } from "@opencode/client"
import { setSessions, setActiveSession } from "../../../src/stores/session-state"
import { loadMessages } from "../../../src/stores/session-api"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import { sseManager } from "../../../src/lib/sse-manager"
import { serverApi } from "../../../src/lib/api-client"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { serverEvents } from "../../../src/lib/server-events"
import { addAttachment, getAttachments } from "../../../src/stores/attachments"
import { createFileAttachment } from "../../../src/types/attachment"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

const [session, setSession] = createSignal("a")
const [active, setActive] = createSignal(true)
const params = new URLSearchParams(location.search)
const skillName = params.has("longSkill") ? "m".repeat(64) + "-END-SKILL" : "Review"
const pending: Array<{ directory: string; resolve: (value: any) => void }> = []
const history: SessionMessageUser[] = [
  { type: "user", id: "history", text: "Previously sent", time: { created: 1 },
    skills: [{ id: "review", name: skillName, text: "PRIVATE-SKILL-INSTRUCTIONS" }] },
  { type: "user", id: "skill-only", text: "", time: { created: 2 },
    skills: [{ id: "review", name: skillName, text: "PRIVATE-SKILL-INSTRUCTIONS" }] },
]
const client = {
  skill: { list: ({ location }: any) => new Promise(resolve => pending.push({ directory: location.directory, resolve })) },
  session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) } },
  message: { list: async () => ({ data: [...history].reverse(), cursor: {} }) },
}
;(sdkManager as any).clients.set("skills:/workspaces/skills/instance", client)
addInstance({ id: "skills", folder: "/a", port: 0, pid: 0, proxyPath: "/workspaces/skills/instance", status: "ready", client: client as any })
setActiveInstanceId("skills")
setSessions(previous => new Map(previous).set("skills", new Map([["a", {
  id: "a", instanceId: "skills", parentId: null, title: "Skills fixture", location: { directory: "/a" },
  status: "idle", agent: "build", model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 2 },
} as any]])))
setActiveSession("skills", "a")
sseManager.getStatuses = () => new Map([["skills", "connected"]])
serverApi.fetchPermissionReceipts = async () => ({ receipts: [] })
const sends: unknown[] = [], commands: unknown[] = []
let promptInputApi: PromptInputApi | undefined
await applyUiSettings({ showMessageTimeline: false, locale: params.get("locale") === "he" ? "he" : "en" })
await loadMessages("skills", "a", { force: true })
render(() => <ConfigProvider><I18nProvider><ThemeProvider><main style={{ width: "min(700px, 100%)" }}>
  <div style={{ height: "280px", display: "flex" }}>
    <MessageSection instanceId="skills" sessionId={session()} isActive={active()} />
  </div>
  <Show when={getAttachments("skills", session()).length > 0}>
    <PromptAttachmentsBar attachments={getAttachments("skills", session())}
      onRemoveAttachment={id => promptInputApi?.removeAttachment(id)}
      onExpandTextAttachment={id => promptInputApi?.expandTextAttachment(id)} />
  </Show>
  <PromptInput instanceId="skills" sessionId={session()} instanceFolder={`/${session()}`} isActive={active()}
    registerPromptInputApi={api => { promptInputApi = api; return () => { promptInputApi = undefined } }}
    onSend={async (...args) => {
      sends.push(args)
      history.push({ type: "user", id: "sent", text: args[0], time: { created: 3 },
        skills: args[1].flatMap(item => item.source.type === "skill"
          ? [{ id: item.source.id, name: item.source.name, text: "PRIVATE-SKILL-INSTRUCTIONS" }] : []) })
      await loadMessages("skills", session(), { force: true })
    }} onCommand={async (...args) => { commands.push(args) }} />
</main></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = { setSession, setActive, sends, commands, pending: () => pending.map(item => item.directory),
  addFile: () => addAttachment("skills", session(), createFileAttachment("./notes.md", "notes.md")),
  reloadHistory: async () => {
    messageStoreBus.getOrCreate("skills").clearSession(session())
    await loadMessages("skills", session(), { force: true })
  },
  invalidate: () => (serverEvents as any).dispatch({ type: "instance.event", instanceId: "skills",
    event: { type: "skill.updated", data: {}, location: { directory: `/${session()}` } } }),
  resolve: (index: number, id = "review") => pending[index].resolve({ data: [{ id, name: id, path: "/skill", content: "not injected" }] }),
  selected: () => getAttachments("skills", session()).map(item => item.source),
}
