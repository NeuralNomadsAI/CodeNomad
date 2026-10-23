import type { Component, JSX } from "solid-js"
import { useI18n } from "../lib/i18n"
import { BrandLogo } from "./brand-logo"

interface BrandedEmptyStateProps {
  title?: JSX.Element
  description: JSX.Element
  class?: string
  children?: JSX.Element
}

const BrandedEmptyState: Component<BrandedEmptyStateProps> = (props) => {
  const { t } = useI18n()

  return (
    <div class={`empty-state ${props.class ?? ""}`.trim()}>
      <div class="empty-state-content">
        <div class="flex flex-col items-center gap-3 mb-6">
          <BrandLogo alt={t("messageSection.empty.logoAlt")} class="empty-state-logo h-16" />
          <h1 class="empty-state-brand-title text-3xl font-semibold text-primary">{t("messageSection.empty.brandTitle")}</h1>
        </div>
        {props.title ? <h3>{props.title}</h3> : null}
        <p>{props.description}</p>
        {props.children}
      </div>
    </div>
  )
}

export default BrandedEmptyState
