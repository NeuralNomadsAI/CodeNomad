import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import Switch from "@suid/material/Switch"
import type { Instance, RawMcpStatus } from "../types/instance"
import { useOptionalInstanceMetadataContext } from "../lib/contexts/instance-metadata-context"
import { useI18n } from "../lib/i18n"
import { getLogger } from "../lib/logger"

const log = getLogger("session")

type ServiceSection = "mcp" | "plugins"

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
  if (!status) return []
  return status.data.map((server) => {
    const rawStatus = server.status.status
    let mapped: ParsedMcpStatus["status"]
    if (rawStatus === "connected") mapped = "running"
    else if (rawStatus === "failed") mapped = "error"
    else mapped = "stopped"
    return {
      name: server.name,
      status: mapped,
      error: server.status.status === "failed" ? server.status.error : undefined,
    }
  })
}

const InstanceServiceStatus: Component<InstanceServiceStatusProps> = (props) => {
  const { t } = useI18n()
  const metadataContext = useOptionalInstanceMetadataContext()
  const instance = metadataContext?.instance ?? (() => {
    if (props.initialInstance) {
      return props.initialInstance
    }
    throw new Error("InstanceServiceStatus requires InstanceMetadataProvider or initialInstance prop")
  })
  const isLoading = metadataContext?.isLoading ?? (() => false)
  const refreshMetadata = metadataContext?.refreshMetadata ?? (async () => Promise.resolve())
  const sections = createMemo<ServiceSection[]>(() => props.sections ?? ["mcp", "plugins"])
  const includeMcp = createMemo(() => sections().includes("mcp"))
  const includePlugins = createMemo(() => sections().includes("plugins"))
  const showHeadings = () => props.showSectionHeadings !== false

  const metadataAccessor = metadataContext?.metadata ?? (() => instance().metadata)
  const metadata = createMemo(() => metadataAccessor())
  const hasMcpMetadata = () => metadata()?.mcpStatus !== undefined
  const hasPluginsMetadata = () => metadata()?.plugins !== undefined

  const mcpServers = createMemo(() => parseMcpStatus(metadata()?.mcpStatus ?? undefined))
  const plugins = createMemo(() => metadata()?.plugins ?? [])

  const isMcpLoading = () => isLoading() || !hasMcpMetadata()
  const isPluginsLoading = () => isLoading() || !hasPluginsMetadata()


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
      const resolved = metadata()?.mcpStatus?.location
      const location = resolved
        ? { directory: resolved.directory, ...(resolved.workspaceID ? { workspace: resolved.workspaceID } : {}) }
        : { directory: instance().folder }
      if (shouldEnable) {
        await client.mcp.connect({ server: serverName, location })
      } else {
        await client.mcp.disconnect({ server: serverName, location })
      }
      await refreshMetadata()
    } catch (error) {
      log.error("Failed to toggle MCP server", { serverName, action, error })
    } finally {
      setPendingMcpAction(serverName)
    }
  }

  const renderEmptyState = (message: string) => (
    <p class="right-panel-empty-text" role="status">
      {message}
    </p>
  )

  const renderMcpSection = () => (
    <section class="space-y-1.5">
      <Show when={showHeadings()}>
        <div class="text-xs font-medium text-muted uppercase tracking-wide">
          {t("instanceServiceStatus.sections.mcp")}
        </div>
      </Show>
      <Show
        when={!isMcpLoading() && mcpServers().length > 0}
        fallback={renderEmptyState(isMcpLoading() ? t("instanceServiceStatus.mcp.loading") : t("instanceServiceStatus.mcp.empty"))}
      >
        <div class="space-y-1.5">
          <For each={mcpServers()}>
            {(server) => {
              const pendingAction = () => pendingMcpActions()[server.name]
              const isPending = () => Boolean(pendingAction())
              const isRunning = () => server.status === "running"
              const switchDisabled = () => isPending() || !instance().client
              const statusDotClass = () => {
                if (isPending()) return "status-dot animate-pulse"
                if (server.status === "running") return "status-dot ready animate-pulse"
                if (server.status === "error") return "status-dot error"
                return "status-dot stopped"
              }
              const statusDotStyle = () => (isPending() ? { background: "var(--status-warning)" } : undefined)
              return (
                <div class="px-2 py-1.5 rounded border bg-surface-secondary border-base">
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-xs text-primary font-medium truncate">{server.name}</span>
                      <div class="flex items-center gap-3 flex-shrink-0">
                        <div class="flex items-center gap-1.5 text-xs text-secondary">
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
                        </div>
                        <div class="flex items-center gap-1.5">
                          <Switch
                            checked={isRunning()}
                            disabled={switchDisabled()}
                            color="success"
                            size="small"
                            inputProps={{ "aria-label": t("instanceServiceStatus.mcp.toggleAriaLabel", { name: server.name }) }}
                            onChange={(_, checked) => {
                              if (switchDisabled()) return
                              void toggleMcpServer(server.name, Boolean(checked))
                            }}
                          />
                        </div>
                      </div>

                  </div>
                  <Show when={server.error}>
                    {(error) => (
                      <div class="text-[11px] mt-1 break-words" style={{ color: "var(--status-error)" }}>
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

  const renderPluginsSection = () => (
    <section class="space-y-1.5">
      <Show when={showHeadings()}>
        <div class="text-xs font-medium text-muted uppercase tracking-wide">
          {t("instanceServiceStatus.sections.plugins")}
        </div>
      </Show>
      <Show
        when={!isPluginsLoading() && plugins().length > 0}
        fallback={renderEmptyState(isPluginsLoading() ? t("instanceServiceStatus.plugins.loading") : t("instanceServiceStatus.plugins.empty"))}
      >
        <div class="space-y-1.5">
          <For each={plugins()}>
            {(plugin) => (
              <div class="px-2 py-1.5 rounded border bg-surface-secondary border-base">
                <div class="text-xs text-primary font-medium break-words whitespace-normal">{plugin}</div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  )

  return (
    <div class={props.class}>
      <Show when={includeMcp()}>{renderMcpSection()}</Show>
      <Show when={includePlugins()}>{renderPluginsSection()}</Show>
    </div>
  )
}

export default InstanceServiceStatus
