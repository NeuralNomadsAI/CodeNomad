import type { UpdateFeed } from "../../../server/src/api-types"
import { tGlobal } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { showToastNotification, type ToastHandle } from "../lib/notifications"
import { openExternalUrl } from "../lib/external-url"
import { getServerMeta } from "../lib/server-meta"
import {
  checkDesktopUpdate,
  installDesktopUpdate,
  listenForDesktopUpdateFailure,
  takeDesktopUpdateFailure,
} from "../lib/native/updates"

const releasesUrl = "https://github.com/NeuralNomadsAI/CodeNomad/releases"
const log = getLogger("actions")
let busy = false
/** Only the document whose install was accepted reports live failures. */
let installing = false
/** Toast history retains actions; an older offer re-checks instead of installing. */
let offer = 0
let notice: ToastHandle | undefined
let feed: UpdateFeed | undefined

/** Preview builds are prereleases, which the latest-release page omits. */
const releasePage = () => feed === "preview" ? releasesUrl : `${releasesUrl}/latest`

function showProgress(message: string) {
  notice?.dismiss()
  notice = showToastNotification({ message, variant: "info", duration: Number.POSITIVE_INFINITY })
}

function failed(error?: unknown) {
  busy = false
  installing = false
  notice?.dismiss()
  if (error) log.error("Desktop update failed", error)
  notice = showToastNotification({
    message: tGlobal("releases.desktop.failed"), variant: "error", duration: Number.POSITIVE_INFINITY,
    action: { label: tGlobal("releases.upgradeRequired.action.getUpdate"), href: releasePage() },
  })
}

/** One document reports each native failure, including after a reload. */
async function claimFailure() {
  try {
    if (!await takeDesktopUpdateFailure()) return
    // A reloaded document has not read the feed that selects the release page.
    feed ??= await readFeed()
    failed()
  } catch (error) { log.error("Unable to read the desktop update status", error) }
}

export function observeDesktopUpdates(): () => void {
  let disposed = false
  let unlisten: (() => void) | undefined
  void listenForDesktopUpdateFailure(() => {
    // Only the document that started the update reports it here.
    if (!installing) return
    busy = false
    installing = false
    notice?.dismiss()
    notice = undefined
    void claimFailure()
  }).then((listener) => {
    if (disposed) listener()
    else unlisten = listener
  }).catch((error) => log.error("Unable to observe desktop update failures", error))
  // A failed installer restores the backend, which reloads every window.
  void claimFailure()
  return () => { disposed = true; unlisten?.() }
}

async function install(version: string, checked: number) {
  if (busy) return
  if (checked !== offer) {
    // A retained offer from an earlier check must not consume the current one.
    await requestDesktopUpdate()
    return
  }
  offer++
  busy = true
  installing = true
  showProgress(tGlobal("releases.desktop.downloading"))
  try {
    await installDesktopUpdate(version)
    // A failed renderer flush or installer is reported asynchronously. On
    // success all windows close and the installed application relaunches.
    if (busy) showProgress(tGlobal("releases.desktop.restarting"))
  } catch (error) { failed(error) }
}

async function readFeed(): Promise<UpdateFeed | undefined> {
  try {
    return (await getServerMeta(true)).updateFeed
  } catch (error) {
    log.warn("Unable to read the update feed", error)
    return undefined
  }
}

/** Checks the saved update feed: stable releases, or previews and releases. */
export async function requestDesktopUpdate(): Promise<void> {
  if (busy) return
  busy = true
  showProgress(tGlobal("releases.desktop.checking"))
  const checked = ++offer
  try {
    feed = await readFeed()
    const result = await checkDesktopUpdate(feed)
    notice?.dismiss()
    notice = undefined
    busy = false
    if (result.status === "unsupported") {
      await openExternalUrl(releasePage())
    } else if (result.status === "current") {
      notice = showToastNotification({ message: tGlobal("releases.desktop.current"), variant: "success" })
    } else {
      notice = showToastNotification({
        message: tGlobal("releases.desktop.available", { version: result.version }),
        variant: "info", duration: Number.POSITIVE_INFINITY,
        action: {
          label: tGlobal("releases.desktop.install"), href: releasePage(),
          onClick: () => install(result.version, checked),
        },
      })
    }
  } catch (error) { failed(error) }
}
