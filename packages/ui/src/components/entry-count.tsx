import { useI18n } from "../lib/i18n"

/** An empty tab's section counter. */
export default function EntryCount(props: { count: number }) {
  const { t } = useI18n()
  return <p class="panel-subtitle mt-1">{t(props.count === 1 ? "newTab.items.one" : "newTab.items.other", { count: props.count })}</p>
}
