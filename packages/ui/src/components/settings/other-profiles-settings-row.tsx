import { RefreshCw } from "lucide-solid"
import { createSignal, onMount, Show, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import {
  canManageOtherDataProfiles,
  deleteOtherDataProfiles,
  listOtherDataProfiles,
  type DeleteOtherDataProfilesResult,
  type OtherDataProfile,
} from "../../lib/native/data-profiles"
import { showToastNotification } from "../../lib/notifications"
import { showAlertDialog, showConfirmDialog } from "../../stores/alerts"

const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const

export function formatProfileSize(bytes: number, locale: string): string {
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value)
}

/**
 * Other data profiles on this machine, shown in the Startup card only when
 * some exist. Listing happens when the card mounts or on explicit refresh,
 * never by polling; deletion is host-owned and re-validated there.
 */
export const OtherProfilesSettingsRow: Component = () => {
  const { t, locale } = useI18n()
  const [profiles, setProfiles] = createSignal<OtherDataProfile[]>([])
  const [sharedWebKitStorage, setSharedWebKitStorage] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const available = canManageOtherDataProfiles()
  let sequence = 0
  const key = "settings.appearance.startup.otherProfiles"

  const load = async () => {
    if (!available) return
    const request = ++sequence
    setLoading(true)
    try {
      const listed = await listOtherDataProfiles()
      if (request === sequence) {
        setProfiles(listed.profiles)
        setSharedWebKitStorage(listed.sharedWebKitStorage)
      }
    } catch {
      if (request === sequence) showToastNotification({ message: t(`${key}.loadError`), variant: "error" })
    } finally {
      if (request === sequence) setLoading(false)
    }
  }

  onMount(() => void load())

  const size = (bytes: number, complete: boolean) => {
    const formatted = formatProfileSize(bytes, locale())
    return complete ? formatted : t(`${key}.sizeAtLeast`, { size: formatted })
  }
  const label = (profile: Pick<OtherDataProfile, "kind" | "name" | "otherConfiguration">) => {
    if (profile.kind === "orphan") return t(`${key}.label.orphan`, { name: profile.name })
    return profile.otherConfiguration ? t(`${key}.label.otherConfiguration`, { name: profile.name }) : profile.name
  }
  const summary = () => {
    const list = profiles()
    const total = list.reduce((sum, profile) => sum + profile.sizeBytes, 0)
    const complete = list.every((profile) => profile.sizeComplete)
    return t(`${key}.summary.${list.length === 1 ? "one" : "other"}`, { count: list.length, size: size(total, complete) })
  }
  const statusLabel = (profile: OtherDataProfile) =>
    `${label(profile)} (${t(`${key}.status.${profile.status === "in-use" ? "inUse" : "unknown"}`)})`

  const reportResult = (result: DeleteOtherDataProfilesResult) => {
    const byId = new Map(profiles().map((profile) => [profile.id, profile]))
    const name = (id: string, fallback: string) => {
      const profile = byId.get(id)
      return profile ? label(profile) : fallback
    }
    const deleted = result.results.filter((entry) => entry.outcome === "deleted").length
    const problems: string[] = []
    for (const entry of result.results) {
      const shown = name(entry.id, entry.name)
      if (entry.outcome === "in-use") problems.push(t(`${key}.result.inUse`, { name: shown }))
      else if (entry.outcome === "unknown") problems.push(t(`${key}.result.unknown`, { name: shown }))
      else if (entry.outcome === "missing") problems.push(t(`${key}.result.missing`, { name: shown }))
      else if (entry.outcome === "incomplete") problems.push(t(`${key}.result.incomplete`, { name: shown, paths: entry.remaining.join(", ") }))
      if (entry.kept.length) problems.push(t(`${key}.result.kept`, { paths: entry.kept.join(", ") }))
    }
    if (result.choices === "busy" || result.choices === "failed") problems.push(t(`${key}.result.choicesNotUpdated`))
    if (!problems.length) {
      showToastNotification({ message: t(`${key}.result.success.${deleted === 1 ? "one" : "other"}`, { count: deleted }), variant: "success" })
      return
    }
    const success = deleted ? `${t(`${key}.result.success.${deleted === 1 ? "one" : "other"}`, { count: deleted })}\n` : ""
    showAlertDialog(`${success}${problems.map((line) => `• ${line}`).join("\n")}`, { title: t(`${key}.result.title`), variant: "warning" })
  }

  const confirmDelete = async () => {
    if (busy()) return
    const listed = profiles()
    const deletable = listed.filter((profile) => profile.status === "available")
    const skipped = listed.filter((profile) => profile.status !== "available")
    const skippedLines = skipped.map((profile) => `• ${statusLabel(profile)}`).join("\n")
    if (!deletable.length) {
      showAlertDialog(`${t(`${key}.unavailableMessage`)}\n${skippedLines}`, { title: t(`${key}.unavailableTitle`), variant: "info" })
      return
    }
    const lines = deletable.map((profile) => `• ${label(profile)} — ${size(profile.sizeBytes, profile.sizeComplete)}`).join("\n")
    const message = [t(`${key}.confirmMessage`), lines, ...(skipped.length ? [t(`${key}.confirmSkipped`), skippedLines] : [])].join("\n")
    const confirmed = await showConfirmDialog(message, {
      title: t(`${key}.confirmTitle`),
      // macOS: the Tauri app's WebKit storage is shared by profiles and kept, so the note says so.
      detail: t(`${key}.${sharedWebKitStorage() ? "confirmNoteMacOS" : "confirmNote"}`),
      variant: "warning",
      confirmLabel: t(`${key}.confirmAction.${deletable.length === 1 ? "one" : "other"}`, { count: deletable.length }),
    })
    if (!confirmed) return
    setBusy(true)
    try {
      reportResult(await deleteOtherDataProfiles(deletable.map((profile) => profile.id)))
    } catch {
      showToastNotification({ message: t(`${key}.deleteError`), variant: "error" })
    } finally {
      setBusy(false)
      await load()
    }
  }

  return (
    <Show when={available && profiles().length > 0}>
      <div class="settings-toggle-row" data-testid="other-profiles-settings">
        <div>
          <div class="settings-toggle-title">{t(`${key}.title`)}</div>
          <div class="settings-toggle-caption" data-testid="other-profiles-summary">{summary()}</div>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="files-header-icon-button"
            title={t(`${key}.refresh`)}
            aria-label={t(`${key}.refresh`)}
            disabled={loading() || busy()}
            onClick={() => void load()}
          >
            <RefreshCw class={`h-4 w-4${loading() ? " animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            class="selector-button selector-button-secondary w-auto whitespace-nowrap"
            disabled={loading() || busy()}
            onClick={() => void confirmDelete()}
          >
            {t(`${key}.delete`)}
          </button>
        </div>
      </div>
    </Show>
  )
}
