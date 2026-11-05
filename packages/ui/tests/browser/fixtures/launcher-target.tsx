// prototype-1236 (R27): home page and launcher with the shared "Remote project" disclosure and mixed recents.
import { serverApi } from "../../../src/lib/api-client"

const now = Date.now()
const calls: string[] = []
const longContext = new URLSearchParams(location.search).has("longContext")
const servers = [{ id: "oc-lab", kind: "explicit", label: longContext ? `מעבדה Lab ${"production-".repeat(12)}` : "Lab" }]
const config = { settings: { locale: "en" }, opencodeServers: servers }
const state = {
  recentFolders: [
    { path: "/srv/app", serverId: "oc-lab", lastAccessed: now - 1_000 },
    { path: "D:/local-project", lastAccessed: now - 60_000 },
    { path: "/gone/app", serverId: "oc-removed", lastAccessed: now - 120_000 },
  ],
  remoteServers: [{ id: "saved-server", name: "Saved remote", baseUrl: "https://remote.example.test", skipTlsVerify: false, createdAt: now, updatedAt: now }],
}
serverApi.fetchConfigOwner = async (owner: string) => (owner === "server" ? config : { settings: { locale: "en" } }) as any
serverApi.fetchStateOwner = async () => state as any
serverApi.patchStateOwner = async (_owner: string, patch: unknown) => ({ ...Object.assign(state, patch) }) as any
serverApi.listOpenCodeFolders = async (serverId: string, path?: string) => {
  calls.push(`list:${serverId}:${path ?? ""}`)
  const current = path ?? "/srv"
  const parent = current.split("/").slice(0, -1).join("/") || "/"
  return { entries: [
    { name: "app", path: `${current}/app`, absolutePath: `${current}/app`, type: "directory" },
    { name: "lib", path: `${current}/lib`, absolutePath: `${current}/lib`, type: "directory" },
  ], metadata: { scope: "unrestricted", currentPath: current, parentPath: current === "/" ? undefined : parent, rootPath: "/",
    homePath: "/srv", displayPath: longContext ? `/very/${"long-path/".repeat(40)}${current}` : current, pathKind: "absolute" } } as any
}
serverApi.addOpenCodeServer = async (payload) => {
  calls.push(`add:${payload.address}`)
  return { id: "oc-new", label: payload.name ?? "new", origin: new URL(payload.address).origin }
}
serverApi.removeOpenCodeServer = async (id: string) => { calls.push(`remove:${id}`) }
serverApi.listFileSystem = async () => { throw new Error("A remote project must never read this computer's filesystem") }

const { createSignal, Show } = await import("solid-js")
const { render } = await import("solid-js/web")
const { ConfigProvider, updatePreferences } = await import("../../../src/stores/preferences")
const { I18nProvider } = await import("../../../src/lib/i18n")
const { ThemeProvider } = await import("../../../src/lib/theme")
const { default: AlertDialog } = await import("../../../src/components/alert-dialog")
const { default: FolderSelectionView } = await import("../../../src/components/folder-selection-view")
const { default: NewInstanceLauncher } = await import("../../../src/components/new-instance-launcher")
await import("../../../src/index.css")

const open = (path: string, serverId?: string) => calls.push(`open:${serverId ?? "local"}:${path}`)
function Launcher() {
  const [anchor, setAnchor] = createSignal<HTMLElement>()
  const [launcherOpen, setLauncherOpen] = createSignal(false)
  return <>
    <button type="button" ref={setAnchor} onClick={() => setLauncherOpen(true)}>New instance</button>
    <NewInstanceLauncher open={launcherOpen()} anchor={anchor()} isLoading={false} onOpenChange={setLauncherOpen}
      onSelectFolder={open} onSelectExistingInstance={() => {}} onNewTemporaryInstance={() => calls.push("temporary")} />
  </>
}

render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <Show when={new URLSearchParams(location.search).has("launcher")} fallback={
    <FolderSelectionView onSelectFolder={open} onSelectExistingInstance={() => {}}
      onNewTemporaryInstance={() => calls.push("temporary")} onOpenSidecar={() => {}} />
  }>
    <Launcher />
  </Show>
  <AlertDialog />
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
await updatePreferences({ locale: "en" })
;(window as any).launcherTarget = { calls }
