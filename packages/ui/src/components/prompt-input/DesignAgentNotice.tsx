import { createSignal, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { getLogger } from "../../lib/logger"

const log = getLogger("session")

interface DesignAgentNoticeProps {
  /** Selects the location's default agent; the composer stays blocked until the agent changes. */
  onUseDefaultAgent?: () => Promise<void>
}

/** Shown above the composer of an Images conversation whose selected `design` agent is absent. */
const DesignAgentNotice: Component<DesignAgentNoticeProps> = (props) => {
  const { t } = useI18n()
  const [switching, setSwitching] = createSignal(false)
  const useDefault = async () => {
    if (!props.onUseDefaultAgent || switching()) return
    setSwitching(true)
    try {
      await props.onUseDefaultAgent()
    } catch (error) {
      log.error("Failed to select the default agent", error)
    } finally {
      setSwitching(false)
    }
  }
  return (
    <div class="composer-notice" role="status">
      <span class="composer-notice-text">{t("promptInput.designAgentMissing.message")}</span>
      <button type="button" class="button-secondary composer-notice-action" disabled={!props.onUseDefaultAgent || switching()} onClick={() => void useDefault()}>
        {t("promptInput.designAgentMissing.useDefault")}
      </button>
    </div>
  )
}

export default DesignAgentNotice
