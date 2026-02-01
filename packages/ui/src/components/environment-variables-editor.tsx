import { Component, createSignal, For, Show } from "solid-js"
import { Plus, Trash2, Key, Globe } from "lucide-solid"
import { useConfig } from "../stores/preferences"
import { cn } from "../lib/cn"

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
    <div class="rounded-lg shadow-sm border border-border overflow-hidden min-w-0 bg-background text-foreground">
      <div class="px-4 py-3 border-b border-border bg-secondary">
        <h3 class="text-base font-semibold text-foreground">Environment Variables</h3>
        <p class="text-xs mt-0.5 text-muted-foreground">
          Applied whenever a new OpenCode instance starts ({entries().length} variable{entries().length !== 1 ? "s" : ""})
        </p>
      </div>

      <div class="p-4 bg-background" style={{ gap: "var(--space-md)" }}>
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
                      class="w-full bg-transparent border border-border rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary placeholder:text-muted-foreground flex-1 min-w-[160px] opacity-70 cursor-not-allowed"
                      placeholder="Variable name"
                      title="Variable name (read-only)"
                    />
                    <input
                      type="text"
                      value={value}
                      disabled={props.disabled}
                      onInput={(e) => handleUpdateVariable(key, e.currentTarget.value)}
                      class="w-full bg-transparent border border-border rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary placeholder:text-muted-foreground flex-1 min-w-[200px]"
                      placeholder="Variable value"
                    />
                  </div>
                  <button
                    onClick={() => handleRemoveVariable(key)}
                    disabled={props.disabled}
                    class="inline-flex items-center justify-center gap-2 font-medium px-4 py-2 rounded-md transition-colors text-destructive hover:bg-destructive/10 p-2"
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
        <div class="flex items-center pt-3 border-t border-border" style={{ gap: "var(--space-sm)" }}>
          <div class="flex-1 flex items-center" style={{ gap: "var(--space-sm)" }}>
            <Key class="w-3.5 h-3.5 icon-muted flex-shrink-0" />
            <input
              type="text"
              value={newKey()}
              onInput={(e) => setNewKey(e.currentTarget.value)}
              onKeyPress={handleKeyPress}
              disabled={props.disabled}
              class="w-full bg-transparent border border-border rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary placeholder:text-muted-foreground flex-1 min-w-[160px]"
              placeholder="Variable name"
            />
            <input
              type="text"
              value={newValue()}
              onInput={(e) => setNewValue(e.currentTarget.value)}
              onKeyPress={handleKeyPress}
              disabled={props.disabled}
              class="w-full bg-transparent border border-border rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary placeholder:text-muted-foreground flex-1 min-w-[200px]"
              placeholder="Variable value"
            />
          </div>
          <button
            onClick={handleAddVariable}
            disabled={props.disabled || !newKey().trim()}
            class="inline-flex items-center justify-center gap-2 font-medium px-4 py-2 rounded-md transition-colors bg-primary text-primary-foreground hover:bg-primary/90 p-2"
            title="Add variable"
          >
            <Plus class="w-3.5 h-3.5" />
          </button>
        </div>

        <Show when={entries().length === 0}>
          <p class="text-xs text-muted-foreground italic text-center py-2">
            No environment variables configured. Add variables above to customize the OpenCode environment.
          </p>
        </Show>

        <p class="text-xs text-muted-foreground">
          These variables will be available in the OpenCode environment when starting instances.
        </p>
      </div>
    </div>
  )
}

export default EnvironmentVariablesEditor
