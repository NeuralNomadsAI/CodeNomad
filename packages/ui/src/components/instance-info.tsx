import { Component, For, Show, createMemo } from "solid-js"
import type { Instance } from "../types/instance"
import { useOptionalInstanceMetadataContext } from "../lib/contexts/instance-metadata-context"
import InstanceServiceStatus from "./instance-service-status"
import { cn } from "../lib/cn"

interface InstanceInfoProps {
  instance: Instance
  compact?: boolean
}

const InstanceInfo: Component<InstanceInfoProps> = (props) => {
  const metadataContext = useOptionalInstanceMetadataContext()
  const isLoadingMetadata = metadataContext?.isLoading ?? (() => false)
  const instanceAccessor = metadataContext?.instance ?? (() => props.instance)
  const metadataAccessor = metadataContext?.metadata ?? (() => props.instance.metadata)

  const currentInstance = () => instanceAccessor()
  const metadata = () => metadataAccessor()
  const binaryVersion = () => currentInstance().binaryVersion || metadata()?.version
  const environmentVariables = () => currentInstance().environmentVariables

  // Determine if this is era-code based on label or path
  const isEraCode = () => {
    const label = currentInstance().binaryLabel?.toLowerCase() ?? ""
    const path = currentInstance().binaryPath?.toLowerCase() ?? ""
    return label.includes("era") || path.includes("era-code")
  }
  const environmentEntries = createMemo(() => {
    const env = environmentVariables()
    return env ? Object.entries(env) : []
  })

  return (
    <div class="rounded-lg shadow-sm border border-border overflow-hidden min-w-0 bg-card text-foreground">
      <div class="px-4 py-3 border-b border-border bg-secondary">
        <h2 class="text-base font-semibold text-foreground">Instance Information</h2>
      </div>
      <div class="p-4 space-y-3">
        <div>
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Folder</div>
          <div class="text-xs text-primary font-mono break-all px-2 py-1.5 rounded border bg-secondary border-border">
            {currentInstance().folder}
          </div>
        </div>

        <Show when={!isLoadingMetadata() && metadata()?.project}>
          {(project) => (
            <>
              <div>
                <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
                  Project
                </div>
                <div class="text-xs font-mono px-2 py-1.5 rounded border truncate bg-secondary border-border text-primary">
                  {project().id}
                </div>
              </div>

              <Show when={project().vcs}>
                <div>
                  <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
                    Version Control
                  </div>
                  <div class="flex items-center gap-2 text-xs text-primary">
                    <svg
                      class="w-3.5 h-3.5 text-warning"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                    </svg>
                    <span class="capitalize">{project().vcs}</span>
                  </div>
                </div>
              </Show>
            </>
          )}
        </Show>

        <Show when={binaryVersion()}>
          <div>
            <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
              {isEraCode() ? "Era-Code Version" : "OpenCode Version"}
            </div>
            <div class="text-xs px-2 py-1.5 rounded border bg-secondary border-border text-primary">
              v{binaryVersion()}
            </div>
          </div>
        </Show>

        <Show when={currentInstance().binaryPath}>
          <div>
            <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
              Binary Path
            </div>
            <div class="text-xs font-mono break-all px-2 py-1.5 rounded border bg-secondary border-border text-primary">
              {currentInstance().binaryPath}
            </div>
          </div>
        </Show>

        <Show when={environmentEntries().length > 0}>
          <div>
            <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
              Environment Variables ({environmentEntries().length})
            </div>
            <div class="space-y-1">
              <For each={environmentEntries()}>
                {([key, value]) => (
                  <div class="flex items-center gap-2 px-2 py-1.5 rounded border bg-secondary border-border">
                    <span class="text-xs font-mono font-medium flex-1 text-primary" title={key}>
                      {key}
                    </span>
                    <span class="text-xs font-mono flex-1 text-muted-foreground" title={value}>
                      {value}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <InstanceServiceStatus initialInstance={props.instance} class="space-y-3" />

        <Show when={isLoadingMetadata()}>
          <div class="text-xs text-muted-foreground py-1">
            <div class="flex items-center gap-1.5">
              <svg class="animate-spin h-3 w-3 icon-muted" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path
                  class="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              Loading...
            </div>
          </div>
        </Show>

        <div>
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">Server</div>
          <div class="space-y-1 text-xs">
            <div class="flex justify-between items-center">
              <span class="text-muted-foreground">Port:</span>
              <span class="text-primary font-mono">{currentInstance().port}</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-muted-foreground">PID:</span>
              <span class="text-primary font-mono">{currentInstance().pid}</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-muted-foreground">Status:</span>
              <span class={cn(
                "inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium",
                currentInstance().status === "ready" && "bg-success/20 text-success",
                currentInstance().status === "starting" && "bg-warning/20 text-warning",
                currentInstance().status === "error" && "bg-destructive/20 text-destructive",
                currentInstance().status === "stopped" && "bg-muted text-muted-foreground",
              )}>
                <div
                  class={cn(
                    "w-2 h-2 rounded-full",
                    currentInstance().status === "ready" && "bg-success",
                    currentInstance().status === "starting" && "bg-warning",
                    currentInstance().status === "error" && "bg-destructive",
                    currentInstance().status === "stopped" && "bg-muted-foreground",
                    (currentInstance().status === "ready" || currentInstance().status === "starting") && "animate-pulse",
                  )}
                />
                {currentInstance().status}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default InstanceInfo
