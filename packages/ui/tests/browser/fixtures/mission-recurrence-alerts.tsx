import { render } from "solid-js/web"
import AlertDialog from "../../../src/components/alert-dialog"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"

// The shared editor fixture mounts no AlertDialog; schedule Stop… confirms through it.
const host = document.body.appendChild(document.createElement("div"))
render(() => <ConfigProvider><I18nProvider><AlertDialog /></I18nProvider></ConfigProvider>, host)
