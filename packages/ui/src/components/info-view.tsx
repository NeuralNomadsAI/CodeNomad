import { Component, Show, createMemo } from "solid-js"
import { getInstanceLogs, instances, isInstanceLogStreaming, setInstanceLogStreaming } from "../stores/instances"
import InstanceInfo from "./instance-info"
import { useI18n } from "../lib/i18n"
import LogStreamList from "./log-stream-list"

interface InfoViewProps {
  instanceId: string
}

const InfoView: Component<InfoViewProps> = (props) => {
  const { t } = useI18n()

  const instance = () => instances().get(props.instanceId)
  const logs = createMemo(() => getInstanceLogs(props.instanceId))
  const streamingEnabled = createMemo(() => isInstanceLogStreaming(props.instanceId))

  const handleEnableLogs = () => setInstanceLogStreaming(props.instanceId, true)
  const handleDisableLogs = () => setInstanceLogStreaming(props.instanceId, false)

  return (
    <div class="log-container">
      <div class="flex-1 flex flex-col lg:flex-row gap-4 p-4 overflow-hidden">
        <div class="lg:w-80 flex-shrink-0 min-h-0 overflow-y-auto max-h-[40vh] lg:max-h-none">
          <Show when={instance()}>{(inst) => <InstanceInfo instance={inst()} showDisposeButton />}</Show>
        </div>

        <div class="panel flex-1 flex flex-col min-h-0 overflow-hidden">
          <div class="log-header">
            <h2 class="panel-title">{t("infoView.logs.title")}</h2>
            <div class="flex items-center gap-2">
              <Show
                when={streamingEnabled()}
                fallback={
                  <button type="button" class="button-tertiary" onClick={handleEnableLogs}>
                    {t("infoView.logs.actions.show")}
                  </button>
                }
              >
                <button type="button" class="button-tertiary" onClick={handleDisableLogs}>
                  {t("infoView.logs.actions.hide")}
                </button>
              </Show>
            </div>
          </div>

          <LogStreamList
            scrollStateKey={`info-view:${props.instanceId}`}
            logs={logs}
            streamingEnabled={streamingEnabled}
            onEnableLogs={handleEnableLogs}
            emptyLabel={t("infoView.logs.empty.waiting")}
            pausedTitle={t("infoView.logs.paused.title")}
            pausedDescription={t("infoView.logs.paused.description")}
            showLogsLabel={t("infoView.logs.actions.show")}
            scrollToBottomLabel={t("infoView.logs.scrollToBottom")}
          />
        </div>
      </div>
    </div>
  )
}

export default InfoView
