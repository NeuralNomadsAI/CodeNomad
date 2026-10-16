import { createSignal, onCleanup, Show, type ParentProps } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { showConfirmDialog } from "../../stores/alerts"
import { serverSettings } from "../../stores/preferences"
import { OpenCodeSetupProgress } from "./opencode-setup-progress"
import { OpenCodeInstallationNotice } from "./opencode-installation-notice"
import type { OpenCodeUpdateStatus } from "../../../../server/src/api-types"
import { openCodeSetupStatus as status, openCodeSetupBusy as busy, openCodeSetupError, openCodeSetupCheckError,
  openCodeSetupChecking as checking, openCodeSetupAction as action, openCodeSetupFeedback, openCodeInstallationError,
  isOpenCodeConnected, canContinueOpenCodeSetup, continueOpenCodeSetup,
  refreshOpenCodeSetup, runOpenCodeSetup } from "../../stores/opencode-setup"

export function OpenCodeSetupPanel(props: ParentProps = {}) {
  const { t } = useI18n()
  const [restartPending, setRestartPending] = createSignal(false)
  const [confirmPending, setConfirmPending] = createSignal(false)
  let disposed = false
  onCleanup(() => { disposed = true })
  const disabled = () => busy() || checking() || restartPending() || confirmPending()
  const restartForTroubleshooting = async () => {
    if (disabled() || openCodeSetupCheckError() || !status()?.canRestart) return
    const binary = serverSettings().opencodeBinary
    setRestartPending(true)
    try {
      const confirmed = await showConfirmDialog(t("settings.opencode.setup.restartDescription"), {
        title: t("settings.opencode.setup.restartTroubleshooting"), variant: "warning",
        confirmLabel: t("settings.opencode.setup.restartTroubleshooting"), cancelLabel: t("alertDialog.actions.cancel"),
      })
      if (!confirmed || disposed || binary !== serverSettings().opencodeBinary || busy() || checking()
        || openCodeSetupCheckError() || !status()?.canRestart) return
      await runOpenCodeSetup("restart", { resumeWorkspace: false })
    } finally {
      if (!disposed) setRestartPending(false)
    }
  }
  // Replacing OpenCode 1.x removes an npm package: always confirm it, and fence
  // the confirmation against a changed executable, status or concurrent action.
  const install = async () => {
    const legacy = status()?.legacyReplacement
    if (!legacy) return void runOpenCodeSetup("install")
    if (disabled() || !status()?.canUpgrade) return
    const binary = serverSettings().opencodeBinary
    setConfirmPending(true)
    try {
      const confirmed = await showConfirmDialog(t("settings.opencode.setup.legacy.confirm", { version: legacy.version }), {
        title: t("settings.opencode.setup.legacy.title", { version: legacy.version }), variant: "warning",
        confirmLabel: t("settings.opencode.setup.legacy.action", { version: legacy.version }), cancelLabel: t("alertDialog.actions.cancel"),
      })
      const current = status()
      if (!confirmed || disposed || binary !== serverSettings().opencodeBinary || busy() || checking()
        || !current?.canUpgrade || current.legacyReplacement?.path !== legacy.path) return
      // The server re-verifies this exact installation under its lock.
      await runOpenCodeSetup("install", { replaceLegacy: { path: legacy.path, version: legacy.version } })
    } finally {
      if (!disposed) setConfirmPending(false)
    }
  }
  const installLabel = (data: OpenCodeUpdateStatus) => data.legacyReplacement
    ? t("settings.opencode.setup.legacy.action", { version: data.legacyReplacement.version })
    : data.foreignInstallation && data.installationSource !== "managed" ? t("settings.opencode.setup.foreign.install")
      : data.needsSharedInstallation ? t("settings.opencode.setup.sharedInstall")
        : data.state === "missing" ? t("settings.opencode.setup.install") : t("settings.opencode.update.action", { version: data.latestVersion ?? "" })
  const progress = () => checking() ? "settings.opencode.update.checking"
    : action() === "install" ? "settings.opencode.update.updating"
      : action() ? `settings.opencode.setup.progress.${action()}` : undefined
  return <><OpenCodeSetupProgress /><div class="opencode-setup-panel" aria-busy={disabled()}>
    <Show when={status()} fallback={<p role="status">{t(progress() ?? (openCodeSetupCheckError() ? "settings.opencode.setup.serviceError" : "settings.opencode.update.checking"))}</p>}>
      {data => <>
        <Show when={!busy()}><p class="settings-toggle-title" role="status">{t(progress() ?? (openCodeSetupCheckError() ? "settings.opencode.setup.disconnected" : isOpenCodeConnected() ? "settings.opencode.setup.connected"
          : data().state === "ready" ? "settings.opencode.setup.disconnected" : `settings.opencode.setup.${data().state}`))}</p></Show>
        <div class="settings-info-grid">
          <div class="settings-info-row"><span>{t("settings.opencode.update.installed")}</span><span>{data().currentVersion ?? "—"}</span></div>
          <div class="settings-info-row"><span>{t("settings.opencode.setup.daemon")}</span><span>{data().daemonVersion ?? "—"}</span></div>
        </div>
        <p class="settings-toggle-caption break-all">{data().binaryPath}</p>
        <Show when={data().installationSource}>
          {source => <p class="settings-toggle-caption">{t(`settings.opencode.setup.source.${source()}`)}</p>}
        </Show>
        <Show when={!busy() && data().updateAvailable && data().latestVersion}>
          <p role="status">{t("settings.opencode.update.available", { version: data().latestVersion ?? "" })}</p>
        </Show>
        <Show when={!busy() && data().updateAvailable === false && data().latestVersion && !data().checkError}>
          <p role="status">{t("settings.opencode.update.upToDate")}</p>
        </Show>
        <Show when={data().target === "wsl"}><p class="settings-toggle-caption">{t("settings.opencode.setup.wsl")}</p></Show>
        <Show when={data().serviceState === "restart_required" || data().serviceState === "restart_available"}>
          <p role="status">{t(data().serviceState === "restart_required" ? "settings.opencode.setup.restartRequired" : "settings.opencode.setup.restartAvailable")}</p>
        </Show>
        <Show when={!openCodeSetupCheckError() && data().serviceState === "error"}><p role="alert">{t("settings.opencode.setup.serviceError")}</p></Show>
        <Show when={data().checkError}><p role="status">{t("settings.opencode.update.checkFailed")}</p></Show>
        <Show when={!data().canUpgrade && (data().updateAvailable || data().state === "missing" || data().state === "update_required" || data().serviceState === "incompatible")}>
          <p>{t("settings.opencode.setup.manual")}</p>
        </Show>
        <Show when={(data().daemonVersion || data().currentVersion) && data().versionAssessment === "untested"}>
          <p class="settings-toggle-caption">{t("settings.opencode.setup.untested", { version: data().daemonVersion ?? data().currentVersion ?? "" })}</p>
        </Show>
        <div class="settings-info-actions">
          <Show when={data().canUpgrade}><button type="button" class="settings-pill-button" disabled={disabled()} onClick={() => void install()}>
            {action() === "install" ? t("settings.opencode.update.updating") : installLabel(data())}
          </button></Show>
          <Show when={data().state === "ready" && !isOpenCodeConnected() && data().serviceState !== "restart_required" && data().serviceState !== "incompatible"}>
            <button type="button" class="settings-pill-button" disabled={disabled()} onClick={() => void runOpenCodeSetup("start")}>{t("settings.opencode.setup.connect")}</button>
          </Show>
          <Show when={isOpenCodeConnected() && canContinueOpenCodeSetup()}>
            <button type="button" class="settings-pill-button" disabled={disabled()} onClick={() => void continueOpenCodeSetup()}>{t("settings.opencode.setup.continue")}</button>
          </Show>
          <Show when={data().canRestart && (data().serviceState === "restart_required" || data().serviceState === "restart_available")}><button type="button" class="settings-pill-button" disabled={disabled() || openCodeSetupCheckError()} onClick={() => void runOpenCodeSetup("restart")}>{t("settings.opencode.setup.restart")}</button></Show>
        </div>
        <Show when={data().canUpgrade && (data().state === "missing" || data().needsSharedInstallation)}>
          <p class="settings-toggle-caption">{t("settings.opencode.setup.sharedInstallDescription")}</p>
        </Show>
        <OpenCodeInstallationNotice status={data()} />
      </>}
    </Show>
    <Show when={openCodeSetupCheckError()}><p class="settings-error-message" role="alert">{t("settings.opencode.setup.serviceError")}</p></Show>
    <Show when={openCodeSetupError()}><p class="settings-error-message" role="alert">{t(openCodeInstallationError() ? `settings.opencode.setup.${openCodeInstallationError()}` : "settings.opencode.setup.actionFailed")}</p></Show>
    <Show when={openCodeSetupFeedback()}><p role="status">{t(`settings.opencode.setup.${openCodeSetupFeedback()}`)}</p></Show>
    <div class="settings-info-actions"><button type="button" class="settings-pill-button" disabled={disabled()} onClick={() => void refreshOpenCodeSetup(false, true)}>
      {t(checking() ? "settings.opencode.update.checking" : "settings.opencode.setup.check")}
    </button></div>
    {props.children}
    <Show when={status()}>
      {data => <>
        <details class="opencode-setup-details">
          <summary>{t("settings.opencode.setup.diagnostics")}</summary>
          <div class="settings-info-grid">
            <div class="settings-info-row"><span>{t("settings.opencode.setup.minimum")}</span><span>{data().minimumVersion}</span></div>
            <div class="settings-info-row"><span>{t("settings.opencode.setup.recommended")}</span><span>{data().recommendedVersion}</span></div>
          </div>
          <p class="settings-toggle-caption">{t("settings.opencode.setup.minimumReason", { version: data().minimumVersion })}</p>
          <Show when={data().incompatibilityReason && data().incompatibilityReason !== "step_timestamp" && data().incompatibilityReason !== "plugin_runtime"}>
            <p role="alert">{t(`settings.opencode.setup.${data().incompatibilityReason}`)}</p>
          </Show>
        </details>
        <details class="opencode-setup-details">
          <summary>{t("settings.opencode.setup.troubleshooting")}</summary>
          <p class="settings-toggle-caption">{t("settings.opencode.setup.restartDescription")}</p>
          <div class="settings-info-actions"><button type="button" class="settings-pill-button" disabled={disabled() || openCodeSetupCheckError() || !data().canRestart} onClick={() => void restartForTroubleshooting()}>{t("settings.opencode.setup.restartTroubleshooting")}</button></div>
          <Show when={data().canReload}>
            <p class="settings-toggle-caption">{t("settings.opencode.setup.reloadDescription")}</p>
            <div class="settings-info-actions"><button type="button" class="settings-pill-button" disabled={disabled() || openCodeSetupCheckError()} onClick={() => void runOpenCodeSetup("reload")}>{t("settings.opencode.setup.reload")}</button></div>
          </Show>
        </details>
      </>}
    </Show>
  </div></>
}
