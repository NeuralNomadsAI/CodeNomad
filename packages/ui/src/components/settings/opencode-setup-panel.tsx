import { Show } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { OpenCodeExecutableCard } from "./opencode-executable-card"
import { openCodeSetupStatus as status, openCodeSetupBusy as busy, openCodeSetupError,
  openCodeSetupChecking as checking, openCodeSetupAction as action, openCodeSetupFeedback,
  isOpenCodeConnected, canContinueOpenCodeSetup, continueOpenCodeSetup,
  refreshOpenCodeSetup, runOpenCodeSetup } from "../../stores/opencode-setup"

export function OpenCodeSetupPanel(props: { showExecutable?: boolean } = {}) {
  const { t } = useI18n()
  const disabled = () => busy() || checking()
  return <div class="opencode-setup-panel" aria-busy={disabled()}>
    <Show when={props.showExecutable !== false}><OpenCodeExecutableCard /></Show>
    <Show when={status()} fallback={<p role="status">{t(openCodeSetupError() ? "settings.opencode.update.checkFailed" : "settings.opencode.update.checking")}</p>}>
      {data => <>
        <p class="settings-toggle-title" role="status">{t(isOpenCodeConnected() ? "settings.opencode.setup.connected"
          : data().state === "ready" ? "settings.opencode.setup.disconnected" : `settings.opencode.setup.${data().state}`)}</p>
        <div class="settings-info-grid">
          <div class="settings-info-row"><span>{t("settings.opencode.update.installed")}</span><span>{data().currentVersion ?? "—"}</span></div>
          <div class="settings-info-row"><span>{t("settings.opencode.setup.daemon")}</span><span>{data().daemonVersion ?? "—"}</span></div>
        </div>
        <p class="settings-toggle-caption break-all">{data().binaryPath}</p>
        <Show when={data().updateAvailable && data().latestVersion}>
          <p role="status">{t("settings.opencode.update.available", { version: data().latestVersion ?? "" })}</p>
        </Show>
        <Show when={data().updateAvailable === false && data().latestVersion && !data().checkError}>
          <p role="status">{t("settings.opencode.update.upToDate")}</p>
        </Show>
        <Show when={data().target === "wsl"}><p class="settings-toggle-caption">{t("settings.opencode.setup.wsl")}</p></Show>
        <Show when={data().serviceState === "restart_required" || data().serviceState === "restart_available"}>
          <p role="status">{t(data().serviceState === "restart_required" ? "settings.opencode.setup.restartRequired" : "settings.opencode.setup.restartAvailable")}</p>
        </Show>
        <Show when={data().serviceState === "error"}><p role="alert">{t("settings.opencode.setup.serviceError")}</p></Show>
        <Show when={data().checkError}><p role="status">{t("settings.opencode.update.checkFailed")}</p></Show>
        <Show when={!data().canUpgrade && (data().updateAvailable || data().state === "missing" || data().state === "update_required" || data().serviceState === "incompatible")}>
          <p>{t("settings.opencode.setup.manual")}</p>
        </Show>
        <Show when={(data().daemonVersion || data().currentVersion) && data().versionAssessment === "untested"}>
          <p class="settings-toggle-caption">{t("settings.opencode.setup.untested", { version: data().daemonVersion ?? data().currentVersion ?? "" })}</p>
        </Show>
        <div class="settings-info-actions">
          <Show when={data().canUpgrade}><button type="button" class="settings-pill-button" disabled={disabled()} onClick={() => void runOpenCodeSetup("install")}>
            {action() === "install" ? t("settings.opencode.update.updating") : data().state === "missing" ? t("settings.opencode.setup.install") : t("settings.opencode.update.action", { version: data().latestVersion ?? "" })}
          </button></Show>
          <Show when={data().state === "ready" && !isOpenCodeConnected() && data().serviceState !== "restart_required" && data().serviceState !== "incompatible"}>
            <button type="button" class="settings-pill-button" disabled={disabled()} onClick={() => void runOpenCodeSetup("start")}>{t("settings.opencode.setup.connect")}</button>
          </Show>
          <Show when={isOpenCodeConnected() && canContinueOpenCodeSetup()}>
            <button type="button" class="settings-pill-button" disabled={disabled()} onClick={() => void continueOpenCodeSetup()}>{t("settings.opencode.setup.continue")}</button>
          </Show>
          <Show when={data().canRestart}><button type="button" class="settings-pill-button" disabled={disabled()} onClick={() => void runOpenCodeSetup("restart")}>{t("settings.opencode.setup.restart")}</button></Show>
        </div>
      </>}
    </Show>
    <Show when={openCodeSetupError()}><p class="settings-error-message" role="alert">{t("settings.opencode.setup.actionFailed")}</p></Show>
    <Show when={action()}><p role="status">{t(action() === "install" ? "settings.opencode.update.updating" : `settings.opencode.setup.progress.${action()}`)}</p></Show>
    <Show when={openCodeSetupFeedback()}><p role="status">{t(`settings.opencode.setup.${openCodeSetupFeedback()}`)}</p></Show>
    <div class="settings-info-actions"><button type="button" class="settings-pill-button" disabled={disabled()} onClick={() => void refreshOpenCodeSetup(false, true)}>
      {t(checking() ? "settings.opencode.update.checking" : "settings.opencode.setup.check")}
    </button></div>
    <Show when={status()}>
      {data => <>
        <details class="opencode-setup-details">
          <summary>{t("settings.opencode.setup.diagnostics")}</summary>
          <div class="settings-info-grid">
            <div class="settings-info-row"><span>{t("settings.opencode.setup.minimum")}</span><span>{data().minimumVersion}</span></div>
            <div class="settings-info-row"><span>{t("settings.opencode.setup.recommended")}</span><span>{data().recommendedVersion}</span></div>
          </div>
          <p class="settings-toggle-caption">{t("settings.opencode.setup.minimumReason", { version: data().minimumVersion })}</p>
          <Show when={data().incompatibilityReason && data().incompatibilityReason !== "step_timestamp"}>
            <p role="alert">{t(`settings.opencode.setup.${data().incompatibilityReason}`)}</p>
          </Show>
        </details>
        <Show when={data().canReload}>
          <details class="opencode-setup-details">
            <summary>{t("settings.opencode.setup.troubleshooting")}</summary>
            <p class="settings-toggle-caption">{t("settings.opencode.setup.reloadDescription")}</p>
            <div class="settings-info-actions"><button type="button" class="settings-pill-button" disabled={disabled()} onClick={() => void runOpenCodeSetup("reload")}>{t("settings.opencode.setup.reload")}</button></div>
          </details>
        </Show>
      </>}
    </Show>
  </div>
}
