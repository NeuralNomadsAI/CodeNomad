import { Show, createEffect, createSignal } from "solid-js"
import type { ServerMeta } from "../../../server/src/api-types"
import { getServerMeta } from "../lib/server-meta"
import { useI18n } from "../lib/i18n"
import { openExternalUrl } from "../lib/external-url"
import { useAvailableUpdate } from "../stores/releases"

export default function VersionPill() {
  const { t } = useI18n()
  const [meta, setMeta] = createSignal<ServerMeta | null>(null)
  const availableUpdate = useAvailableUpdate()

  createEffect(() => {
    void getServerMeta()
      .then((result) => setMeta(result))
      .catch(() => setMeta(null))
  })

  const serverVersion = () => meta()?.serverVersion
  const uiVersion = () => meta()?.ui?.version
  const uiSource = () => meta()?.ui?.source
  const latestServerUrl = () => meta()?.support?.latestServerUrl ?? null
  const latestServerVersion = () => meta()?.support?.latestServerVersion ?? null
  const update = () => {
    const refreshedUpdate = availableUpdate()
    if (refreshedUpdate !== undefined) {
      return refreshedUpdate
    }
    return meta()?.update ?? null
  }

  const uiLabel = () => (uiVersion() ? t("versionPill.uiWithVersion", { version: uiVersion() }) : t("versionPill.ui"))

  return (
    <Show when={serverVersion() || uiVersion() || uiSource() || update() || latestServerUrl()}>
      <div class="text-[11px] text-muted whitespace-nowrap">
        <Show when={serverVersion()}>
          {(v) => <span>{t("versionPill.appWithVersion", { version: v() })}</span>}
        </Show>
        <Show when={uiVersion() || uiSource()}>
          <>
            <Show when={serverVersion()}>
              <span class="mx-2">·</span>
            </Show>
            <span>
              {uiLabel()}
              <Show when={uiSource()}>{(s) => <span class="opacity-70">{t("versionPill.source", { source: s() })}</span>}</Show>
            </span>
          </>
        </Show>
        <Show when={update() || latestServerUrl()}>
          {() => (
            <>
              <Show when={serverVersion() || uiVersion() || uiSource()}>
                <span class="mx-2">·</span>
              </Show>
              <a
                href={update()?.url ?? latestServerUrl() ?? "#"}
                target="_blank"
                rel="noreferrer"
                class="text-primary hover:underline underline-offset-2"
                title={
                  update()?.version
                    ? t("releases.devUpdateAvailable.message", { version: update()!.version })
                    : latestServerVersion()
                      ? t("releases.upgradeRequired.message.withVersion", { version: latestServerVersion()! })
                      : t("releases.upgradeRequired.message.noVersion")
                }
                onClick={(event) => {
                  event.preventDefault()
                  const url = update()?.url ?? latestServerUrl()
                  if (!url) return
                  void openExternalUrl(url, "version-pill")
                }}
              >
                {update() ? t("releases.devUpdateAvailable.action") : t("releases.upgradeRequired.action.getUpdate")}
              </a>
            </>
          )}
        </Show>
      </div>
    </Show>
  )
}
