import { Component, For, Show, createMemo } from "solid-js"
import { getInstanceLogs, instances, isInstanceLogStreaming, setInstanceLogStreaming } from "../stores/instances"
import { useI18n } from "../lib/i18n"
import LogStreamList from "./log-stream-list"

interface LogsViewProps {
  instanceId: string
}

const LogsView: Component<LogsViewProps> = (props) => {
  const { t } = useI18n()

  const instance = () => instances().get(props.instanceId)
  const logs = createMemo(() => getInstanceLogs(props.instanceId))
  const streamingEnabled = createMemo(() => isInstanceLogStreaming(props.instanceId))

  const handleEnableLogs = () => setInstanceLogStreaming(props.instanceId, true)
  const handleDisableLogs = () => setInstanceLogStreaming(props.instanceId, false)

  return (
    <div class="log-container">
      <div class="log-header">
        <h3 class="text-sm font-medium" style="color: var(--text-secondary)">{t("logsView.title")}</h3>
        <div class="flex items-center gap-2">
          <Show
            when={streamingEnabled()}
            fallback={
              <button type="button" class="button-tertiary" onClick={handleEnableLogs}>
                {t("logsView.actions.show")}
              </button>
            }
          >
            <button type="button" class="button-tertiary" onClick={handleDisableLogs}>
              {t("logsView.actions.hide")}
            </button>
          </Show>
        </div>
      </div>

      <Show when={instance()?.environmentVariables && Object.keys(instance()?.environmentVariables ?? {}).length > 0}>
        <div class="env-vars-container">
          <div class="env-vars-title">
            {t("logsView.envVars.title", { count: Object.keys(instance()?.environmentVariables ?? {}).length })}
          </div>
          <div class="space-y-1">
            <For each={Object.entries(instance()?.environmentVariables ?? {})}>
              {([key, value]) => (
                <div class="env-var-item">
                  <span class="env-var-key">{key}</span>
                  <span class="env-var-separator">=</span>
                  <span class="env-var-value" title={value}>
                    {value}
                  </span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      <LogStreamList
        scrollStateKey={`logs-view:${props.instanceId}`}
        logs={logs}
        streamingEnabled={streamingEnabled}
        onEnableLogs={handleEnableLogs}
        emptyLabel={t("logsView.empty.waiting")}
        pausedTitle={t("logsView.paused.title")}
        pausedDescription={t("logsView.paused.description")}
        showLogsLabel={t("logsView.actions.show")}
        scrollToBottomLabel={t("logsView.scrollToBottom")}
      />
    </div>
  )
}

export default LogsView
