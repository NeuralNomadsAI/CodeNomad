import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { useConfig } from "../stores/preferences"
import type { McpServerConfig } from "../stores/preferences"
import { instances } from "../stores/instances"
import { getLogger } from "../lib/logger"
import { instanceApi } from "../lib/instance-api"
import { loadInstanceMetadata } from "../lib/hooks/use-instance-metadata"

const log = getLogger("actions")

type McpEntry = {
  name: string
  config: McpServerConfig
  desiredEnabled: boolean
}

const McpSettingsPanel: Component = () => {
  const { preferences, updatePreferences } = useConfig()
  const [newName, setNewName] = createSignal("")
  const [newType, setNewType] = createSignal<McpServerConfig["type"]>("local")
  const [newCommand, setNewCommand] = createSignal("npx -y @modelcontextprotocol/server-everything")
  const [newUrl, setNewUrl] = createSignal("")

  const entries = createMemo<McpEntry[]>(() => {
    const registry = preferences().mcpRegistry ?? {}
    const desiredState = preferences().mcpDesiredState ?? {}
    return Object.entries(registry)
      .map(([name, config]) => ({
        name,
        config,
        desiredEnabled: desiredState[name] ?? (config.enabled ?? true),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
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

    saveEntry(name, config, true)
    setNewName("")
    setNewUrl("")

    void applyAll()
  }

  return (
    <div class="panel">
      <div class="panel-header">
        <h3 class="panel-title">MCP Servers</h3>
        <p class="panel-subtitle">Registry stored in CodeNomad and applied to all instances</p>
      </div>

      <div class="panel-body" style={{ gap: "var(--space-md)" }}>
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
        </div>

        <Show when={entries().length > 0} fallback={<p class="text-xs text-secondary italic">No MCP servers configured yet.</p>}>
          <div class="flex flex-col" style={{ gap: "var(--space-sm)" }}>
            <For each={entries()}>
              {(entry) => (
                <div class="px-3 py-2 rounded-md border bg-surface-secondary border-base">
                  <div class="flex items-center justify-between" style={{ gap: "var(--space-sm)" }}>
                    <div class="flex flex-col min-w-0">
                      <div class="text-sm text-primary font-medium truncate">{entry.name}</div>
                      <div class="text-xs text-secondary truncate">
                        {entry.config.type === "local" ? entry.config.command.join(" ") : entry.config.url}
                      </div>
                    </div>
                    <div class="flex items-center" style={{ gap: "var(--space-sm)" }}>
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
                      <button
                        type="button"
                        class="modal-button modal-button--danger"
                        onClick={() => removeEntry(entry.name)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}

export default McpSettingsPanel
