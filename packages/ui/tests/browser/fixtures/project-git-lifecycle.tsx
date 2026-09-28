import { createSignal, For, onCleanup } from "solid-js"
import { render } from "solid-js/web"
import { addInstance, updateInstance } from "../../../src/stores/instances"
import { activeAppTabId, appTabs, selectAppTab, type InstanceAppTab } from "../../../src/stores/app-tabs"
import { attachInstanceTabMembership, detachInstanceTabMembership } from "../../../src/stores/app-tab-membership"
import { getRootClient } from "../../../src/stores/opencode-client"
import { useGitChanges } from "../../../src/components/instance/shell/right-panel/useGitChanges"
import { invalidateFilesystemCaches } from "../../../src/lib/filesystem-events"
import { backgroundReads } from "../../../src/lib/background-read-queue"

const mounts: Record<string, number> = {}, disposals: Record<string, number> = {}
const panels: Record<string, ReturnType<typeof useGitChanges>> = {}
const worktree: Record<string, (slug: string) => void> = {}
function add(id: string) {
  addInstance({ id, folder: `D:/${id}`, projectName: id, port: 1, pid: 1, status: "ready", client: getRootClient(id), proxyPath: `/workspaces/${id}/instance` })
  attachInstanceTabMembership(id)
}
add("first")
selectAppTab("instance:first")
function Panel(props: { tab: InstanceAppTab }) {
  const id = props.tab.instance.id
  mounts[id] = (mounts[id] ?? 0) + 1
  onCleanup(() => { disposals[id] = (disposals[id] ?? 0) + 1 })
  const [slug, setSlug] = createSignal("root")
  worktree[id] = setSlug
  const git = useGitChanges({ instanceId: id, t: key => key,
    isActive: () => activeAppTabId() === props.tab.id, rightPanelTab: () => "git-changes",
    worktreeSlug: slug, isPhoneLayout: () => false, promptInputApi: () => null, closeGitList() {},
  })
  panels[id] = git
  return <section data-project={id} data-loading={git.gitStatusLoading()}>
    <span data-name>{props.tab.instance.projectName}</span>
    <input aria-label={`Commit ${id}`} value={git.gitCommitMessage()} onInput={e => git.setGitCommitMessage(e.currentTarget.value)} />
    <pre data-diff>{git.gitSelectedAfter()}</pre>
    <span data-count>{git.gitStatusEntries()?.length ?? -1}</span>
  </section>
}
const controllers: AbortController[] = []
;(window as any).fixture = {
  mounts, disposals, panels, worktree, add, update: (id: string, projectName: string) => updateInstance(id, { projectName }),
  select: (id: string) => selectAppTab(`instance:${id}`), close: detachInstanceTabMembership,
  deactivate: () => selectAppTab(null),
  invalidate: invalidateFilesystemCaches,
  occupy: () => [0, 1].map(() => {
    const controller = new AbortController(); controllers.push(controller)
    return backgroundReads.run(controller.signal, () => new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true })))
  }),
  release: () => controllers.splice(0).forEach(controller => controller.abort()),
}
render(() => <For each={appTabs()}>{tab => tab.kind === "instance" ? <Panel tab={tab} /> : null}</For>, document.getElementById("root")!)
