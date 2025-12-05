import { Component, Show, For, createSignal, createEffect, onCleanup } from "solid-js"
import type { Instance, RawMcpStatus } from "../types/instance"
import { fetchLspStatus, updateInstance } from "../stores/instances"
import { getLogger } from "../lib/logger"

const log = getLogger("session")

interface InstanceInfoProps {
  instance: Instance
  compact?: boolean
}

type ParsedMcpStatus = {
  name: string
  status: "running" | "stopped" | "error"
  error?: string
}

function parseMcpStatus(status: RawMcpStatus): ParsedMcpStatus[] {
  if (!status || typeof status !== "object") return []

  const result: ParsedMcpStatus[] = []

  for (const [name, value] of Object.entries(status)) {
    if (!value || typeof value !== "object") continue
    const rawStatus = (value as { status?: string }).status
    if (!rawStatus) continue

    let mappedStatus: ParsedMcpStatus["status"]
    if (rawStatus === "connected") {
      mappedStatus = "running"
    } else if (rawStatus === "failed") {
      mappedStatus = "error"
    } else {
      mappedStatus = "stopped"
    }

    result.push({
      name,
      status: mappedStatus,
      error: typeof (value as { error?: unknown }).error === "string" ? (value as { error?: string }).error : undefined,
    })
  }

  return result
}

const pendingMetadataRequests = new Set<string>()

const InstanceInfo: Component<InstanceInfoProps> = (props) => {
  const [isLoadingMetadata, setIsLoadingMetadata] = createSignal(true)

  const metadata = () => props.instance.metadata
  const binaryVersion = () => props.instance.binaryVersion || metadata()?.version
  const mcpServers = () => {
    const status = metadata()?.mcpStatus
    return status ? parseMcpStatus(status) : []
  }
  const lspServers = () => metadata()?.lspStatus ?? []

  createEffect(() => {
    const instance = props.instance
    const instanceId = instance.id
    const client = instance.client
    const hasMetadata = Boolean(instance.metadata)

    if (!client) {
      setIsLoadingMetadata(false)
      pendingMetadataRequests.delete(instanceId)
      return
    }

    if (hasMetadata) {
      setIsLoadingMetadata(false)
      pendingMetadataRequests.delete(instanceId)
      return
    }

    if (pendingMetadataRequests.has(instanceId)) {
      setIsLoadingMetadata(true)
      return
    }

    let cancelled = false
    pendingMetadataRequests.add(instanceId)
    setIsLoadingMetadata(true)

    void (async () => {
      try {
        const [projectResult, mcpResult, lspResult] = await Promise.allSettled([
          client.project.current(),
          client.mcp.status(),
          fetchLspStatus(instanceId),
        ])

        if (cancelled) {
          return
        }

        const project = projectResult.status === "fulfilled" ? projectResult.value.data : undefined
        const mcpStatus = mcpResult.status === "fulfilled" ? (mcpResult.value.data as RawMcpStatus) : undefined
        const lspStatus = lspResult.status === "fulfilled" ? lspResult.value ?? [] : undefined

        const nextMetadata = {
          ...(instance.metadata ?? {}),
          ...(project ? { project } : {}),
          ...(mcpStatus ? { mcpStatus } : {}),
          ...(lspStatus ? { lspStatus } : {}),
        }

        if (!nextMetadata.version && instance.binaryVersion) {
          nextMetadata.version = instance.binaryVersion
        }

        updateInstance(instanceId, { metadata: nextMetadata })

      } catch (error) {
        if (!cancelled) {
          log.error("Failed to load instance metadata", error)
        }
      } finally {
        pendingMetadataRequests.delete(instanceId)
        if (!cancelled) {
          setIsLoadingMetadata(false)
        }
      }
    })()

    onCleanup(() => {
      cancelled = true
    })
  })

  return (
    <div class="panel">
      <div class="panel-header">
        <h2 class="panel-title">Instance Information</h2>
      </div>
      <div class="panel-body space-y-3">
        <div>
          <div class="text-xs font-medium text-muted uppercase tracking-wide mb-1">Folder</div>
          <div class="text-xs text-primary font-mono break-all px-2 py-1.5 rounded border bg-surface-secondary border-base">
            {props.instance.folder}
          </div>
        </div>

        <Show when={!isLoadingMetadata() && metadata()?.project}>
          {(project) => (
            <>
              <div>
                <div class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
                  Project
                </div>
                <div class="text-xs font-mono px-2 py-1.5 rounded border truncate bg-surface-secondary border-base text-primary">
                  {project().id}
                </div>
              </div>

              <Show when={project().vcs}>
                <div>
                  <div class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
                    Version Control
                  </div>
                  <div class="flex items-center gap-2 text-xs text-primary">
                    <svg
                      class="w-3.5 h-3.5"
                      style="color: var(--status-warning);"
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
            <div class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
              OpenCode Version
            </div>
            <div class="text-xs px-2 py-1.5 rounded border bg-surface-secondary border-base text-primary">
              v{binaryVersion()}
            </div>
          </div>
        </Show>

        <Show when={props.instance.binaryPath}>
          <div>
            <div class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
              Binary Path
            </div>
            <div class="text-xs font-mono break-all px-2 py-1.5 rounded border bg-surface-secondary border-base text-primary">
              {props.instance.binaryPath}
            </div>
          </div>
        </Show>

        <Show when={props.instance.environmentVariables && Object.keys(props.instance.environmentVariables).length > 0}>
          <div>
            <div class="text-xs font-medium text-muted uppercase tracking-wide mb-1.5">
              Environment Variables ({Object.keys(props.instance.environmentVariables!).length})
            </div>
            <div class="space-y-1">
              <For each={Object.entries(props.instance.environmentVariables!)}>
                {([key, value]) => (
                  <div class="flex items-center gap-2 px-2 py-1.5 rounded border bg-surface-secondary border-base">
                    <span class="text-xs font-mono font-medium flex-1 text-primary" title={key}>
                      {key}
                    </span>
                    <span class="text-xs font-mono flex-1 text-secondary" title={value}>
                      {value}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={!isLoadingMetadata() && lspServers().length > 0}>
          <div>
            <div class="text-xs font-medium text-muted uppercase tracking-wide mb-1.5">
              LSP Servers
            </div>
            <div class="space-y-1.5">
              <For each={lspServers()}>
                {(server) => (
                  <div class="px-2 py-1.5 rounded border bg-surface-secondary border-base">
                    <div class="flex items-center justify-between gap-2">
                      <div class="flex flex-col flex-1 min-w-0">
                        <span class="text-xs text-primary font-medium truncate">{server.name ?? server.id}</span>
                        <span class="text-[11px] text-secondary truncate" title={server.root}>
                          {server.root}
                        </span>
                      </div>
                      <div class="flex items-center gap-1.5 flex-shrink-0 text-xs text-secondary">
                        <div class={`status-dot ${server.status === "connected" ? "ready animate-pulse" : "error"}`} />
                        <span>{server.status === "connected" ? "Connected" : "Error"}</span>
                      </div>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={!isLoadingMetadata() && mcpServers().length > 0}>
          <div>
            <div class="text-xs font-medium text-muted uppercase tracking-wide mb-1.5">
              MCP Servers
            </div>
            <div class="space-y-1.5">
              <For each={mcpServers()}>
                {(server) => (
                  <div class="px-2 py-1.5 rounded border bg-surface-secondary border-base">
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-xs text-primary font-medium truncate">{server.name}</span>
                      <div class="flex items-center gap-1.5 flex-shrink-0 text-xs text-secondary">
                        <div
                          class={`status-dot ${
                            server.status === "running"
                              ? "ready animate-pulse"
                              : server.status === "error"
                                ? "error"
                                : "stopped"
                          }`}
                        />
                        <span>
                          {
                            server.status === "running"
                              ? "Connected"
                              : server.status === "error"
                                ? "Error"
                                : "Disabled"
                          }
                        </span>
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
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={isLoadingMetadata()}>
          <div class="text-xs text-muted py-1">
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
          <div class="text-xs font-medium text-muted uppercase tracking-wide mb-1.5">Server</div>
          <div class="space-y-1 text-xs">
            <div class="flex justify-between items-center">
              <span class="text-secondary">Port:</span>
              <span class="text-primary font-mono">{props.instance.port}</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-secondary">PID:</span>
              <span class="text-primary font-mono">{props.instance.pid}</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-secondary">Status:</span>
              <span
                class={`status-badge ${props.instance.status}`}
              >
                <div
                  class={`status-dot ${props.instance.status === "ready" ? "ready" : props.instance.status === "starting" ? "starting" : props.instance.status === "error" ? "error" : "stopped"} ${props.instance.status === "ready" || props.instance.status === "starting" ? "animate-pulse" : ""}`}
                />
                {props.instance.status}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default InstanceInfo
