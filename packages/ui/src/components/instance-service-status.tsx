import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { Switch } from "./ui/switch"
import type { Instance, RawMcpStatus } from "../types/instance"
import { useOptionalInstanceMetadataContext } from "../lib/contexts/instance-metadata-context"
import { getLogger } from "../lib/logger"
import { cn } from "../lib/cn"

const log = getLogger("session")

type ServiceSection = "lsp" | "mcp"

interface InstanceServiceStatusProps {
  sections?: ServiceSection[]
  showSectionHeadings?: boolean
  class?: string
  initialInstance?: Instance
}

type ParsedMcpStatus = {
  name: string
  status: "running" | "stopped" | "error"
  error?: string
}

function parseMcpStatus(status?: RawMcpStatus): ParsedMcpStatus[] {
  if (!status || typeof status !== "object") return []
  const result: ParsedMcpStatus[] = []
  for (const [name, value] of Object.entries(status)) {
    if (!value || typeof value !== "object") continue
    const rawStatus = (value as { status?: string }).status
    if (!rawStatus) continue
    let mapped: ParsedMcpStatus["status"]
    if (rawStatus === "connected") mapped = "running"
    else if (rawStatus === "failed") mapped = "error"
    else mapped = "stopped"
    result.push({
      name,
      status: mapped,
      error: typeof (value as { error?: unknown }).error === "string" ? (value as { error?: string }).error : undefined,
    })
  }
  return result
}

const InstanceServiceStatus: Component<InstanceServiceStatusProps> = (props) => {
  const metadataContext = useOptionalInstanceMetadataContext()
  const instance = metadataContext?.instance ?? (() => {
    if (props.initialInstance) {
      return props.initialInstance
    }
    throw new Error("InstanceServiceStatus requires InstanceMetadataProvider or initialInstance prop")
  })
  const isLoading = metadataContext?.isLoading ?? (() => false)
  const refreshMetadata = metadataContext?.refreshMetadata ?? (async () => Promise.resolve())
  const sections = createMemo<ServiceSection[]>(() => props.sections ?? ["lsp", "mcp"])
  const includeLsp = createMemo(() => sections().includes("lsp"))
  const includeMcp = createMemo(() => sections().includes("mcp"))
  const showHeadings = () => props.showSectionHeadings !== false

  const metadataAccessor = metadataContext?.metadata ?? (() => instance().metadata)
  const metadata = createMemo(() => metadataAccessor())
  const hasLspMetadata = () => metadata()?.lspStatus !== undefined
  const hasMcpMetadata = () => metadata()?.mcpStatus !== undefined
  const lspServers = createMemo(() => metadata()?.lspStatus ?? [])
  const mcpServers = createMemo(() => parseMcpStatus(metadata()?.mcpStatus ?? undefined))

  const isLspLoading = () => isLoading() || !hasLspMetadata()
  const isMcpLoading = () => isLoading() || !hasMcpMetadata()


  const [pendingMcpActions, setPendingMcpActions] = createSignal<Record<string, "connect" | "disconnect">>({})

  const setPendingMcpAction = (name: string, action?: "connect" | "disconnect") => {
    setPendingMcpActions((prev) => {
      const next = { ...prev }
      if (action) next[name] = action
      else delete next[name]
      return next
    })
  }

  const toggleMcpServer = async (serverName: string, shouldEnable: boolean) => {
    const client = instance().client
    if (!client?.mcp) return
    const action: "connect" | "disconnect" = shouldEnable ? "connect" : "disconnect"
    setPendingMcpAction(serverName, action)
    try {
      if (shouldEnable) {
        await client.mcp.connect({ path: { name: serverName } })
      } else {
        await client.mcp.disconnect({ path: { name: serverName } })
      }
      await refreshMetadata()
    } catch (error) {
      log.error("Failed to toggle MCP server", { serverName, action, error })
    } finally {
      setPendingMcpAction(serverName)
    }
  }

  const renderEmptyState = (message: string) => (
    <p class="text-xs text-muted-foreground italic" role="status">
      {message}
    </p>
  )

  const renderLspSection = () => (
    <section class="space-y-1.5">
      <Show when={showHeadings()}>
        <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          LSP Servers
        </div>
      </Show>
      <Show
        when={!isLspLoading() && lspServers().length > 0}
        fallback={renderEmptyState(isLspLoading() ? "Loading LSP servers..." : "No LSP servers detected.")}
      >
        <div class="space-y-1.5">
          <For each={lspServers()}>
            {(server) => (
              <div class="px-2 py-1.5 rounded border bg-secondary border-border">
                <div class="flex items-center justify-between gap-2">
                  <div class="flex flex-col flex-1 min-w-0">
                    <span class="text-xs text-primary font-medium truncate">{server.name ?? server.id}</span>
                    <span class="text-xs text-muted-foreground truncate" title={server.root}>
                      {server.root}
                    </span>
                  </div>
                  <div class="flex items-center gap-1.5 flex-shrink-0 text-xs text-muted-foreground">
                    <div class={cn("w-2 h-2 rounded-full", server.status === "connected" ? "bg-success animate-pulse" : "bg-destructive")} />
                    <span>{server.status === "connected" ? "Connected" : "Error"}</span>
                  </div>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  )

  const renderMcpSection = () => (
    <section class="space-y-1.5">
      <Show when={showHeadings()}>
        <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          MCP Servers
        </div>
      </Show>
      <Show
        when={!isMcpLoading() && mcpServers().length > 0}
        fallback={renderEmptyState(isMcpLoading() ? "Loading MCP servers..." : "No MCP servers detected.")}
      >
        <div class="space-y-1.5">
          <For each={mcpServers()}>
            {(server) => {
              const pendingAction = () => pendingMcpActions()[server.name]
              const isPending = () => Boolean(pendingAction())
              const isRunning = () => server.status === "running"
              const switchDisabled = () => isPending() || !instance().client
              const statusDotClass = () => {
                const base = "w-2 h-2 rounded-full"
                if (isPending()) return cn(base, "bg-warning animate-pulse")
                if (server.status === "running") return cn(base, "bg-success animate-pulse")
                if (server.status === "error") return cn(base, "bg-destructive")
                return cn(base, "bg-muted-foreground")
              }
              const statusDotStyle = () => (isPending() ? { background: "hsl(var(--warning))" } : undefined)
              const statusLabel = () => {
                if (isPending()) return pendingAction() === "connect" ? "Connecting..." : "Disconnecting..."
                if (server.status === "running") return "Connected"
                if (server.status === "error") return "Error"
                return "Stopped"
              }
              return (
                <div class="px-2 py-1.5 rounded border bg-secondary border-border">
                  <div class="flex items-center justify-between gap-2">
                    <div class="flex flex-col min-w-0">
                      <span class="text-xs text-primary font-medium truncate">{server.name}</span>
                      <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Show when={isPending()}>
                          <svg class="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                            <path
                              class="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            />
                          </svg>
                        </Show>
                        <div class={statusDotClass()} style={statusDotStyle()} />
                        <span>{statusLabel()}</span>
                      </div>
                    </div>
                    <div class="flex items-center gap-1.5 flex-shrink-0">
                      <Switch
                        checked={isRunning()}
                        disabled={switchDisabled()}
                        onChange={(checked) => {
                          if (switchDisabled()) return
                          void toggleMcpServer(server.name, Boolean(checked))
                        }}
                      />
                    </div>
                  </div>
                  <Show when={server.error}>
                    {(error) => (
                      <div class="text-xs mt-1 break-words text-destructive">
                        {error()}
                      </div>
                    )}
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </section>
  )

  return (
    <div class={props.class}>
      <Show when={includeLsp()}>{renderLspSection()}</Show>
      <Show when={includeMcp()}>{renderMcpSection()}</Show>
    </div>
  )
}

export default InstanceServiceStatus
