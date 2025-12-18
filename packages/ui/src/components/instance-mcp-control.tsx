import Switch from "@suid/material/Switch"
import { Dialog } from "@kobalte/core/dialog"
import { Plus } from "lucide-solid"
import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import type { Instance, RawMcpStatus } from "../types/instance"
import type { McpServerConfig } from "../stores/preferences"
import { instances } from "../stores/instances"
import { useConfig } from "../stores/preferences"
import { instanceApi } from "../lib/instance-api"
import { loadInstanceMetadata } from "../lib/hooks/use-instance-metadata"
import { getLogger } from "../lib/logger"

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

  const instance = createMemo(() => instances().get(props.instance.id) ?? props.instance)

  const statusMap = createMemo<RawMcpStatus>(() => instance().metadata?.mcpStatus ?? {})

  const rows = createMemo<McpRow[]>(() => {
    const registry = preferences().mcpRegistry ?? {}
    const desired = preferences().mcpDesiredState ?? {}

    const names = new Set<string>([...Object.keys(registry), ...Object.keys(statusMap())])

    return Array.from(names)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const registryEntry = registry[name]
        const desiredEnabled = desired[name] ?? (registryEntry?.enabled ?? true)
        return {
          name,
          desiredEnabled,
          runtime: statusMap()[name],
          hasRegistryEntry: Boolean(registryEntry),
        }
      })
  })

  const applyToInstance = async (name: string, desiredEnabled: boolean) => {
    const currentInstance = instance()
    const client = currentInstance.client
    if (!client) {
      return
    }

    setPending((prev) => ({ ...prev, [name]: true }))

    try {
      const registryEntry = preferences().mcpRegistry?.[name]
      if (registryEntry) {
        await instanceApi.upsertMcp(currentInstance, name, { ...registryEntry, enabled: desiredEnabled })
      }

      if (desiredEnabled) {
        await instanceApi.connectMcp(currentInstance, name)
      } else {
        await instanceApi.disconnectMcp(currentInstance, name)
      }

      await loadInstanceMetadata(currentInstance, { force: true })
    } catch (error) {
      log.error("Failed to apply MCP server toggle", { instanceId: currentInstance.id, name, desiredEnabled, error })
    } finally {
      setPending((prev) => ({ ...prev, [name]: false }))
    }
  }

  const toggleGlobalDesired = (name: string, enabled: boolean) => {
    updatePreferences({
      mcpDesiredState: {
        ...(preferences().mcpDesiredState ?? {}),
        [name]: enabled,
      },
    })

    void applyToInstance(name, enabled)
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
    }

    setNewName("")
    setNewUrl("")
    setAddModalOpen(false)
  }

  const renderStatusDotClass = (row: McpRow) => {
    if (pending()[row.name]) return "status-dot animate-pulse"

    const status = row.runtime?.status
    if (status === "connected") return "status-dot ready animate-pulse"
    if (status === "failed" || status === "needs_auth" || status === "needs_client_registration") return "status-dot error"
    if (status === "disabled") return "status-dot stopped"

    // Runtime status unknown/not reported.
    return row.desiredEnabled ? "status-dot" : "status-dot stopped"
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
        <div class="text-[11px] font-semibold uppercase tracking-wide text-secondary">Servers</div>
        <div class="flex items-center gap-2">
          <button type="button" class="control-panel-inline-button" onClick={() => setAddModalOpen(true)}>
            <Plus class="w-3.5 h-3.5" />
            Add
          </button>
          <Show when={props.onManage}>
            <button type="button" class="control-panel-inline-button" onClick={() => props.onManage?.()}>
              Settings
            </button>
          </Show>
        </div>
      </div>

      <Dialog open={addModalOpen()} onOpenChange={(open) => setAddModalOpen(open)}>
        <Dialog.Portal>
          <Dialog.Overlay class="modal-overlay" />
          <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
            <Dialog.Content class="modal-surface w-full max-w-xl">
              <header class="px-6 py-4 border-b" style={{ "border-color": "var(--border-base)" }}>
                <Dialog.Title class="text-lg font-semibold text-primary">Add MCP Server</Dialog.Title>
                <div class="text-[11px] text-secondary mt-1">Adds to the global registry and connects this instance.</div>
              </header>

              <div class="p-6 space-y-4">
                <div class="flex flex-col gap-1">
                  <label class="text-xs text-secondary">Name</label>
                  <input
                    class="selector-search-input"
                    value={newName()}
                    onInput={(event) => setNewName(event.currentTarget.value)}
                    placeholder="e.g. playwright-mcp"
                  />
                </div>

                <div class="flex flex-col gap-1">
                  <label class="text-xs text-secondary">Type</label>
                  <select
                    class="selector-search-input"
                    value={newType()}
                    onChange={(event) => setNewType(event.currentTarget.value as McpServerConfig["type"])}
                  >
                    <option value="local">local</option>
                    <option value="remote">remote</option>
                  </select>
                </div>

                <Show when={newType() === "local"}>
                  <div class="flex flex-col gap-1">
                    <label class="text-xs text-secondary">Command</label>
                    <input
                      class="selector-search-input"
                      value={newCommand()}
                      onInput={(event) => setNewCommand(event.currentTarget.value)}
                      placeholder="npx -y @modelcontextprotocol/server-playwright"
                    />
                    <div class="text-[11px] text-secondary">Tip: use full command + args.</div>
                  </div>
                </Show>

                <Show when={newType() === "remote"}>
                  <div class="flex flex-col gap-1">
                    <label class="text-xs text-secondary">URL</label>
                    <input
                      class="selector-search-input"
                      value={newUrl()}
                      onInput={(event) => setNewUrl(event.currentTarget.value)}
                      placeholder="https://mcp.example.com/mcp"
                    />
                  </div>
                </Show>
              </div>

              <div class="px-6 py-4 border-t flex items-center justify-end gap-2" style={{ "border-color": "var(--border-base)" }}>
                <button type="button" class="selector-button selector-button-secondary" onClick={() => setAddModalOpen(false)}>
                  Cancel
                </button>
                <button type="button" class="selector-button" onClick={() => void addMcpServer()}>
                  Add & Connect
                </button>
              </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog>

      <Show when={rows().length > 0} fallback={<p class="control-panel-empty">No MCP servers configured yet.</p>}>
        <div class="space-y-1.5">
          <For each={rows()}>
            {(row) => (
              <div class="px-2 py-2 rounded-lg border bg-surface-secondary border-base">
                <div class="flex items-center justify-between gap-2">
                  <div class="flex flex-col min-w-0">
                    <div class="text-xs text-primary font-medium truncate">
                      {row.name}
                      <Show when={!row.hasRegistryEntry}>
                        <span class="text-[11px] text-secondary"> (instance-only)</span>
                      </Show>
                    </div>
                    <div class="flex items-center gap-2 text-[11px] text-secondary">
                      <div class={renderStatusDotClass(row)} />
                      <span>{renderStatusLabel(row)}</span>
                    </div>
                  </div>

                  <Switch
                    checked={row.desiredEnabled}
                    disabled={!instance().client || Boolean(pending()[row.name])}
                    color="success"
                    size="small"
                    inputProps={{ "aria-label": `Toggle ${row.name} MCP server` }}
                    onChange={(_, checked) => toggleGlobalDesired(row.name, Boolean(checked))}
                  />
                </div>

                <Show when={row.runtime?.error}>
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
      </Show>

    </div>
  )
}

export default InstanceMcpControl
