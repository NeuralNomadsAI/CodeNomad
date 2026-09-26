import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import SkillAttachments from "../../../src/components/prompt-input/SkillAttachments"
import MessagePart from "../../../src/components/message-part"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { serverEvents } from "../../../src/lib/server-events"
import { getAttachments } from "../../../src/stores/attachments"
import { normalizeSessionMessage } from "../../../src/stores/message-v2/normalizers"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

const [session, setSession] = createSignal("a")
const [active, setActive] = createSignal(true)
const pending: Array<{ directory: string; resolve: (value: any) => void }> = []
const client = { skill: { list: ({ location }: any) => new Promise(resolve => pending.push({ directory: location.directory, resolve })) } }
;(sdkManager as any).clients.set("skills:/workspaces/skills/instance", client)
const part = normalizeSessionMessage("a", { type: "user", id: "m", text: "review", time: { created: 1 }, skills: [{ id: "review", name: "Review" }] }).message.parts[1]
await applyUiSettings({})
render(() => <ConfigProvider><I18nProvider><ThemeProvider><main style={{ width: "min(700px, 100%)" }}>
  <SkillAttachments instanceId="skills" sessionId={session()} directory={`/${session()}`} active={active()} disabled={false} />
  <MessagePart part={part} instanceId="skills" sessionId="a" messageType="user" />
</main></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = { setSession, setActive, pending: () => pending.map(item => item.directory),
  invalidate: () => (serverEvents as any).dispatch({ type: "instance.event", instanceId: "skills",
    event: { type: "skill.updated", data: {}, location: { directory: `/${session()}` } } }),
  resolve: (index: number, id = "review") => pending[index].resolve({ data: [{ id, name: id, path: "/skill", content: "not injected" }] }),
  selected: () => getAttachments("skills", session()).map(item => item.source),
}
