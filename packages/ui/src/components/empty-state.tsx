import { Component } from "solid-js"
import { Loader2 } from "lucide-solid"
import { useI18n } from "../lib/i18n"

const codeNomadIcon = new URL("../images/CodeNomad-Icon.png", import.meta.url).href

interface EmptyStateProps {
  onSelectFolder: () => void
  isLoading?: boolean
}

const EmptyState: Component<EmptyStateProps> = (props) => {
  const { t } = useI18n()
  const modifier = typeof navigator !== "undefined" && navigator.platform.includes("Mac") ? "Cmd" : "Ctrl"
  const shortcut = `${modifier}+N`

  return (
    <div class="flex h-full w-full items-center justify-center bg-surface-secondary">
      <div class="max-w-[500px] px-8 py-12 text-center">
        <div class="mb-8 flex justify-center">
          <img src={codeNomadIcon} alt={t("emptyState.logoAlt")} class="h-24 w-auto" loading="lazy" />
        </div>

        <h1 class="mb-3 text-3xl font-semibold text-primary">{t("emptyState.brandTitle")}</h1>
        <p class="mb-8 text-base text-secondary">{t("emptyState.tagline")}</p>


        <button
          onClick={props.onSelectFolder}
          disabled={props.isLoading}
          class="mb-4 button-primary"
        >
          {props.isLoading ? (
            <>
              <Loader2 class="h-4 w-4 animate-spin" />
              {t("emptyState.actions.selecting")}
            </>
          ) : (
            t("emptyState.actions.selectFolder")
          )}
        </button>

        <p class="text-sm text-muted">
          {t("emptyState.keyboardShortcut", { shortcut })}
        </p>

        <div class="mt-6 space-y-1 text-sm text-muted">
          <p>{t("emptyState.examples", { example: "~/projects/my-app" })}</p>
          <p>{t("emptyState.multipleInstances")}</p>
        </div>
      </div>
    </div>
  )
}

export default EmptyState
