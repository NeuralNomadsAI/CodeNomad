import { Component, createSignal, For, Show } from "solid-js"
import { Plus, Trash2, Key, Globe } from "lucide-solid"
import { useConfig } from "../stores/preferences"

interface EnvironmentVariablesEditorProps {
  disabled?: boolean
}

const EnvironmentVariablesEditor: Component<EnvironmentVariablesEditorProps> = (props) => {
  const {
    preferences,
    addEnvironmentVariable,
    removeEnvironmentVariable,
    updateEnvironmentVariables,
  } = useConfig()
  const [envVars, setEnvVars] = createSignal<Record<string, string>>(preferences().environmentVariables || {})
  const [newKey, setNewKey] = createSignal("")
  const [newValue, setNewValue] = createSignal("")

  const entries = () => Object.entries(envVars())

  function handleAddVariable() {
    const key = newKey().trim()
    const value = newValue().trim()

    if (!key) return

    addEnvironmentVariable(key, value)
    setEnvVars({ ...envVars(), [key]: value })
    setNewKey("")
    setNewValue("")
  }

  function handleRemoveVariable(key: string) {
    removeEnvironmentVariable(key)
    const { [key]: removed, ...rest } = envVars()
    setEnvVars(rest)
  }

  function handleUpdateVariable(key: string, value: string) {
    const updated = { ...envVars(), [key]: value }
    setEnvVars(updated)
    updateEnvironmentVariables(updated)
  }

  function handleKeyPress(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleAddVariable()
    }
  }

  return (
    <div class="panel">
      <div class="panel-header">
        <h3 class="panel-title">Environment Variables</h3>
        <p class="panel-subtitle">
          Applied whenever a new OpenCode instance starts ({entries().length} variable{entries().length !== 1 ? "s" : ""})
        </p>
      </div>

      <div class="panel-body" style={{ gap: "var(--space-md)" }}>
        {/* Existing variables */}
        <Show when={entries().length > 0}>
          <div class="flex flex-col" style={{ gap: "var(--space-sm)" }}>
            <For each={entries()}>
              {([key, value]) => (
                <div class="flex items-center" style={{ gap: "var(--space-sm)" }}>
                  <div class="flex-1 flex items-center" style={{ gap: "var(--space-sm)" }}>
                    <Key class="w-3.5 h-3.5 icon-muted flex-shrink-0" />
                    <input
                      type="text"
                      value={key}
                      disabled
                      class="modal-input flex-1 min-w-[160px] opacity-70 cursor-not-allowed"
                      placeholder="Variable name"
                      title="Variable name (read-only)"
                    />
                    <input
                      type="text"
                      value={value}
                      disabled={props.disabled}
                      onInput={(e) => handleUpdateVariable(key, e.currentTarget.value)}
                      class="modal-input flex-1 min-w-[200px]"
                      placeholder="Variable value"
                    />
                  </div>
                  <button
                    onClick={() => handleRemoveVariable(key)}
                    disabled={props.disabled}
                    class="modal-button modal-button--danger p-2"
                    title="Remove variable"
                  >
                    <Trash2 class="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* Add new variable */}
        <div class="flex items-center pt-3 border-t border-base" style={{ gap: "var(--space-sm)" }}>
          <div class="flex-1 flex items-center" style={{ gap: "var(--space-sm)" }}>
            <Key class="w-3.5 h-3.5 icon-muted flex-shrink-0" />
            <input
              type="text"
              value={newKey()}
              onInput={(e) => setNewKey(e.currentTarget.value)}
              onKeyPress={handleKeyPress}
              disabled={props.disabled}
              class="modal-input flex-1 min-w-[160px]"
              placeholder="Variable name"
            />
            <input
              type="text"
              value={newValue()}
              onInput={(e) => setNewValue(e.currentTarget.value)}
              onKeyPress={handleKeyPress}
              disabled={props.disabled}
              class="modal-input flex-1 min-w-[200px]"
              placeholder="Variable value"
            />
          </div>
          <button
            onClick={handleAddVariable}
            disabled={props.disabled || !newKey().trim()}
            class="modal-button modal-button--primary p-2"
            title="Add variable"
          >
            <Plus class="w-3.5 h-3.5" />
          </button>
        </div>

        <Show when={entries().length === 0}>
          <p class="text-xs text-secondary italic text-center py-2">
            No environment variables configured. Add variables above to customize the OpenCode environment.
          </p>
        </Show>

        <p class="text-xs text-secondary">
          These variables will be available in the OpenCode environment when starting instances.
        </p>
      </div>
    </div>
  )
}

export default EnvironmentVariablesEditor
