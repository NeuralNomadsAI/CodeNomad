import { For, Show } from "solid-js"
import type { OpenCodeConsoleUsage } from "../../../../server/src/api-types-provider-usage"
import { useI18n } from "../../lib/i18n"
import { InfoPopoverButton } from "../info-popover-button"

export function ProviderUsageConsole(props: { usage: OpenCodeConsoleUsage }) {
  const { t, locale } = useI18n()
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value)
  const usd = (value: number) => new Intl.NumberFormat(locale(), { style: "currency", currency: "USD" }).format(value)
  const reset = (time: number) => t("providerUsage.resets", { time: new Date(time).toLocaleString(locale(), { dateStyle: "short", timeStyle: "short" }) })
  return <div class="space-y-3 text-[11px] text-primary">
    <section>
      <div class="mb-1 flex items-center gap-1">
        <h4 class="font-medium">{t("providerUsage.console.requests")}</h4>
        <InfoPopoverButton label={t("providerUsage.console.requests")}>{t("providerUsage.console.info")}</InfoPopoverButton>
      </div>
      <dl class="space-y-1">
        <For each={[ ["24h", "today"], ["7d", "sevenDays"], ["30d", "thirtyDays"] ] as const}>{([range, label]) =>
          <div class="flex min-w-0 flex-wrap justify-between gap-x-2"><dt>{t(`providerUsage.console.${label}`)}</dt><dd class="min-w-0 break-words font-medium tabular-nums">{number(props.usage.requests[range])}</dd></div>
        }</For>
      </dl>
    </section>
    <section>
      <h4 class="mb-1 font-medium">{t("providerUsage.console.models")}</h4>
      <Show when={props.usage.models.length} fallback={<p class="text-secondary">{t("providerUsage.console.noRequests")}</p>}>
        <table class="w-full table-fixed text-start text-[11px]">
          <thead><tr><For each={["model", "provider", "count"]}>{key => <th scope="col" class={key === "count" ? "text-end font-medium" : "text-start font-medium"}>{t(`providerUsage.console.${key}`)}</th>}</For></tr></thead>
          <tbody><For each={props.usage.models}>{row => <tr>
            <td class="align-top break-words pe-1"><bdi>{row.model}</bdi></td>
            <td class="align-top break-words pe-1"><bdi>{row.provider}</bdi></td>
            <td class="break-words align-top text-end tabular-nums">{number(row.requests)}</td>
          </tr>}</For></tbody>
        </table>
      </Show>
    </section>
    <Show when={props.usage.budgets.status === "unavailable" || props.usage.budgets.items.length}>
      <section>
        <h4 class="mb-1 font-medium">{t("providerUsage.console.budgets")}</h4>
        <Show when={props.usage.budgets.status === "available"} fallback={<p class="text-secondary">{t("providerUsage.console.budgetsUnavailable")}</p>}>
          <ul class="space-y-2"><For each={props.usage.budgets.items}>{item => <li>
            <div class="break-words"><bdi>{item.name}</bdi> (<bdi>{item.id}</bdi>)</div>
            <div class="tabular-nums">{usd(item.spentUsd)} / {usd(item.limitUsd)}</div>
            <div class="text-tertiary">{reset(item.resetAt)}</div>
          </li>}</For></ul>
        </Show>
      </section>
    </Show>
  </div>
}
