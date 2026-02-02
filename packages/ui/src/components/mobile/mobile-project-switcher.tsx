import { Component, For, Show, createMemo } from "solid-js"
import { ArrowLeft, Check, FolderOpen } from "lucide-solid"
import { instances, activeInstanceId, setActiveInstanceId } from "../../stores/instances"
import { getParentSessions } from "../../stores/sessions"
import { sseManager } from "../../lib/sse-manager"
import { cn } from "../../lib/cn"

interface MobileProjectSwitcherProps {
  onBack: () => void
  onNewProject: () => void
}

const MobileProjectSwitcher: Component<MobileProjectSwitcherProps> = (props) => {
  const instanceList = createMemo(() => Array.from(instances().values()))
  const currentInstanceId = () => activeInstanceId()

  return (
    <div class="flex flex-col h-full" data-testid="mobile-project-switcher">
      {/* Header with back button */}
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <button
          type="button"
          class="inline-flex items-center justify-center w-10 h-10 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          onClick={props.onBack}
          aria-label="Back"
        >
          <ArrowLeft class="w-5 h-5" />
        </button>
        <h2 class="text-lg font-semibold text-foreground">Switch Project</h2>
      </div>

      {/* Project list */}
      <div class="flex-1 overflow-y-auto">
        <div class="px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Active Projects
        </div>

        <Show
          when={instanceList().length > 0}
          fallback={
            <div class="px-4 py-8 text-center text-muted-foreground text-sm">
              No active projects
            </div>
          }
        >
          <div class="border-t border-b border-border">
            <For each={instanceList()}>
              {(instance) => {
                const isCurrent = () => currentInstanceId() === instance.id
                const folderName = () => instance.folder.split("/").pop() || instance.folder
                const sessionCount = () => getParentSessions(instance.id).length
                const connStatus = () => sseManager.getStatus(instance.id)

                return (
                  <button
                    type="button"
                    class={cn(
                      "w-full flex items-start gap-3 px-4 py-3 min-h-[56px] text-left transition-colors border-b border-border/50",
                      isCurrent() ? "bg-accent/50" : "hover:bg-accent/30 active:bg-accent/50"
                    )}
                    onClick={() => {
                      setActiveInstanceId(instance.id)
                      props.onBack()
                    }}
                  >
                    <div class="pt-0.5">
                      <Show when={isCurrent()} fallback={<FolderOpen class="w-5 h-5 text-muted-foreground" />}>
                        <Check class="w-5 h-5 text-success" />
                      </Show>
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="text-sm font-medium text-foreground">{folderName()}</div>
                      <div class="text-xs text-muted-foreground truncate mt-0.5">{instance.folder}</div>
                      <div class="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                        <span>{sessionCount()} session{sessionCount() !== 1 ? "s" : ""}</span>
                        <span class="text-border">&middot;</span>
                        <span>:{instance.port ?? "—"}</span>
                        <span class="text-border">&middot;</span>
                        <span class={connStatus() === "connected" ? "text-success" : "text-warning"}>
                          {connStatus() === "connected" ? "Connected" : connStatus() ?? "Unknown"}
                        </span>
                      </div>
                    </div>
                  </button>
                )
              }}
            </For>
          </div>
        </Show>

        {/* New project button */}
        <div class="px-4 py-4">
          <button
            type="button"
            class="w-full min-h-[48px] px-4 py-3 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80 transition-colors"
            onClick={() => props.onNewProject()}
          >
            Open New Project
          </button>
        </div>
      </div>
    </div>
  )
}

export default MobileProjectSwitcher
