import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import PermissionApprovalModal from "../../../src/components/permission-approval-modal"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance, addPermissionToQueue, removePermissionFromQueue } from "../../../src/stores/instances"
import type { PermissionRequest } from "../../../src/types/permission"
import "../../../src/index.css"

const instanceId = "permission-fallback"
const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+" + "first\n".repeat(1_700) + "middle\n".repeat(1_700) + "END-OF-DIFF\n"
let current: PermissionRequest = { id: "request", sessionID: "session", action: "edit", resources: ["a.ts"], metadata: { diff, path: "a.ts" } }
const replies: unknown[] = []
const client: any = { permission: { reply: async (reply: unknown) => { replies.push(reply) } } }
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
serverApi.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
serverApi.fetchStateOwner = async () => ({}) as any
addInstance({ id: instanceId, folder: "/repo", port: 0, pid: 0, proxyPath: `/workspaces/${instanceId}/instance`, status: "ready", client })
addPermissionToQueue(instanceId, current)
const [open, setOpen] = createSignal(true)
render(() => <ConfigProvider><I18nProvider>
  <PermissionApprovalModal instanceId={instanceId} isOpen={open()} onClose={() => setOpen(false)} />
</I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  diff,
  replies,
  refresh: () => addPermissionToQueue(instanceId, { ...current, metadata: { ...current.metadata, refreshed: true } }),
  changeDiff: () => { current = { ...current, metadata: { ...current.metadata, diff: diff + "CHANGED\n" } }; addPermissionToQueue(instanceId, current) },
  nextRequest: () => {
    removePermissionFromQueue(instanceId, current.id)
    current = { ...current, id: "next-request" }
    addPermissionToQueue(instanceId, current)
    setOpen(true)
  },
  reopen: () => setOpen(true),
}
