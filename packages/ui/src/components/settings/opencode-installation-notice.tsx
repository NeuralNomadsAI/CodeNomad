import { Show } from "solid-js"
import type { OpenCodeUpdateStatus } from "../../../../server/src/api-types"
import { useI18n } from "../../lib/i18n"

/** Explains an OpenCode 1.x npm replacement or an older OpenCode left untouched elsewhere on PATH. */
export function OpenCodeInstallationNotice(props: { status: OpenCodeUpdateStatus }) {
  const { t } = useI18n()
  return <>
    <Show when={props.status.canUpgrade && props.status.legacyReplacement}>
      {legacy => <p class="settings-toggle-caption opencode-installation-text">{t("settings.opencode.setup.legacy.description", legacy())}</p>}
    </Show>
    <Show when={props.status.foreignInstallation}>
      {foreign => <div class="opencode-installation-notice" role="note">
        <p class="settings-toggle-caption">{foreign().version
          ? t("settings.opencode.setup.foreign.found", { version: foreign().version ?? "", path: foreign().path, minimum: props.status.minimumVersion })
          : t("settings.opencode.setup.foreign.unusable", { path: foreign().path })}</p>
        <Show when={foreign().source === "winget"}>
          <p class="settings-toggle-caption">{t("settings.opencode.setup.foreign.winget")}</p>
        </Show>
        <Show when={props.status.canUpgrade && props.status.installationSource !== "managed"}>
          <p class="settings-toggle-caption">{t("settings.opencode.setup.foreign.alongside")}</p>
        </Show>
        <p class="settings-toggle-caption">{t("settings.opencode.setup.foreign.terminal")}</p>
        <Show when={foreign().packageId}>
          {packageId => <p class="settings-toggle-caption">{t("settings.opencode.setup.foreign.wingetUninstall")} <code>winget uninstall {packageId()}</code></p>}
        </Show>
      </div>}
    </Show>
  </>
}
