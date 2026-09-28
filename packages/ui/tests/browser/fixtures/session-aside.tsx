import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import PromptInput from "../../../src/components/prompt-input"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { getRootClient } from "../../../src/stores/opencode-client"
import { addInstance, setActiveInstanceId } from "../../../src/stores/instances"
import { fetchCommands } from "../../../src/stores/commands"
import { addAttachment, getAttachments } from "../../../src/stores/attachments"
import { createFileAttachment, createTextAttachment } from "../../../src/types/attachment"
import "../../../src/index.css"

const instanceId = "aside-instance"
const [session, setSession] = createSignal("source")
const [active, setActive] = createSignal(true)
const [mounted, setMounted] = createSignal(true)
const sends: unknown[] = [], commands: unknown[] = []
let interrupts = 0
let failCommand = false
const client = getRootClient(instanceId)
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setActiveInstanceId(instanceId)
await fetchCommands(instanceId, client)
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <button id="outside">Outside control</button>
  <Show when={mounted()}><PromptInput instanceId={instanceId} instanceFolder="/fixture" sessionId={session()} isActive={active()}
    isSessionBusy={true} onAbortSession={async () => { interrupts++ }}
    onSend={async (text, attachments, delivery) => { sends.push({ text, attachments, delivery }) }}
    onCommand={async (name, text) => { commands.push({ name, text }); if (failCommand) throw new Error("fixture command failed") }} /></Show>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  switch: setSession, active: setActive, unmount: () => setMounted(false),
  failCommand: () => { failCommand = true },
  attach: () => {
    addAttachment(instanceId, session(), createFileAttachment("/fixture/notes.txt", "notes.txt"))
  },
  paste: () => {
    addAttachment(instanceId, session(), createTextAttachment("PASTED_QUESTION", "[Pasted #1]", "paste.txt"))
  },
  image: () => {
    const image = createFileAttachment("image.png", "image.png", "image/png")
    image.display = "[Image #1]"
    addAttachment(instanceId, session(), image)
  },
  snapshot: () => ({ sends, commands, interrupts, session: session(), attachments: getAttachments(instanceId, session()).length }),
}
