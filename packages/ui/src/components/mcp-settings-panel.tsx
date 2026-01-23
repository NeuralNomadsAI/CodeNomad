import { For, Show, createMemo, createSignal, createEffect, type Component } from "solid-js"
import { useConfig } from "../stores/preferences"
import type { McpServerConfig } from "../stores/preferences"
import { instances } from "../stores/instances"
import { getLogger } from "../lib/logger"
import { instanceApi } from "../lib/instance-api"
import { loadInstanceMetadata } from "../lib/hooks/use-instance-metadata"
import {
  ERA_CODE_MCP_DEFAULTS,
  isBuiltInMcp,
  getBuiltInMcpConfig,
  getBuiltInMcpOptionValue,
  updateBuiltInMcpOption,
  type EraCodeMcpServer,
} from "../stores/era-mcp"
import {
  fetchProjectMcpConfig,
  getMergedMcpServers,
  setProjectMcpServer,
  removeProjectMcpServer,
  setProjectMcpOverride,
  type MergedMcpEntry,
} from "../stores/project-mcp"
import { Settings, Globe, FolderCog, Plus } from "lucide-solid"
import AddToGlobalModal from "./add-to-global-modal"

const log = getLogger("actions")

type McpScope = "global" | "project"

interface McpSettingsPanelProps {
  folder?: string
  instanceId?: string
  onAddServer?: () => void  // Opens external Add Server modal
}

const McpSettingsPanel: Component<McpSettingsPanelProps> = (props) => {
  const { preferences, updatePreferences } = useConfig()
  const [newName, setNewName] = createSignal("")
  const [newType, setNewType] = createSignal<McpServerConfig["type"]>("local")
  const [newCommand, setNewCommand] = createSignal("npx -y @modelcontextprotocol/server-everything")
  const [newUrl, setNewUrl] = createSignal("")
  const [scope, setScope] = createSignal<McpScope>("global")
  const [configuringServer, setConfiguringServer] = createSignal<string | null>(null)

  // Add to Global modal state
  const [addToGlobalOpen, setAddToGlobalOpen] = createSignal(false)
  const [pendingServer, setPendingServer] = createSignal<{ name: string; config: McpServerConfig } | null>(null)


  // Fetch project MCP config when folder changes
  createEffect(() => {
    const folder = props.folder
    if (folder) {
      void fetchProjectMcpConfig(folder)
    }
  })

  // Use merged servers when in project scope with a folder
  const entries = createMemo<MergedMcpEntry[]>(() => {
    const currentScope = scope()
    const folder = props.folder

    if (currentScope === "project" && folder) {
      return getMergedMcpServers(folder)
    }

    // Global scope: show era-code + global servers
    const registry = preferences().mcpRegistry ?? {}
    const desiredState = preferences().mcpDesiredState ?? {}

    // Start with built-in servers
    const builtInEntries: MergedMcpEntry[] = ERA_CODE_MCP_DEFAULTS.map((server) => {
      const override = registry[server.name]
      const config = override ?? getBuiltInMcpConfig(server.name) ?? server.config
      const desiredEnabled = desiredState[server.name] ?? (config.enabled ?? true)
      return {
        name: server.name,
        config,
        desiredEnabled,
        effectiveEnabled: desiredEnabled,
        source: "era-code" as const,
        builtIn: true,
        builtInServer: server,
        hasProjectOverride: false,
      }
    })

    // Add user-defined servers (excluding built-in overrides)
    const userEntries: MergedMcpEntry[] = Object.entries(registry)
      .filter(([name]) => !isBuiltInMcp(name))
      .map(([name, config]) => {
        const desiredEnabled = desiredState[name] ?? (config.enabled ?? true)
        return {
          name,
          config,
          desiredEnabled,
          effectiveEnabled: desiredEnabled,
          source: "global" as const,
          builtIn: false,
          hasProjectOverride: false,
        }
      })

    // Sort: built-ins first, then user-defined alphabetically
    return [
      ...builtInEntries.sort((a, b) => a.name.localeCompare(b.name)),
      ...userEntries.sort((a, b) => a.name.localeCompare(b.name)),
    ]
  })

  const saveEntry = (name: string, config: McpServerConfig, desiredEnabled: boolean) => {
    updatePreferences({
      mcpRegistry: { ...(preferences().mcpRegistry ?? {}), [name]: config },
      mcpDesiredState: { ...(preferences().mcpDesiredState ?? {}), [name]: desiredEnabled },
    })
  }

  const removeEntry = (name: string) => {
    const nextRegistry = { ...(preferences().mcpRegistry ?? {}) }
    const nextDesired = { ...(preferences().mcpDesiredState ?? {}) }
    delete nextRegistry[name]
    delete nextDesired[name]
    updatePreferences({ mcpRegistry: nextRegistry, mcpDesiredState: nextDesired })

    const activeInstances = Array.from(instances().values()).filter((instance) => instance.status === "ready" && instance.client)
    void Promise.all(
      activeInstances.map(async (instance) => {
        try {
          await instanceApi.disconnectMcp(instance, name)
          await loadInstanceMetadata(instance, { force: true })
        } catch {
          // ignore
        }
      }),
    )
  }

  const applyAll = async () => {
    const currentEntries = entries()
    const activeInstances = Array.from(instances().values()).filter((instance) => instance.status === "ready" && instance.client)

    await Promise.all(
      activeInstances.map(async (instance) => {
        for (const entry of currentEntries) {
          try {
            await instanceApi.upsertMcp(instance, entry.name, { ...entry.config, enabled: entry.desiredEnabled })
            if (entry.desiredEnabled) {
              await instanceApi.connectMcp(instance, entry.name)
            } else {
              await instanceApi.disconnectMcp(instance, entry.name)
            }
          } catch (error) {
            log.error("Failed to apply MCP registry entry", { instanceId: instance.id, name: entry.name, error })
          }
        }

        try {
          await loadInstanceMetadata(instance, { force: true })
        } catch (error) {
          log.error("Failed to refresh instance MCP metadata", { instanceId: instance.id, error })
        }
      }),
    )
  }

  const createNewServer = () => {
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

    // If in project scope, show the "Add to Global?" modal
    if (scope() === "project" && props.folder) {
      setPendingServer({ name, config })
      setAddToGlobalOpen(true)
      return
    }

    // Global scope: save directly
    saveEntry(name, config, true)
    setNewName("")
    setNewUrl("")

    void applyAll()
  }

  const handleAddToGlobal = async () => {
    const server = pendingServer()
    if (!server) return

    // Save to global
    saveEntry(server.name, server.config, true)
    setNewName("")
    setNewUrl("")
    setPendingServer(null)

    void applyAll()
  }

  const handleKeepProjectOnly = async () => {
    const server = pendingServer()
    const folder = props.folder
    if (!server || !folder) return

    // Save to project only
    await setProjectMcpServer(folder, server.name, server.config)
    await fetchProjectMcpConfig(folder)
    setNewName("")
    setNewUrl("")
    setPendingServer(null)

    void applyAll()
  }

  return (
    <div class="panel">
      <div class="panel-header">
        <h3 class="panel-title">MCP Servers</h3>
        <p class="panel-subtitle">Registry stored in Era Code and applied to all instances</p>
      </div>

      <div class="panel-body" style={{ gap: "var(--space-md)" }}>
        {/* Scope selector */}
        <Show when={props.folder}>
          <div class="mcp-scope-selector">
            <button
              type="button"
              class={`mcp-scope-btn ${scope() === "global" ? "active" : ""}`}
              onClick={() => setScope("global")}
            >
              <Globe class="w-4 h-4" />
              <span>Global</span>
            </button>
            <button
              type="button"
              class={`mcp-scope-btn ${scope() === "project" ? "active" : ""}`}
              onClick={() => setScope("project")}
            >
              <FolderCog class="w-4 h-4" />
              <span>Project</span>
            </button>
          </div>
        </Show>

        <label class="text-xs text-secondary flex items-center" style={{ gap: "var(--space-sm)" }}>
          <input
            type="checkbox"
            checked={preferences().mcpAutoApply}
            onChange={(event) => updatePreferences({ mcpAutoApply: event.currentTarget.checked })}
          />
          Auto-apply MCP registry on instance start
        </label>

        <div class="flex items-end flex-wrap" style={{ gap: "var(--space-sm)" }}>
          <div class="flex flex-col" style={{ gap: "var(--space-xs)" }}>
            <label class="text-xs text-secondary">Name</label>
            <input
              class="modal-input min-w-[180px]"
              value={newName()}
              onInput={(event) => setNewName(event.currentTarget.value)}
              placeholder="e.g. context7"
            />
          </div>

          <div class="flex flex-col" style={{ gap: "var(--space-xs)" }}>
            <label class="text-xs text-secondary">Type</label>
            <select
              class="modal-input min-w-[120px]"
              value={newType()}
              onChange={(event) => setNewType(event.currentTarget.value as McpServerConfig["type"])}
            >
              <option value="local">local</option>
              <option value="remote">remote</option>
            </select>
          </div>

          <Show when={newType() === "local"}>
            <div class="flex flex-col flex-1 min-w-[280px]" style={{ gap: "var(--space-xs)" }}>
              <label class="text-xs text-secondary">Command</label>
              <input
                class="modal-input"
                value={newCommand()}
                onInput={(event) => setNewCommand(event.currentTarget.value)}
                placeholder='npx -y @modelcontextprotocol/server-everything'
              />
            </div>
          </Show>

          <Show when={newType() === "remote"}>
            <div class="flex flex-col flex-1 min-w-[280px]" style={{ gap: "var(--space-xs)" }}>
              <label class="text-xs text-secondary">URL</label>
              <input
                class="modal-input"
                value={newUrl()}
                onInput={(event) => setNewUrl(event.currentTarget.value)}
                placeholder="https://mcp.example.com/mcp"
              />
            </div>
          </Show>

          <button type="button" class="modal-button modal-button--primary" onClick={createNewServer}>
            Add
          </button>

          <button type="button" class="modal-button modal-button--secondary" onClick={() => void applyAll()}>
            Apply to Running Instances
          </button>

          <button
            type="button"
            class="modal-button modal-button--primary"
            onClick={() => props.onAddServer?.()}
            title="Add a new MCP server with scope selection"
          >
            <Plus class="w-4 h-4" />
            Add Server
          </button>
        </div>

        <div class="flex flex-col" style={{ gap: "var(--space-sm)" }}>
          <For each={entries()}>
            {(entry) => (
              <div class={`px-3 py-2 rounded-md border bg-surface-secondary border-base ${entry.builtIn ? "mcp-builtin-server" : ""}`}>
                <div class="flex items-center justify-between" style={{ gap: "var(--space-sm)" }}>
                  <div class="flex flex-col min-w-0 flex-1">
                    <div class="flex items-center" style={{ gap: "var(--space-sm)" }}>
                      <span class="text-sm text-primary font-medium truncate">{entry.name}</span>
                      <Show when={entry.source === "era-code"}>
                        <span class="mcp-badge mcp-badge-builtin">Era Code</span>
                      </Show>
                      <Show when={entry.source === "global" && scope() === "project"}>
                        <span class="mcp-badge mcp-badge-global">Global</span>
                      </Show>
                      <Show when={entry.source === "project"}>
                        <span class="mcp-badge mcp-badge-project">Project</span>
                      </Show>
                      <Show when={entry.hasProjectOverride}>
                        <span class="mcp-badge mcp-badge-override">Override</span>
                      </Show>
                    </div>
                    <div class="text-xs text-secondary truncate">
                      {entry.builtInServer?.description ?? (entry.config.type === "local" ? entry.config.command.join(" ") : entry.config.url)}
                    </div>
                  </div>
                  <div class="flex items-center" style={{ gap: "var(--space-sm)" }}>
                    <Show when={entry.builtIn && entry.builtInServer?.configurable}>
                      <button
                        type="button"
                        class="modal-button modal-button--secondary"
                        onClick={() => setConfiguringServer(configuringServer() === entry.name ? null : entry.name)}
                        title="Configure"
                      >
                        <Settings class="w-4 h-4" />
                      </button>
                    </Show>
                    <label class="text-xs text-secondary flex items-center" style={{ gap: "var(--space-xs)" }}>
                      <input
                        type="checkbox"
                        checked={entry.desiredEnabled}
                        onChange={(event) => {
                          saveEntry(entry.name, entry.config, event.currentTarget.checked)
                          void applyAll()
                        }}
                      />
                      Enabled
                    </label>
                    <Show when={!entry.builtIn}>
                      <button
                        type="button"
                        class="modal-button modal-button--danger"
                        onClick={() => removeEntry(entry.name)}
                      >
                        Remove
                      </button>
                    </Show>
                  </div>
                </div>

                {/* Configurable options panel */}
                <Show when={entry.builtIn && entry.builtInServer?.configurable && configuringServer() === entry.name}>
                  <div class="mcp-config-panel">
                    <For each={Object.entries(entry.builtInServer!.configurable!)}>
                      {([key, option]) => (
                        <div class="mcp-config-option">
                          <label class="text-xs text-secondary">{option.label}</label>
                          <Show when={option.type === "number"}>
                            <input
                              type="number"
                              class="modal-input mcp-config-input"
                              value={getBuiltInMcpOptionValue(entry.name, key) as number}
                              onInput={(e) => {
                                updateBuiltInMcpOption(entry.name, key, Number(e.currentTarget.value))
                              }}
                            />
                          </Show>
                          <Show when={option.type === "string"}>
                            <input
                              type="text"
                              class="modal-input mcp-config-input"
                              value={getBuiltInMcpOptionValue(entry.name, key) as string}
                              onInput={(e) => {
                                updateBuiltInMcpOption(entry.name, key, e.currentTarget.value)
                              }}
                            />
                          </Show>
                          <Show when={option.type === "boolean"}>
                            <input
                              type="checkbox"
                              checked={getBuiltInMcpOptionValue(entry.name, key) as boolean}
                              onChange={(e) => {
                                updateBuiltInMcpOption(entry.name, key, e.currentTarget.checked)
                              }}
                            />
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>

        {/* Add to Global Modal */}
        <Show when={pendingServer()}>
          <AddToGlobalModal
            open={addToGlobalOpen()}
            onClose={() => {
              setAddToGlobalOpen(false)
              setPendingServer(null)
            }}
            type="mcp"
            serverName={pendingServer()!.name}
            serverConfig={pendingServer()!.config}
            onAddGlobal={handleAddToGlobal}
            onKeepProjectOnly={handleKeepProjectOnly}
          />
        </Show>

      </div>
    </div>
  )
}

export default McpSettingsPanel
