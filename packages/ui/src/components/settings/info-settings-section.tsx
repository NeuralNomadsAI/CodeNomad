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

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "sk-***"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "$&-redacted"],
  [/Bearer\s+[A-Za-z0-9._=-]{20,}/g, "Bearer ***"],
  [/xox[bprs]-\d+-[A-Za-z0-9]+/g, "xox*-***"],
  [/[?&](token|key|secret|password|passwd|auth)=[^&\s]+/g, "$1=***"],
  [/[?&](api_?key|apikey)=[^&\s]+/g, "$1=***"],
  [/^([A-Z][A-Z0-9_]*_?(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*.+/gim, "$1=***"],
  [/(?:["'])?(?:apiKey|api_key|apikey|authToken|auth_token|accessToken|access_token)(?:["'])?\s*[:=]\s*["'][^"']{8,}["']/gi, "$&"],
]

function redactSecrets(text: string): string {
  let result = text
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

function detectOs(): string {
  if (typeof navigator === "undefined") return "Unknown"

  const uaData = (navigator as any).userAgentData
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
    const uaData = (navigator as any).userAgentData
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
  lines.push(`OS: ${detectOs()}`)
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
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export const InfoSettingsSection: Component = () => {
  const { t } = useI18n()
  const [meta, { refetch }] = createResource(() => getServerMeta())
  const [logScope, setLogScope] = createSignal<LogScope>("summary")
  const [copyFeedback, setCopyFeedback] = createSignal<"success" | "error" | null>(null)
  const [osArch, setOsArch] = createSignal<string | null>(null)

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

  const updateInfo = createMemo(() => {
    const m = meta()
    if (!m?.update) return null
    return m.update
  })

  const supportInfo = createMemo(() => meta()?.support ?? null)

  const updateUrl = createMemo(() => {
    const update = updateInfo()
    if (update?.url) return update.url
    return supportInfo()?.latestServerUrl ?? null
  })

  const latestVersion = createMemo(() => {
    const update = updateInfo()
    if (update?.version) return update.version
    return supportInfo()?.latestServerVersion ?? null
  })

  const updateAvailable = createMemo(() => {
    if (updateInfo()) return true
    const support = supportInfo()
    if (!support?.latestServerVersion || !support?.supported) return false
    const current = meta()?.serverVersion
    if (!current) return false
    try {
      const [cMaj, cMin, cPatch] = current.split(".").map(Number)
      const [lMaj, lMin, lPatch] = support.latestServerVersion.split(".").map(Number)
      if (lMaj > cMaj) return true
      if (lMaj === cMaj && lMin > cMin) return true
      if (lMaj === cMaj && lMin === cMin && lPatch > cPatch) return true
    } catch { /* ignore parse errors */ }
    return false
  })

  let feedbackTimer: ReturnType<typeof setTimeout> | undefined

  createEffect(() => {
    if (copyFeedback()) {
      clearTimeout(feedbackTimer)
      feedbackTimer = setTimeout(() => setCopyFeedback(null), 2500)
    }
  })

  onCleanup(() => clearTimeout(feedbackTimer))

  const handleCopy = async () => {
    const report = buildDiagnosticReport(meta() ?? null, logScope())
    const ok = await copyToClipboard(report)
    if (ok) setCopyFeedback("success")
    else setCopyFeedback("error")
  }

  const handleDownload = () => {
    const report = buildDiagnosticReport(meta() ?? null, logScope())
    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    downloadTextFile(`codenomad-diagnostics-${ts}.txt`, report)
  }

  const osDisplay = createMemo(() => {
    const base = detectOs()
    const arch = osArch()
    return arch ? `${base} (${arch})` : base
  })

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
          {updateAvailable() && updateUrl() && (
            <a
              href={updateUrl()!}
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
            onClick={() => { refetch() }}
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
          <div class="settings-card-message" role="alert">
            {t("settings.info.diagnostics.warning")}
          </div>
        )}

        <div class="settings-info-actions">
          <button
            type="button"
            class="settings-pill-button"
            onClick={handleCopy}
          >
            {t("settings.info.diagnostics.copy")}
          </button>
          <button
            type="button"
            class="settings-pill-button"
            onClick={handleDownload}
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
