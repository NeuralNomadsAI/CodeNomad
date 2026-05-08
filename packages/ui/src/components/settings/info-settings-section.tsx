import { Select } from "@kobalte/core/select"
import { createEffect, createMemo, createResource, createSignal, onCleanup, type Component } from "solid-js"
import { ChevronDown, Info } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import { getServerMeta } from "../../lib/server-meta"
import { runtimeEnv } from "../../lib/runtime-env"
import { instances, getInstanceLogs } from "../../stores/instances"
import type { ServerMeta } from "../../../../server/src/api-types"

type LogScope = "summary" | "summary_logs"

interface LogScopeOption {
  value: LogScope
  label: string
}

interface UserAgentData {
  platform?: string
  getHighEntropyValues?: (hints: string[]) => Promise<Record<string, string>>
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "sk-***"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "***"],
  [/Bearer\s+[A-Za-z0-9._=-]{20,}/g, "Bearer ***"],
  [/xox[bprs]-\d+-[A-Za-z0-9]+/g, "xox*-***"],
  [/[?&](token|key|secret|password|passwd|auth)=[^&\s]+/g, "$1=***"],
  [/[?&](api_?key|apikey)=[^&\s]+/g, "$1=***"],
  [/^([A-Z][A-Z0-9_]*_?(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*.+/gim, "$1=***"],
  [/(\b(?:api_?key|apikey|authToken|accessToken|refreshToken|secret)\b)\s*[:=]\s*["'][^"']{8,}["']/gi, "$1=***"],
  [/(\b(?:api_?key|apikey|authToken|accessToken|refreshToken|secret)\b)\s*[:=]\s*\S{8,}/gi, "$1=***"],
]

function redactSecrets(text: string): string {
  let result = text
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

function getUserAgentData(): UserAgentData | undefined {
  return (navigator as any).userAgentData
}

function detectOs(): string {
  if (typeof navigator === "undefined") return "Unknown"

  const uaData = getUserAgentData()
  if (uaData?.platform) {
    const arch = extractArchFromUA(navigator.userAgent)
    return arch ? `${uaData.platform} ${arch}` : uaData.platform
  }

  const ua = navigator.userAgent
  const p = navigator.platform
  if (!p) return "Unknown"

  const maybeArch = extractArchFromUA(ua)
  if (maybeArch && !p.includes(maybeArch)) {
    return `${p} ${maybeArch}`
  }
  return p
}

function extractArchFromUA(ua: string): string | null {
  const match = ua.match(/Linux\s+(x86_64|aarch64|armv[0-9]+[a-z]*|i[3-6]86)/i)
    ?? ua.match(/Win64;\s*(x64|arm64)/i)
    ?? ua.match(/Mac\s*OS\s*X[^)]*?_(x86_64|arm64)/i)
  return match ? match[1] : null
}

async function resolveArchitecture(): Promise<string | null> {
  try {
    const uaData = getUserAgentData()
    if (!uaData?.getHighEntropyValues) return null
    const values = await uaData.getHighEntropyValues(["architecture", "bitness"])
    const parts: string[] = []
    if (values.architecture && !values.architecture.startsWith("x86")) {
      parts.push(values.architecture)
    }
    if (values.bitness && values.bitness !== "64") {
      parts.push(`${values.bitness}-bit`)
    }
    if (!parts.length && values.architecture) {
      parts.push(values.architecture)
    }
    return parts.length > 0 ? parts.join(" ") : null
  } catch {
    return null
  }
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString()
}

function buildDiagnosticReport(
  meta: ServerMeta | null,
  scope: LogScope,
  osDisplay: string,
): string {
  const lines: string[] = []
  lines.push("CodeNomad Diagnostic Report")
  lines.push("============================")
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push(`Server version: ${meta?.serverVersion ?? "unknown"}`)
  lines.push(`UI version: ${meta?.ui?.version ?? "unknown"} (source: ${meta?.ui?.source ?? "unknown"})`)
  lines.push(`Runtime: ${runtimeEnv.host}`)
  lines.push(`Platform: ${runtimeEnv.platform}`)
  lines.push(`Window context: ${runtimeEnv.windowContext}`)
  lines.push(`OS: ${osDisplay}`)
  lines.push(`Server URL: ${meta?.localUrl ?? "unknown"}`)
  lines.push(`Workspace root: ${meta?.workspaceRoot ?? "unknown"}`)
  lines.push(`UI source: ${meta?.ui?.source ?? "unknown"}`)

  if (scope === "summary_logs") {
    lines.push("")
    lines.push("NOTE: Common secret patterns have been redacted from log entries below.")
    lines.push("      Review the output before sharing to ensure no sensitive data remains.")
    lines.push("============================")
    const instanceEntries = instances()
    if (instanceEntries.size === 0) {
      lines.push("")
      lines.push("--- No active instances ---")
    }

    for (const [instanceId, instance] of instanceEntries) {
      const logs = getInstanceLogs(instanceId)
      const label = instance.metadata?.project?.name ?? instance.folder ?? instanceId
      lines.push("")
      lines.push(`--- Workspace: ${label} (last 500 entries) ---`)
      const recent = logs.slice(-500)
      if (recent.length === 0) {
        lines.push("  (no log entries)")
      } else {
        for (const entry of recent) {
          const ts = formatTimestamp(entry.timestamp)
          lines.push(`  [${ts}] [${entry.level}] ${redactSecrets(entry.message)}`)
        }
      }
    }
  }

  lines.push("")
  return lines.join("\n")
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function downloadTextFile(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  // Note: anchor.click() may display a native download dialog.
  // If the dialog blocks (user cancel or confirm), removeChild
  // below won't execute until the dialog closes. The anchor element
  // temporarily remains in document.body. This is harmless at the
  // scale of an infrequent settings action.
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function extractReleasePrefix(version: string): string {
  return version.replace(/^v/, "").split("-")[0]
}

function versionNewer(current: string, latest: string): boolean | null {
  const c = extractReleasePrefix(current).split(".").map(Number)
  const l = extractReleasePrefix(latest).split(".").map(Number)
  if (c.some(isNaN) || l.some(isNaN)) return null
  if (l[0] > c[0]) return true
  if (l[0] < c[0]) return false
  if (l[1] > c[1]) return true
  if (l[1] < c[1]) return false
  if (l[2] > c[2]) return true
  return false
}

export const InfoSettingsSection: Component = () => {
  const { t } = useI18n()
  const [meta, { mutate }] = createResource(() => getServerMeta())
  const [logScope, setLogScope] = createSignal<LogScope>("summary")
  const [copyFeedback, setCopyFeedback] = createSignal<"success" | "error" | null>(null)
  const [osArch, setOsArch] = createSignal<string | null>(null)
  const [logExportConfirmed, setLogExportConfirmed] = createSignal(false)

  createEffect(() => {
    resolveArchitecture().then((arch) => {
      if (arch) setOsArch(arch)
    })
  })

  const scopeOptions = createMemo<LogScopeOption[]>(() => [
    { value: "summary", label: t("settings.info.diagnostics.scope.summary") },
    { value: "summary_logs", label: t("settings.info.diagnostics.scope.withLogs") },
  ])

  const selectedScope = createMemo(() =>
    scopeOptions().find((opt) => opt.value === logScope()),
  )

  createEffect(() => {
    const current = logScope()
    if (current !== "summary_logs") {
      setLogExportConfirmed(false)
    }
  })

  const updateInfo = createMemo(() => {
    const m = meta()
    if (!m?.update) return null
    return m.update
  })

  const supportInfo = createMemo(() => meta()?.support ?? null)

  const latestVersion = createMemo(() => {
    const update = updateInfo()
    if (update?.version) return update.version
    return supportInfo()?.latestServerVersion ?? null
  })

  const showDownloadLink = createMemo(() => {
    let url: string | null = null
    const update = updateInfo()
    if (update?.url) url = update.url
    else if (supportInfo()?.latestServerUrl) url = supportInfo()!.latestServerUrl ?? null
    if (!url) return { url: null, show: false }
    if (update?.url) return { url, show: true }
    const current = meta()?.serverVersion
    const latest = latestVersion()
    if (!current || !latest) return { url: null, show: false }
    return { url, show: versionNewer(current, latest) !== false }
  })

  let feedbackTimer: ReturnType<typeof setTimeout> | undefined

  createEffect(() => {
    if (copyFeedback()) {
      clearTimeout(feedbackTimer)
      feedbackTimer = setTimeout(() => setCopyFeedback(null), 2500)
    }
  })

  onCleanup(() => clearTimeout(feedbackTimer))

  const handleRefresh = async () => {
    const fresh = await getServerMeta(true)
    mutate(fresh)
  }

  const osDisplay = createMemo(() => {
    const base = detectOs()
    const arch = osArch()
    return arch ? `${base} (${arch})` : base
  })

  const canExport = createMemo(() => {
    if (logScope() === "summary_logs") return logExportConfirmed()
    return true
  })

  const handleCopy = async () => {
    const report = buildDiagnosticReport(meta() ?? null, logScope(), osDisplay())
    const ok = await copyToClipboard(report)
    if (ok) setCopyFeedback("success")
    else setCopyFeedback("error")
  }

  const handleDownload = () => {
    const report = buildDiagnosticReport(meta() ?? null, logScope(), osDisplay())
    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    downloadTextFile(`codenomad-diagnostics-${ts}.txt`, report)
  }

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <Info class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">{t("settings.section.info.title")}</h3>
              <p class="settings-card-subtitle">{t("settings.section.info.subtitle")}</p>
            </div>
          </div>
        </div>

        <div class="settings-info-grid">
          <div class="settings-info-row">
            <span class="settings-info-label">{t("settings.info.version.server")}</span>
            <span class="settings-info-value">{meta()?.serverVersion ?? "—"}</span>
          </div>
          <div class="settings-info-row">
            <span class="settings-info-label">{t("settings.info.version.ui")}</span>
            <span class="settings-info-value">{meta()?.ui?.version ?? "—"}</span>
          </div>
          <div class="settings-info-row">
            <span class="settings-info-label">{t("settings.info.version.uiSource")}</span>
            <span class="settings-info-value settings-info-value-muted">
              {meta()?.ui?.source ?? "—"}
            </span>
          </div>
          <div class="settings-info-row">
            <span class="settings-info-label">{t("settings.info.runtime.type")}</span>
            <span class="settings-info-value">{runtimeEnv.host}</span>
          </div>
          <div class="settings-info-row">
            <span class="settings-info-label">{t("settings.info.runtime.platform")}</span>
            <span class="settings-info-value">{runtimeEnv.platform}</span>
          </div>
          <div class="settings-info-row">
            <span class="settings-info-label">{t("settings.info.runtime.os")}</span>
            <span class="settings-info-value settings-info-value-muted">{osDisplay()}</span>
          </div>
          <div class="settings-info-row">
            <span class="settings-info-label">{t("settings.info.server.url")}</span>
            <span class="settings-info-value settings-info-value-muted">
              {meta()?.localUrl ?? "—"}
            </span>
          </div>
          <div class="settings-info-row">
            <span class="settings-info-label">{t("settings.info.server.root")}</span>
            <span class="settings-info-value settings-info-value-muted">
              {meta()?.workspaceRoot ?? "—"}
            </span>
          </div>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.info.updates.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.info.updates.subtitle")}</p>
          </div>
        </div>

        <div class="settings-info-grid">
          <div class="settings-info-row">
            <span class="settings-info-label">{t("settings.info.version.server")}</span>
            <span class="settings-info-value">{meta()?.serverVersion ?? "—"}</span>
          </div>
          <div class="settings-info-row">
            <span class="settings-info-label">{t("settings.info.updates.latest")}</span>
            <span class="settings-info-value settings-info-value-muted">
              {latestVersion() ?? "—"}
            </span>
          </div>
        </div>

        <div class="settings-info-actions">
          {showDownloadLink().show && (
            <a
              href={showDownloadLink().url!}
              target="_blank"
              rel="noopener noreferrer"
              class="settings-pill-button"
            >
              {t("settings.info.updates.download")}
            </a>
          )}
          <button
            type="button"
            class="settings-pill-button"
            onClick={handleRefresh}
            disabled={meta.loading}
          >
            {t("settings.info.updates.refresh")}
          </button>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.info.diagnostics.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.info.diagnostics.subtitle")}</p>
          </div>
        </div>

        <div class="settings-info-select-row">
          <span class="settings-info-select-label">{t("settings.info.diagnostics.scope.label")}</span>
          <Select<LogScopeOption>
            value={selectedScope()}
            onChange={(opt) => {
              if (opt) setLogScope(opt.value)
            }}
            options={scopeOptions()}
            optionValue="value"
            optionTextValue="label"
            itemComponent={(itemProps) => (
              <Select.Item item={itemProps.item} class="selector-option">
                <Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.label}</Select.ItemLabel>
              </Select.Item>
            )}
          >
            <Select.Trigger class="selector-trigger" aria-label={t("settings.info.diagnostics.scope.label")}>
              <div class="flex-1 min-w-0">
                <Select.Value<LogScopeOption>>
                  {(state) => (
                    <span class="selector-trigger-primary selector-trigger-primary--align-left">
                      {state.selectedOption()?.label}
                    </span>
                  )}
                </Select.Value>
              </div>
              <Select.Icon class="selector-trigger-icon">
                <ChevronDown class="w-3 h-3" />
              </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Content class="selector-popover">
                <Select.Listbox class="selector-listbox" />
              </Select.Content>
            </Select.Portal>
          </Select>
        </div>

        {logScope() === "summary_logs" && (
          <>
            <div class="settings-card-message" role="alert">
              {t("settings.info.diagnostics.warning")}
            </div>
            <div class="settings-checkbox-toggle">
              <input
                type="checkbox"
                id="log-export-confirm"
                checked={logExportConfirmed()}
                onChange={(e) => setLogExportConfirmed(e.currentTarget.checked)}
              />
              <label for="log-export-confirm">{t("settings.info.diagnostics.confirm")}</label>
            </div>
          </>
        )}

        <div class="settings-info-actions">
          <button
            type="button"
            class="settings-pill-button"
            onClick={handleCopy}
            disabled={!canExport()}
          >
            {t("settings.info.diagnostics.copy")}
          </button>
          <button
            type="button"
            class="settings-pill-button"
            onClick={handleDownload}
            disabled={!canExport()}
          >
            {t("settings.info.diagnostics.download")}
          </button>
        </div>

        {copyFeedback() === "success" && (
          <div class="settings-info-toast" role="status" aria-live="polite">
            {t("settings.info.diagnostics.copied")}
          </div>
        )}
        {copyFeedback() === "error" && (
          <div class="settings-error-message" role="alert">
            {t("settings.info.diagnostics.copyFailed")}
          </div>
        )}
      </div>
    </div>
  )
}
