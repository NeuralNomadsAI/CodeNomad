import { Component, createSignal, For, Show } from "solid-js"
import { Plus, Trash2, Key, Globe } from "lucide-solid"
import { useConfig } from "../stores/preferences"
import { useI18n } from "../lib/i18n"

interface EnvironmentVariablesEditorProps {
  disabled?: boolean
}

const EnvironmentVariablesEditor: Component<EnvironmentVariablesEditorProps> = (props) => {
  const { t } = useI18n()
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
    <div class="space-y-3">
      <div class="flex items-center gap-2 mb-3">
        <Globe class="w-4 h-4 icon-muted" />
        <span class="text-sm font-medium text-secondary">{t("envEditor.title")}</span>
        <span class="text-xs text-muted">
          {entries().length === 1
            ? t("envEditor.count.one", { count: entries().length })
            : t("envEditor.count.other", { count: entries().length })}
        </span>
      </div>

      {/* Existing variables */}
      <Show when={entries().length > 0}>
        <div class="space-y-2">
          <For each={entries()}>
            {([key, value]) => (
              <div class="flex items-center gap-2">
                <div class="flex-1 flex items-center gap-2">
                  <Key class="w-3.5 h-3.5 icon-muted flex-shrink-0" />
                  <input
                    type="text"
                    value={key}
                    disabled={props.disabled}
                    class="flex-1 px-2.5 py-1.5 text-sm bg-surface-secondary border border-base rounded text-muted cursor-not-allowed"
                    placeholder={t("envEditor.fields.name.placeholder")}
                    title={t("envEditor.fields.name.readOnlyTitle")}
                  />
                  <input
                    type="text"
                    value={value}
                    disabled={props.disabled}
                    onInput={(e) => handleUpdateVariable(key, e.currentTarget.value)}
                    class="flex-1 px-2.5 py-1.5 text-sm bg-surface-base border border-base rounded text-primary focus-ring-accent disabled:opacity-50 disabled:cursor-not-allowed"
                    placeholder={t("envEditor.fields.value.placeholder")}
                  />
                </div>
                <button
                  onClick={() => handleRemoveVariable(key)}
                  disabled={props.disabled}
                  class="p-1.5 icon-muted icon-danger-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  title={t("envEditor.actions.remove.title")}
                >
                  <Trash2 class="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Add new variable */}
      <div class="flex items-center gap-2 pt-2 border-t border-base">
        <div class="flex-1 flex items-center gap-2">
          <Key class="w-3.5 h-3.5 icon-muted flex-shrink-0" />
          <input
            type="text"
            value={newKey()}
            onInput={(e) => setNewKey(e.currentTarget.value)}
            onKeyPress={handleKeyPress}
            disabled={props.disabled}
            class="flex-1 px-2.5 py-1.5 text-sm bg-surface-base border border-base rounded text-primary focus-ring-accent disabled:opacity-50 disabled:cursor-not-allowed"
            placeholder={t("envEditor.fields.name.placeholder")}
          />
          <input
            type="text"
            value={newValue()}
            onInput={(e) => setNewValue(e.currentTarget.value)}
            onKeyPress={handleKeyPress}
            disabled={props.disabled}
            class="flex-1 px-2.5 py-1.5 text-sm bg-surface-base border border-base rounded text-primary focus-ring-accent disabled:opacity-50 disabled:cursor-not-allowed"
            placeholder={t("envEditor.fields.value.placeholder")}
          />
        </div>
        <button
          onClick={handleAddVariable}
          disabled={props.disabled || !newKey().trim()}
          class="p-1.5 icon-muted icon-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title={t("envEditor.actions.add.title")}
        >
          <Plus class="w-3.5 h-3.5" />
        </button>
      </div>

      <Show when={entries().length === 0}>
        <div class="text-xs text-muted text-center py-2">
          {t("envEditor.empty")}
        </div>
      </Show>

      <div class="text-xs text-muted mt-2">
        {t("envEditor.help")}
      </div>
    </div>
  )
}

export default EnvironmentVariablesEditor
