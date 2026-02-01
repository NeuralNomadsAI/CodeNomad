import { Component, Show, createSignal } from "solid-js"
import { RotateCcw, Square, Server, FileText } from "lucide-solid"
import type { Instance } from "../types/instance"
import InstanceInfo from "./instance-info"
import InstanceLogsPanel from "./instance-logs-panel"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui"
import { Button } from "./ui"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui"

type TabId = "settings" | "logs"

interface InstanceInfoModalProps {
  open: boolean
  onClose: () => void
  instance: Instance | null
  lspConnectedCount?: number
  onRestart?: () => void
  onStop?: () => void
}

const InstanceInfoModal: Component<InstanceInfoModalProps> = (props) => {
  const [activeTab, setActiveTab] = createSignal<TabId>("settings")

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent class="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Instance Details</DialogTitle>
        </DialogHeader>

        {/* Tab navigation */}
        <Tabs value={activeTab()} onChange={(value) => setActiveTab(value as TabId)}>
          <TabsList>
            <TabsTrigger value="settings" class="flex items-center gap-1.5">
              <Server size={14} />
              Instance Settings
            </TabsTrigger>
            <TabsTrigger value="logs" class="flex items-center gap-1.5">
              <FileText size={14} />
              Logs
            </TabsTrigger>
          </TabsList>

          <div class="mt-4 min-h-[200px]">
            <Show when={props.instance} fallback={<div class="text-muted-foreground text-sm">No instance selected</div>}>
              {(instance) => (
                <>
                  <TabsContent value="settings">
                    <div class="space-y-4">
                      <InstanceInfo instance={instance()} />

                      <Show when={props.lspConnectedCount !== undefined}>
                        <div class="text-xs text-muted-foreground">
                          LSP Connections: {props.lspConnectedCount}
                        </div>
                      </Show>
                    </div>
                  </TabsContent>
                  <TabsContent value="logs">
                    <InstanceLogsPanel instanceId={instance().id} />
                  </TabsContent>
                </>
              )}
            </Show>
          </div>
        </Tabs>

        <Show when={activeTab() === "settings"}>
          <DialogFooter>
            <Show when={props.onStop}>
              <Button
                variant="outline"
                size="sm"
                onClick={props.onStop}
              >
                <Square size={14} class="mr-1.5" />
                <span>Stop</span>
              </Button>
            </Show>
            <Show when={props.onRestart}>
              <Button
                size="sm"
                onClick={props.onRestart}
              >
                <RotateCcw size={14} class="mr-1.5" />
                <span>Restart</span>
              </Button>
            </Show>
          </DialogFooter>
        </Show>
      </DialogContent>
    </Dialog>
  )
}

export default InstanceInfoModal
