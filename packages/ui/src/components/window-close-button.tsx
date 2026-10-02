import { X } from "lucide-solid"
import { useI18n } from "../lib/i18n"

/** Shared dismissal control, placed in the surface's existing top toolbar. */
export default function WindowCloseButton(props: {
  onClose: () => void
  label?: string
  ref?: (element: HTMLButtonElement) => void
}) {
  const { t } = useI18n()
  return <button ref={props.ref} type="button" class="window-icon-button window-close-button"
    aria-label={props.label ?? t("toastHistory.close")} title={props.label ?? t("toastHistory.close")}
    onClick={props.onClose}><X aria-hidden="true" /></button>
}
