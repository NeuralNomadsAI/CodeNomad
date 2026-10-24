import { parse } from "yaml"

const REPOSITORY_URL = "https://github.com/NeuralNomadsAI/CodeNomad"
export const BUG_REPORT_TEMPLATE = "bug_report.yml"
// Issue forms are served from the default branch.
const TEMPLATE_SOURCE_URL = `https://raw.githubusercontent.com/NeuralNomadsAI/CodeNomad/dev/.github/ISSUE_TEMPLATE/${BUG_REPORT_TEMPLATE}`
const TEMPLATE_READ_TIMEOUT_MS = 3000

/** Issue form field id for each prefilled value. GitHub prefills only text
 * fields by id, so each must remain an `input` or `textarea` in the template. */
export const BUG_REPORT_FIELDS = {
  codenomadVersion: "codenomad-version",
  opencodeVersion: "opencode-version",
  operatingSystem: "os-version",
  additionalContext: "extra",
} as const

export type BugReportEnvironment = Record<keyof typeof BUG_REPORT_FIELDS, string>

/** `unknown` keeps the form: only a published template proven incompatible
 * (removed, unparsable or missing a prefilled text field) falls back. */
export type BugReportTemplateStatus = "compatible" | "incompatible" | "unknown"

export function assessBugReportTemplate(source: string): Exclude<BugReportTemplateStatus, "unknown"> {
  let body: unknown
  try { body = (parse(source) as { body?: unknown } | null)?.body } catch { return "incompatible" }
  if (!Array.isArray(body)) return "incompatible"
  const textFields = new Set(body
    .filter((field) => field?.type === "input" || field?.type === "textarea")
    .map((field) => field.id))
  return Object.values(BUG_REPORT_FIELDS).every((id) => textFields.has(id)) ? "compatible" : "incompatible"
}

let settledStatus: Exclude<BugReportTemplateStatus, "unknown"> | undefined
let pendingRead: Promise<BugReportTemplateStatus> | undefined

/** Read the published template, bounded in time. A settled assessment is kept
 * for the renderer; an unknown result (network, server error) is retried. */
export function readBugReportTemplateStatus(fetchImpl: typeof fetch = fetch): Promise<BugReportTemplateStatus> {
  if (settledStatus) return Promise.resolve(settledStatus)
  pendingRead ??= (async (): Promise<BugReportTemplateStatus> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TEMPLATE_READ_TIMEOUT_MS)
    try {
      const response = await fetchImpl(TEMPLATE_SOURCE_URL, { signal: controller.signal, credentials: "omit" })
      if (response.status === 404) return settledStatus = "incompatible"
      if (!response.ok) return "unknown"
      return settledStatus = assessBugReportTemplate(await response.text())
    } catch {
      return "unknown"
    } finally {
      clearTimeout(timer)
    }
  })().finally(() => { pendingRead = undefined })
  return pendingRead
}

/** For the click itself, which must open GitHub within the browser's user
 * activation (about 1 s on WebKit): never wait for a read. Use the settled
 * assessment, else keep the form and refresh in the background. */
export function currentBugReportTemplateStatus(fetchImpl: typeof fetch = fetch): BugReportTemplateStatus {
  if (!settledStatus) void readBugReportTemplateStatus(fetchImpl)
  return settledStatus ?? "unknown"
}

/** Report text stays in English, the language of the issue form. */
export function buildBugReportUrl(environment: BugReportEnvironment, status: BugReportTemplateStatus): string {
  const params = new URLSearchParams()
  if (status === "incompatible") {
    params.set("title", "[Bug]: ")
    params.set("body", [
      "### Issue Summary", "", "", "### Steps to Reproduce", "", "1. ", "", "### Expected Behavior", "", "",
      "### Environment", "",
      `- CodeNomad Version: ${environment.codenomadVersion}`,
      `- OpenCode Version: ${environment.opencodeVersion}`,
      `- Operating System: ${environment.operatingSystem}`,
      environment.additionalContext, "",
    ].join("\n"))
  } else {
    params.set("template", BUG_REPORT_TEMPLATE)
    for (const [key, id] of Object.entries(BUG_REPORT_FIELDS)) {
      const value = environment[key as keyof BugReportEnvironment]
      if (value) params.set(id, value)
    }
  }
  return `${REPOSITORY_URL}/issues/new?${params.toString()}`
}
