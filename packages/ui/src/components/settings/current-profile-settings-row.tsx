import { createResource, Show, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { getServerMeta } from "../../lib/server-meta"

/**
 * The data profile this desktop window runs, beside the other saved profiles in the
 * Startup card. The host names only an explicit non-default profile.
 */
export const CurrentProfileSettingsRow: Component = () => {
  const { t } = useI18n()
  const [meta] = createResource(() => getServerMeta().catch(() => null))
  return (
    <Show when={meta()?.desktopProfile}>
      {(profile) => (
        <div class="settings-toggle-row" data-testid="settings-data-profile">
          <div class="settings-toggle-title">{t("settings.appearance.startup.dataProfile")}</div>
          <span class="settings-info-value" dir="ltr">{profile()}</span>
        </div>
      )}
    </Show>
  )
}
