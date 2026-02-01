import { Switch } from "./ui/switch"
import { Dialog } from "@kobalte/core/dialog"
import { Plus } from "lucide-solid"
import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { cn } from "../lib/cn"
import type { Instance, RawMcpStatus } from "../types/instance"
import type { McpServerConfig } from "../stores/preferences"
import { instances } from "../stores/instances"
import { useConfig } from "../stores/preferences"
import { instanceApi, type InstanceApiError } from "../lib/instance-api"
import { loadInstanceMetadata } from "../lib/hooks/use-instance-metadata"
import { getLogger } from "../lib/logger"
import { useOptionalInstanceMetadataContext } from "../lib/contexts/instance-metadata-context"
import { getInstanceMetadata } from "../stores/instance-metadata"
import { showToastNotification } from "../lib/notifications"
import { getBuiltInMcpConfig } from "../stores/era-mcp"

const log = getLogger("session")

type McpRow = {
  name: string
  desiredEnabled: boolean
  runtime?: { status?: string; error?: string }
  hasRegistryEntry: boolean
}

interface InstanceMcpControlProps {
  instance: Instance
  onManage?: () => void
  class?: string
}

const InstanceMcpControl: Component<InstanceMcpControlProps> = (props) => {
  const { preferences, updatePreferences } = useConfig()
  const [pending, setPending] = createSignal<Record<string, boolean>>({})

  const [addModalOpen, setAddModalOpen] = createSignal(false)
  const [newName, setNewName] = createSignal("")
  const [newType, setNewType] = createSignal<McpServerConfig["type"]>("local")
  const [newCommand, setNewCommand] = createSignal("npx -y @modelcontextprotocol/server-playwright")
  const [newUrl, setNewUrl] = createSignal("")

  // Use metadata context if available, otherwise fall back to global store or instance
  const metadataContext = useOptionalInstanceMetadataContext()
  const instance = createMemo(() => instances().get(props.instance.id) ?? props.instance)
  
  // Get metadata from context, global store, or instance (in that priority order)
  const metadata = createMemo(() => {
    if (metadataContext) {
      return metadataContext.metadata()
    }
    return getInstanceMetadata(instance().id) ?? instance().metadata
  })

  const statusMap = createMemo<RawMcpStatus>(() => metadata()?.mcpStatus ?? {})

  const rows = createMemo<McpRow[]>(() => {
    const registry = preferences().mcpRegistry ?? {}
    const desired = preferences().mcpDesiredState ?? {}
    const status = statusMap()

    const names = new Set<string>([...Object.keys(registry), ...Object.keys(status)])

    return Array.from(names)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const registryEntry = registry[name]
        const runtimeStatus = status[name]?.status
        const isConnected = runtimeStatus === "connected"
        // Use user's desired state when set (enables optimistic toggle);
        // fall back to runtime status so fresh loads reflect reality.
        const desiredEnabled = name in desired ? desired[name] : isConnected
        return {
          name,
          desiredEnabled,
          runtime: status[name],
          hasRegistryEntry: Boolean(registryEntry),
        }
      })
  })

  const applyToInstance = async (name: string, desiredEnabled: boolean): Promise<{ success: boolean; error?: string }> => {
    const currentInstance = instance()
    const client = currentInstance.client
    if (!client) {
      return { success: false, error: "No client connection" }
    }

    setPending((prev) => ({ ...prev, [name]: true }))

    try {
      // Resolve config: user registry entry first, then built-in defaults
      const registryEntry = preferences().mcpRegistry?.[name] ?? getBuiltInMcpConfig(name)
      if (registryEntry) {
        await instanceApi.upsertMcp(currentInstance, name, { ...registryEntry, enabled: desiredEnabled })
      }

      if (desiredEnabled) {
        await instanceApi.connectMcp(currentInstance, name)
      } else {
        await instanceApi.disconnectMcp(currentInstance, name)
      }

      await loadInstanceMetadata(currentInstance, { force: true })
      return { success: true }
    } catch (error) {
      log.error("Failed to apply MCP server toggle", { instanceId: currentInstance.id, name, desiredEnabled, error })
      const apiError = error as InstanceApiError
      const errorMessage = apiError?.message ?? String(error)
      const hint = apiError?.hint
      return { success: false, error: errorMessage, hint }
    } finally {
      setPending((prev) => ({ ...prev, [name]: false }))
    }
  }

  const toggleGlobalDesired = async (name: string, enabled: boolean) => {
    const previousState = preferences().mcpDesiredState?.[name]
    
    // Optimistically update the UI
    updatePreferences({
      mcpDesiredState: {
        ...(preferences().mcpDesiredState ?? {}),
        [name]: enabled,
      },
    })

    const result = await applyToInstance(name, enabled)

    if (result.success) {
      // Sync desired state with actual runtime after metadata refresh
      const runtimeStatus = statusMap()[name]?.status
      const actuallyConnected = runtimeStatus === "connected"
      if (actuallyConnected !== enabled) {
        // Runtime disagrees with intent — update desired to match reality
        updatePreferences({
          mcpDesiredState: {
            ...(preferences().mcpDesiredState ?? {}),
            [name]: actuallyConnected,
          },
        })
      }
    } else {
      // Revert to previous state on failure
      updatePreferences({
        mcpDesiredState: {
          ...(preferences().mcpDesiredState ?? {}),
          [name]: previousState ?? !enabled,
        },
      })

      // Show error toast with hint if available
      const errorMessage = result.error ?? `Failed to ${enabled ? "connect" : "disconnect"}`
      const displayMessage = result.hint ? `${errorMessage} — ${result.hint}` : errorMessage
      showToastNotification({
        title: `MCP Server: ${name}`,
        message: displayMessage,
        variant: "error",
        duration: 10000, // Longer duration for errors with hints
      })
    }
  }

  const addMcpServer = async () => {
    const name = newName().trim()
    if (!name) return

    let config: McpServerConfig
    if (newType() === "local") {
      const command = newCommand()
        .split(" ")
        .map((segment) => segment.trim())
        .filter(Boolean)
      if (command.length === 0) return
      config = { type: "local", command, enabled: true }
    } else {
      const url = newUrl().trim()
      if (!url) return
      config = { type: "remote", url, enabled: true }
    }

    // Persist to global registry so it shows up everywhere.
    updatePreferences({
      mcpRegistry: { ...(preferences().mcpRegistry ?? {}), [name]: config },
      mcpDesiredState: { ...(preferences().mcpDesiredState ?? {}), [name]: true },
    })

    try {
      const currentInstance = instance()
      if (currentInstance.client) {
        await instanceApi.upsertMcp(currentInstance, name, { ...config, enabled: true })
        await instanceApi.connectMcp(currentInstance, name)
        await loadInstanceMetadata(currentInstance, { force: true })
      }
    } catch (error) {
      log.error("Failed to add MCP server", { instanceId: instance().id, name, error })
      const apiError = error as InstanceApiError
      const msg = apiError?.message ?? String(error)
      const hint = apiError?.hint
      showToastNotification({
        title: `MCP Server: ${name}`,
        message: hint ? `${msg} — ${hint}` : msg,
        variant: "error",
        duration: 10000,
      })
    }

    setNewName("")
    setNewUrl("")
    setAddModalOpen(false)
  }

  const renderStatusDotClass = (row: McpRow) => {
    const base = "w-2 h-2 rounded-full"
    if (pending()[row.name]) return cn(base, "bg-warning animate-pulse")

    const status = row.runtime?.status
    if (status === "connected") return cn(base, "bg-success animate-pulse")
    if (status === "failed" || status === "needs_auth" || status === "needs_client_registration") return cn(base, "bg-destructive")
    if (status === "disabled") return cn(base, "bg-muted-foreground")

    // Runtime status unknown/not reported.
    return row.desiredEnabled ? cn(base, "bg-muted-foreground") : cn(base, "bg-muted-foreground")
  }

  const renderStatusLabel = (row: McpRow) => {
    const status = row.runtime?.status
    if (pending()[row.name]) return "Applying..."
    if (!status) return row.desiredEnabled ? "Enabled (status unknown)" : "Disabled"
    if (status === "connected") return "Connected"
    if (status === "disabled") return "Disabled"
    if (status === "failed") return "Failed"
    if (status === "needs_auth") return "Needs auth"
    if (status === "needs_client_registration") return "Needs registration"
    return status
  }

  return (
    <div class={props.class}>
      <div class="flex items-center justify-between gap-2 mb-2">
        <div class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Servers</div>
        <div class="flex items-center gap-2">
          <button type="button" class="inline-flex items-center gap-2 px-2 py-1 rounded-md text-xs font-medium transition-colors bg-secondary border border-border text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setAddModalOpen(true)}>
            <Plus class="w-3.5 h-3.5" />
            Add
          </button>
          <Show when={props.onManage}>
            <button type="button" class="inline-flex items-center gap-2 px-2 py-1 rounded-md text-xs font-medium transition-colors bg-secondary border border-border text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => props.onManage?.()}>
              Settings
            </button>
          </Show>
        </div>
      </div>

      <Dialog open={addModalOpen()} onOpenChange={(open) => setAddModalOpen(open)}>
        <Dialog.Portal>
          <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50" />
          <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
            <Dialog.Content class="rounded-lg shadow-2xl flex flex-col bg-background text-foreground w-full max-w-xl">
              <header class="px-6 py-4 border-b border-border">
                <Dialog.Title class="text-lg font-semibold text-primary">Add MCP Server</Dialog.Title>
                <div class="text-xs text-muted-foreground mt-1">Adds to the global registry and connects this instance.</div>
              </header>

              <div class="p-6 space-y-4">
                <div class="flex flex-col gap-1">
                  <label class="text-xs text-muted-foreground">Name</label>
                  <input
                    class="w-full px-3 py-2 text-sm bg-transparent border-b border-border outline-none placeholder:text-muted-foreground"
                    value={newName()}
                    onInput={(event) => setNewName(event.currentTarget.value)}
                    placeholder="e.g. playwright-mcp"
                  />
                </div>

                <div class="flex flex-col gap-1">
                  <label class="text-xs text-muted-foreground">Type</label>
                  <select
                    class="w-full px-3 py-2 text-sm bg-transparent border-b border-border outline-none placeholder:text-muted-foreground"
                    value={newType()}
                    onChange={(event) => setNewType(event.currentTarget.value as McpServerConfig["type"])}
                  >
                    <option value="local">local</option>
                    <option value="remote">remote</option>
                  </select>
                </div>

                <Show when={newType() === "local"}>
                  <div class="flex flex-col gap-1">
                    <label class="text-xs text-muted-foreground">Command</label>
                    <input
                      class="w-full px-3 py-2 text-sm bg-transparent border-b border-border outline-none placeholder:text-muted-foreground"
                      value={newCommand()}
                      onInput={(event) => setNewCommand(event.currentTarget.value)}
                      placeholder="npx -y @modelcontextprotocol/server-playwright"
                    />
                    <div class="text-xs text-muted-foreground">Tip: use full command + args.</div>
                  </div>
                </Show>

                <Show when={newType() === "remote"}>
                  <div class="flex flex-col gap-1">
                    <label class="text-xs text-muted-foreground">URL</label>
                    <input
                      class="w-full px-3 py-2 text-sm bg-transparent border-b border-border outline-none placeholder:text-muted-foreground"
                      value={newUrl()}
                      onInput={(event) => setNewUrl(event.currentTarget.value)}
                      placeholder="https://mcp.example.com/mcp"
                    />
                  </div>
                </Show>
              </div>

              <div class="px-6 py-4 border-t border-border flex items-center justify-end gap-2">
                <button type="button" class="inline-flex items-center justify-center gap-2 font-medium px-4 py-2 rounded-md transition-colors border border-border bg-background text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed" onClick={() => setAddModalOpen(false)}>
                  Cancel
                </button>
                <button type="button" class="inline-flex items-center justify-center gap-2 font-medium px-4 py-2 rounded-md transition-colors bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed" onClick={() => void addMcpServer()}>
                  Add & Connect
                </button>
              </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog>

      <Show when={rows().length > 0} fallback={<p class="text-xs py-2 text-muted-foreground">No MCP servers configured yet.</p>}>
        <div class="space-y-1.5">
          <For each={rows()}>
            {(row) => (
              <div class="px-2 py-2 rounded-lg border bg-secondary border-border">
                <div class="flex items-center justify-between gap-2">
                  <div class="flex flex-col min-w-0">
                    <div class="text-xs text-primary font-medium truncate">
                      {row.name}
                      <Show when={!row.hasRegistryEntry}>
                        <span class="text-xs text-muted-foreground"> (project)</span>
                      </Show>
                    </div>
                    <div class="flex items-center gap-2 text-xs text-muted-foreground">
                      <div class={renderStatusDotClass(row)} />
                      <span>{renderStatusLabel(row)}</span>
                    </div>
                  </div>

                  <Switch
                    checked={row.desiredEnabled}
                    disabled={!instance().client || Boolean(pending()[row.name])}
                    onChange={(checked) => toggleGlobalDesired(row.name, Boolean(checked))}
                  />
                </div>

                <Show when={row.runtime?.error}>
                  {(error) => (
                    <div class="text-xs mt-1 break-words text-destructive">
                      {error()}
                    </div>
                  )}
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

    </div>
  )
}

export default InstanceMcpControl
