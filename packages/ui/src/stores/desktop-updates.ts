import { tGlobal } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { showToastNotification, type ToastHandle } from "../lib/notifications"
import { openExternalUrl } from "../lib/external-url"
import { checkDesktopUpdate, installDesktopUpdate, listenForDesktopUpdateFailure } from "../lib/native/updates"

const releasesUrl = "https://github.com/NeuralNomadsAI/CodeNomad/releases/latest"
const log = getLogger("actions")
let busy = false
let notice: ToastHandle | undefined

function showProgress(message: string) {
  notice?.dismiss()
  notice = showToastNotification({ message, variant: "info", duration: Number.POSITIVE_INFINITY })
}

function failed(error?: unknown) {
  busy = false
  notice?.dismiss()
  if (error) log.error("Desktop update failed", error)
  notice = showToastNotification({
    message: tGlobal("releases.desktop.failed"), variant: "error", duration: Number.POSITIVE_INFINITY,
    action: { label: tGlobal("releases.upgradeRequired.action.getUpdate"), href: releasesUrl },
  })
}

export function observeDesktopUpdates(): () => void {
  let disposed = false
  let unlisten: (() => void) | undefined
  void listenForDesktopUpdateFailure(() => failed()).then((listener) => {
    if (disposed) listener()
    else unlisten = listener
  }).catch((error) => log.error("Unable to observe desktop update failures", error))
  return () => { disposed = true; unlisten?.() }
}

async function install(version: string) {
  if (busy) return
  busy = true
  showProgress(tGlobal("releases.desktop.downloading"))
  try {
    await installDesktopUpdate(version)
    // A failed renderer flush or installer is reported asynchronously. On
    // success all windows close and the installed application relaunches.
    if (busy) showProgress(tGlobal("releases.desktop.restarting"))
  } catch (error) { failed(error) }
}

export async function requestDesktopUpdate(): Promise<void> {
  if (busy) return
  busy = true
  showProgress(tGlobal("releases.desktop.checking"))
  try {
    const result = await checkDesktopUpdate()
    notice?.dismiss()
    notice = undefined
    busy = false
    if (result.status === "unsupported") {
      await openExternalUrl(releasesUrl)
    } else if (result.status === "current") {
      notice = showToastNotification({ message: tGlobal("releases.desktop.current"), variant: "success" })
    } else {
      notice = showToastNotification({
        message: tGlobal("releases.desktop.available", { version: result.version }),
        variant: "info", duration: Number.POSITIVE_INFINITY,
        action: {
          label: tGlobal("releases.desktop.install"), href: releasesUrl,
          onClick: () => install(result.version),
        },
      })
    }
  } catch (error) { failed(error) }
}
