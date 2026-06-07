import { Component } from "solid-js"
import { Loader2 } from "lucide-solid"

import type { Instance } from "../types/instance"
import { useI18n } from "../lib/i18n"
import BrandedEmptyState from "./branded-empty-state"

interface InstanceWelcomeViewProps {
  instance: Instance
}

const InstanceWelcomeView: Component<InstanceWelcomeViewProps> = (props) => {
  const { t } = useI18n()

  return (
    <BrandedEmptyState
      class="bg-surface-secondary"
      title={t("instanceWelcome.loading.title")}
      description={t("instanceWelcome.loading.description")}
    >
      <ul>
        <li class="flex items-center justify-center gap-2">
          <Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />
          <span class="truncate" title={props.instance.folder}>{props.instance.folder}</span>
        </li>
      </ul>
    </BrandedEmptyState>
  )
}

export default InstanceWelcomeView
