import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import StatusTab from "../../../src/components/instance/shell/right-panel/tabs/StatusTab"
import { DEFAULT_RIGHT_PANEL_CUSTOMIZATION } from "../../../src/components/instance/shell/right-panel/registry"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { shellStore } from "../../../src/stores/shells"
import type { Instance } from "../../../src/types/instance"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

const names = ["dnd-5e", "dnd-rules", "fastctx", "foundry", "open5e", "qmd", "remoteshell", "serena"]
const calls: unknown[] = []
let settle: ((fail: boolean) => void) | undefined
const client = { mcp: {
  connect: (input: any) => mutate(input, "connected"),
  disconnect: (input: any) => mutate(input, "disabled"),
} }
const [instance, setInstance] = createSignal<Instance>({
  id: "mcp-motion", folder: "/fixture", port: 0, pid: 0, proxyPath: "/fixture", status: "ready", client: client as any,
  metadata: { mcpStatus: { location: { directory: "/fixture" }, data: names.map(name => ({ name, status: { status: "connected" } })) } as any },
})
function mutate(input: any, status: string) {
  calls.push(input)
  return new Promise<void>((resolve, reject) => {
    settle = fail => {
      settle = undefined
      if (fail) return reject(new Error("Fixture connection failure"))
      setStatus(input.server, status)
      resolve()
    }
  })
}
function setStatus(name: string, status: string) {
  setInstance(previous => ({ ...previous, metadata: { mcpStatus: {
    ...previous.metadata!.mcpStatus!,
    data: previous.metadata!.mcpStatus!.data.map(server => server.name !== name ? server : {
      ...server, status: { status, ...(status === "failed" ? { error: "Fixture server failed" } : {}) },
    }),
  } as any } }))
}
// No native runtime is contacted: only the transport and unrelated Shell inventory are replaced.
shellStore.load = async () => {}
await applyUiSettings({ locale: "en" })
function Fixture() {
  const { t } = useI18n()
  const [expanded, setExpanded] = createSignal<string[]>(["mcp"])
  return <main style={{ width: "360px" }}>
    <StatusTab instanceId="mcp-motion" instance={instance()} t={t} activeSession={() => null}
      isActive={() => true} expandedItems={expanded} onExpandedItemsChange={setExpanded}
      customization={() => ({ ...DEFAULT_RIGHT_PANEL_CUSTOMIZATION,
        hiddenStatusSectionIds: ["tokens", "yolo-mode", "provider-usage", "background-processes", "plugins"],
      })} onCustomizationChange={() => {}} />
  </main>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).mcpFixture = { settle: (fail = false) => settle?.(fail), setStatus, calls }
