import { Plus, RefreshCw, Trash2 } from "lucide-solid"
import { createMemo, createSignal, For, onMount, Show, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import {
  canManageOtherDataProfiles,
  deleteOtherDataProfiles,
  listOtherDataProfiles,
  normalizeDataProfileName,
  relaunchIntoNextDataProfile,
  setNextLaunchDataProfile,
  type DeleteOtherDataProfilesResult,
  type OtherDataProfile,
  type OtherDataProfilesListing,
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

interface ProfileEntry {
  key: string
  /** The name the next launch would open; "default" for the default profile. */
  name: string
  label: string
  current: boolean
  /** Only profiles of this configuration can be opened by the next launch. */
  choosable: boolean
  /** Another profile, which can be deleted. */
  other?: OtherDataProfile
  sizeBytes: number
  sizeComplete: boolean
  createdAt: number | null
  lastUsedAt: number | null
}

/**
 * The desktop data profiles, folded under the open one in the startup card: every
 * profile with its size, creation and last use, the one the next launch opens chosen
 * by radio (an existing profile or a new name), deletion of the others and a restart
 * into the chosen one. The host lists on mount or explicit refresh, never by polling,
 * and owns every change (lib/native/data-profiles.ts).
 */
export const DataProfilesSettings: Component = () => {
  const { t, locale } = useI18n()
  const key = "settings.appearance.startup.profiles"
  const others = "settings.appearance.startup.otherProfiles"
  const available = canManageOtherDataProfiles()
  const [listing, setListing] = createSignal<OtherDataProfilesListing | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [draftInvalid, setDraftInvalid] = createSignal(false)
  let sequence = 0

  const load = async () => {
    if (!available) return
    const request = ++sequence
    setLoading(true)
    try {
      const listed = await listOtherDataProfiles()
      if (request === sequence) setListing(listed)
    } catch {
      if (request === sequence) showToastNotification({ category: "settings", message: t(`${others}.loadError`), variant: "error" })
    } finally {
      if (request === sequence) setLoading(false)
    }
  }

  onMount(() => void load())

  const displayName = (name: string) => name === "default" ? t(`${key}.default`) : name
  /** The profile key whose folder (`<key>-<hash>`) was listed; "stable" for the default profile. */
  const folderKey = (profile: OtherDataProfile) =>
    profile.kind === "default" ? "stable" : profile.id.replace(/^scope:/, "").replace(/-[0-9a-f]{16}$/, "")
  /**
   * Only a profile whose name leads the next launch back to its own folder can be chosen: a folder
   * made by the `CODENOMAD_UPDATE_CHANNEL` alias, such as `default-<hash>`, is listed under a name
   * that opens another profile, or under no valid name.
   */
  const reachable = (profile: OtherDataProfile) => {
    const name = normalizeDataProfileName(profile.name)
    return profile.kind !== "orphan" && name !== null && folderKey(profile) === (name === "default" ? "stable" : name)
  }
  const label = (profile: OtherDataProfile) => {
    if (profile.kind === "orphan") return t(`${others}.label.orphan`, { name: profile.name })
    const name = folderKey(profile) === "stable" ? t(`${key}.default`) : profile.name
    return profile.otherConfiguration ? t(`${others}.label.otherConfiguration`, { name }) : name
  }
  const size = (bytes: number, complete: boolean) => {
    const formatted = formatProfileSize(bytes, locale())
    return complete ? formatted : t(`${others}.sizeAtLeast`, { size: formatted })
  }
  const date = (value: number, time: boolean) =>
    new Intl.DateTimeFormat(locale(), time ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(value)
  const details = (entry: ProfileEntry) => [
    size(entry.sizeBytes, entry.sizeComplete),
    ...(entry.createdAt === null ? [] : [t(`${key}.created`, { date: date(entry.createdAt, false) })]),
    entry.lastUsedAt === null ? t(`${key}.neverUsed`) : t(`${key}.lastUsed`, { date: date(entry.lastUsedAt, true) }),
  ].join(" · ")

  const entries = createMemo<ProfileEntry[]>(() => {
    const value = listing()
    if (!value) return []
    const { name, sizeBytes, sizeComplete, createdAt, lastUsedAt } = value.current
    const current: ProfileEntry = { key: "current", name, label: displayName(name), current: true, choosable: true, sizeBytes, sizeComplete, createdAt, lastUsedAt }
    // Most recently used first; folders without saved state (unused lock folders) last.
    const rest = [...value.profiles]
      .sort((left, right) => (right.lastUsedAt ?? -1) - (left.lastUsedAt ?? -1))
      .map((profile): ProfileEntry => ({
        key: profile.id,
        name: profile.name,
        label: label(profile),
        current: false,
        choosable: reachable(profile) && !profile.otherConfiguration,
        other: profile,
        sizeBytes: profile.sizeBytes,
        sizeComplete: profile.sizeComplete,
        createdAt: profile.createdAt,
        lastUsedAt: profile.lastUsedAt,
      }))
    return [current, ...rest]
  })
  /** The profile the next launch opens: the remembered choice, else the open one. */
  const next = () => listing()?.nextLaunch ?? listing()?.current.name

  let radios: HTMLDivElement | undefined
  const choose = async (name: string, focusKey?: string) => {
    if (busy()) return
    setBusy(true)
    try {
      const outcome = await setNextLaunchDataProfile(name)
      if (outcome !== "updated") showToastNotification({ category: "settings", message: t(`${key}.chooseError.${outcome}`), variant: "error" })
    } catch {
      showToastNotification({ category: "settings", message: t(`${key}.chooseError.failed`), variant: "error" })
    } finally {
      setBusy(false)
      await load()
      // The refreshed rows replace the radio that had focus; keep keyboard users on the profile they chose.
      if (focusKey) radios?.querySelector<HTMLInputElement>(`input[data-key="${CSS.escape(focusKey)}"]`)?.focus()
    }
  }

  const closeDraft = () => {
    setCreating(false)
    setDraft("")
    setDraftInvalid(false)
  }

  const create = async () => {
    const name = normalizeDataProfileName(draft())
    if (!name) {
      setDraftInvalid(true)
      return
    }
    closeDraft()
    await choose(name === "stable" ? "default" : name)
  }

  const reportResult = (result: DeleteOtherDataProfilesResult, profile: OtherDataProfile) => {
    const name = label(profile)
    const deleted = result.results.filter((entry) => entry.outcome === "deleted").length
    const problems: string[] = []
    for (const entry of result.results) {
      if (entry.outcome === "in-use") problems.push(t(`${others}.result.inUse`, { name }))
      else if (entry.outcome === "unknown") problems.push(t(`${others}.result.unknown`, { name }))
      else if (entry.outcome === "missing") problems.push(t(`${others}.result.missing`, { name }))
      else if (entry.outcome === "incomplete") problems.push(t(`${others}.result.incomplete`, { name, paths: entry.remaining.join(", ") }))
      if (entry.kept.length) problems.push(t(`${others}.result.kept`, { paths: entry.kept.join(", ") }))
    }
    if (result.choices === "busy" || result.choices === "failed") problems.push(t(`${others}.result.choicesNotUpdated`))
    const success = t(`${others}.result.success.${deleted === 1 ? "one" : "other"}`, { count: deleted })
    if (!problems.length) {
      showToastNotification({ category: "settings", message: success, variant: "success" })
      return
    }
    showAlertDialog(`${deleted ? `${success}\n` : ""}${problems.map((line) => `• ${line}`).join("\n")}`, { title: t(`${others}.result.title`), variant: "warning" })
  }

  const remove = async (profile: OtherDataProfile) => {
    if (busy()) return
    const confirmed = await showConfirmDialog(`${label(profile)} — ${size(profile.sizeBytes, profile.sizeComplete)}`, {
      title: t(`${key}.confirmTitle`, { name: label(profile) }),
      // macOS: the Tauri app's WebKit storage is shared by profiles and kept, so the note says so.
      detail: t(`${others}.${listing()?.sharedWebKitStorage ? "confirmNoteMacOS" : "confirmNote"}`),
      variant: "warning",
      confirmLabel: t(`${key}.confirmAction`),
    })
    if (!confirmed) return
    setBusy(true)
    try {
      reportResult(await deleteOtherDataProfiles([profile.id]), profile)
    } catch {
      showToastNotification({ category: "settings", message: t(`${others}.deleteError`), variant: "error" })
    } finally {
      setBusy(false)
      await load()
    }
  }

  /** Restarts only while the next launch still opens `target`: another window may have chosen since this one listed. */
  const restart = async (target: string) => {
    if (busy()) return
    setBusy(true)
    try {
      const request = ++sequence
      const listed = await listOtherDataProfiles()
      if (request === sequence) setListing(listed)
      if (!listed.pinned && (listed.nextLaunch ?? listed.current.name) === target) await relaunchIntoNextDataProfile()
    } catch {
      showToastNotification({ category: "settings", message: t(`${key}.restartError`), variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={available ? listing() : null}>
      {(value) => (
        <details class="settings-disclosure profile-manager" data-testid="data-profiles-settings">
          <summary>{t(`${key}.summary`, { name: displayName(value().current.name) })}</summary>
          <div class="profile-manager-list" role="radiogroup" aria-label={t(`${key}.nextLaunch`)} ref={radios}>
            <For each={entries()}>
              {(entry) => (
                <div class="profile-manager-entry" data-testid="data-profile-entry" data-current={entry.current ? "" : undefined}>
                  <label class="profile-manager-choice">
                    <input
                      type="radio"
                      name="codenomad-next-launch-profile"
                      value={entry.name}
                      data-key={entry.key}
                      checked={entry.choosable && next() === entry.name}
                      disabled={!entry.choosable || value().pinned || busy()}
                      onChange={() => void choose(entry.name, entry.key)}
                    />
                    <span class="profile-manager-text">
                      <span class="profile-manager-name">
                        <span dir="auto">{entry.label}</span>
                        <Show when={entry.current}>
                          <span class="profile-manager-tag">{t(`${key}.open`)}</span>
                        </Show>
                        <Show when={!entry.current && entry.choosable && next() === entry.name}>
                          <span class="profile-manager-tag">{t(`${key}.next`)}</span>
                        </Show>
                      </span>
                      <span class="profile-manager-meta">{details(entry)}</span>
                    </span>
                  </label>
                  <Show when={entry.other}>
                    {(profile) => (
                      <button
                        type="button"
                        class="files-header-icon-button"
                        title={profile().status === "available"
                          ? t(`${key}.delete`, { name: entry.label })
                          : t(`${others}.status.${profile().status === "in-use" ? "inUse" : "unknown"}`)}
                        aria-label={t(`${key}.delete`, { name: entry.label })}
                        disabled={busy() || loading() || profile().status !== "available"}
                        onClick={() => void remove(profile())}
                      >
                        <Trash2 class="h-4 w-4" />
                      </button>
                    )}
                  </Show>
                </div>
              )}
            </For>
          </div>

          <div class="profile-manager-actions">
            <Show
              when={creating()}
              fallback={
                <button
                  type="button"
                  class="selector-button selector-button-secondary w-auto"
                  disabled={value().pinned || busy()}
                  onClick={() => setCreating(true)}
                >
                  <Plus class="h-4 w-4" />
                  {t(`${key}.new`)}
                </button>
              }
            >
              <form class="profile-manager-new" onSubmit={(event) => { event.preventDefault(); void create() }}>
                <input
                  class="selector-input"
                  aria-label={t(`${key}.newName`)}
                  placeholder={t(`${key}.newName`)}
                  aria-invalid={draftInvalid() ? "true" : undefined}
                  value={draft()}
                  ref={(input) => queueMicrotask(() => input.focus())}
                  onInput={(event) => { setDraft(event.currentTarget.value); setDraftInvalid(false) }}
                  onKeyDown={(event) => { if (event.key === "Escape") closeDraft() }}
                />
                <button type="submit" class="selector-button selector-button-primary w-auto">{t(`${key}.create`)}</button>
                <button type="button" class="selector-button selector-button-secondary w-auto" onClick={closeDraft}>{t(`${key}.cancel`)}</button>
              </form>
            </Show>
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
          </div>
          <Show when={draftInvalid()}>
            <div class="settings-error-message" role="alert">{t(`${key}.invalidName`)}</div>
          </Show>

          <Show when={value().pinned}>
            <p class="settings-help-text">{t(`${key}.pinned`)}</p>
          </Show>
          <Show when={!value().pinned && next() !== value().current.name}>
            <div class="profile-manager-restart">
              <button
                type="button"
                class="selector-button selector-button-primary w-auto"
                disabled={busy() || loading()}
                onClick={() => void restart(next() ?? "")}
              >
                {t(`${key}.restart`, { name: displayName(next() ?? "") })}
              </button>
              <span class="settings-help-text">{t(`${key}.restartHint`)}</span>
            </div>
          </Show>
        </details>
      )}
    </Show>
  )
}
