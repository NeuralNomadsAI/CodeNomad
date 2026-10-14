import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import { assessBugReportTemplate, BUG_REPORT_FIELDS, BUG_REPORT_TEMPLATE, buildBugReportUrl, currentBugReportTemplateStatus, readBugReportTemplateStatus } from "./bug-report"

const template = readFileSync(new URL(`../../../../.github/ISSUE_TEMPLATE/${BUG_REPORT_TEMPLATE}`, import.meta.url), "utf8")
const environment = {
  codenomadVersion: "0.20.1 (UI 0.20.2)",
  opencodeVersion: "2.0.29",
  operatingSystem: "Windows x64",
  additionalContext: "- Client: Tauri (desktop, local window)",
}

describe("bug report issue form", () => {
  it("prefills only text fields that the repository's issue form defines", () => {
    // Renaming or retyping a prefilled field must update BUG_REPORT_FIELDS too.
    assert.equal(assessBugReportTemplate(template), "compatible")
  })

  it("detects a published form that no longer accepts every prefilled value", () => {
    const id = BUG_REPORT_FIELDS.opencodeVersion
    assert.equal(assessBugReportTemplate(template.replace(`id: ${id}`, "id: runtime-version")), "incompatible")
    assert.equal(assessBugReportTemplate(template.replace(/type: input(\s+id: os-version)/, "type: dropdown$1")), "incompatible")
    assert.equal(assessBugReportTemplate("body: [unclosed"), "incompatible")
    assert.equal(assessBugReportTemplate("name: Bug"), "incompatible")
  })

  it("opens the issue form with field prefills, or a blank issue carrying the same report", () => {
    const form = new URL(buildBugReportUrl(environment, "compatible"))
    assert.equal(form.origin + form.pathname, "https://github.com/NeuralNomadsAI/CodeNomad/issues/new")
    assert.equal(form.searchParams.get("template"), BUG_REPORT_TEMPLATE)
    assert.equal(form.searchParams.get("codenomad-version"), environment.codenomadVersion)
    assert.equal(form.searchParams.get("opencode-version"), environment.opencodeVersion)
    assert.equal(form.searchParams.get("os-version"), environment.operatingSystem)
    assert.equal(form.searchParams.get("extra"), environment.additionalContext)
    assert.equal(form.searchParams.has("body"), false)
    assert.equal(buildBugReportUrl(environment, "unknown"), form.href)

    const blank = new URL(buildBugReportUrl(environment, "incompatible"))
    assert.equal(blank.searchParams.has("template"), false)
    assert.equal(blank.searchParams.get("title"), "[Bug]: ")
    const body = blank.searchParams.get("body") ?? ""
    for (const value of Object.values(environment)) assert.ok(body.includes(value), value)
    assert.match(body, /### Steps to Reproduce/)
  })

  it("never makes the click wait, falls back only on a proven incompatible form and retries unknown reads", async () => {
    const urls: string[] = []
    const failing = (async (url: string) => { urls.push(url); throw new TypeError("offline") }) as unknown as typeof fetch
    assert.equal(await readBugReportTemplateStatus(failing), "unknown")

    // The click keeps the form at once while its background read is still pending.
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const removed = (async (url: string) => { urls.push(url); await held; return new Response("", { status: 404 }) }) as unknown as typeof fetch
    assert.equal(currentBugReportTemplateStatus(removed), "unknown")
    assert.equal(currentBugReportTemplateStatus(removed), "unknown")
    assert.equal(urls.length, 2, "a pending read is shared, not restarted")
    release()
    assert.equal(await readBugReportTemplateStatus(failing), "incompatible")
    assert.equal(currentBugReportTemplateStatus(failing), "incompatible", "a settled assessment is reused")
    assert.equal(urls.length, 2)
    assert.equal(urls[0], `https://raw.githubusercontent.com/NeuralNomadsAI/CodeNomad/dev/.github/ISSUE_TEMPLATE/${BUG_REPORT_TEMPLATE}`)
  })
})
