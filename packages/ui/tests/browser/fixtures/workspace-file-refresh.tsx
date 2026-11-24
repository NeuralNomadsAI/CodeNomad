import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { ConfigProvider } from "../../../src/stores/preferences"
import { WorkspaceTree } from "../../../src/components/instance/shell/right-panel/components/WorkspaceTree"
import { useWorkspaceTree } from "../../../src/components/instance/shell/right-panel/useWorkspaceTree"
import { filesystemInvalidationVersion } from "../../../src/lib/filesystem-events"
import "../../../src/index.css"

function Fixture() {
  const { t } = useI18n()
  const [active, activate] = createSignal(true)
  const directory = new URL(location.href).searchParams.get("directory") ?? "/fixture"
  const tree = useWorkspaceTree("fixture", () => directory, active)
  ;(window as any).workspaceRefreshFixture = { activate, version: () => filesystemInvalidationVersion("fixture"), busy: tree.busy }
  return <div style={{ width: "500px", height: "100vh", overflow: "auto" }}>
    <WorkspaceTree tree={tree} t={t} directory={directory} instanceId="fixture" worktreeSlug="root" canOpen={false} onOpen={() => {}} />
  </div>
}

render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
