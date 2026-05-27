import { createEffect, createMemo, createResource, createSignal, onCleanup, type Component } from "solid-js"
import { Info } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import { getServerMeta } from "../../lib/server-meta"
import { runtimeEnv } from "../../lib/runtime-env"
import type { ServerMeta } from "../../../../server/src/api-types"

interface UserAgentData {
  platform?: string
  getHighEntropyValues?: (hints: string[]) => Promise<Record<string, string>>
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

function buildDiagnosticReport(
  meta: ServerMeta | null,
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
  const [copyFeedback, setCopyFeedback] = createSignal<"success" | "error" | null>(null)
  const [osArch, setOsArch] = createSignal<string | null>(null)

  createEffect(() => {
    resolveArchitecture().then((arch) => {
      if (arch) setOsArch(arch)
    })
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

  const handleCopy = async () => {
    const report = buildDiagnosticReport(meta() ?? null, osDisplay())
    const ok = await copyToClipboard(report)
    if (ok) setCopyFeedback("success")
    else setCopyFeedback("error")
  }

  const handleDownload = () => {
    const report = buildDiagnosticReport(meta() ?? null, osDisplay())
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
