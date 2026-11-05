import { useI18n } from "../lib/i18n"

/** The home page's and blank tab's section counters. */
export default function EntryCount(props: { count: number }) {
  const { t } = useI18n()
  return <p class="panel-subtitle mt-1">{t(props.count === 1 ? "newTab.items.one" : "newTab.items.other", { count: props.count })}</p>
}
