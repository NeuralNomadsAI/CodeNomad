import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { ServerMeta } from "../../../../server/src/api-types"
import { buildDiagnosticReport } from "./info-settings-diagnostics"

const labels = {
  reportTitle: "CodeNomad Diagnostic Report",
  generated: "Generated",
  serverVersion: "Server version",
  uiVersion: "UI version",
  uiSource: "UI source",
  runtime: "Runtime",
  platform: "Platform",
  windowContext: "Window context",
  os: "OS",
  listeningMode: "Listening mode",
  bindHost: "Bind host",
  localListener: "Local listener",
  remoteListener: "Remote listener",
  workspaceRoot: "Workspace root",
  candidateAddresses: "Candidate addresses",
  modes: { local: "local", all: "all", specific: "specific" },
  scopes: { external: "external", internal: "internal", loopback: "loopback" },
}

const meta: ServerMeta = {
  localUrl: "http://127.0.0.1:9899",
  remoteUrl: "https://192.168.1.20:9898",
  eventsUrl: "http://127.0.0.1:9899/api/events",
  host: "0.0.0.0",
  listeningMode: "all",
  localPort: 9899,
  remotePort: 9898,
  hostLabel: "0.0.0.0",
  workspaceRoot: "/home/user/projects",
  addresses: [
    { ip: "192.168.1.20", family: "ipv4", scope: "external", remoteUrl: "https://192.168.1.20:9898" },
    { ip: "127.0.0.1", family: "ipv4", scope: "loopback", remoteUrl: "https://127.0.0.1:9898" },
  ],
  serverVersion: "1.2.3",
  ui: { version: "1.2.3", source: "bundled" },
}

describe("buildDiagnosticReport", () => {
  it("includes effective connectivity details and candidate addresses", () => {
    const report = buildDiagnosticReport(
      meta,
      "Linux x86_64",
      { host: "tauri", platform: "desktop", windowContext: "local" },
      labels,
      new Date("2026-08-10T12:00:00.000Z"),
    )

    assert.match(report, /Generated: 2026-08-10T12:00:00\.000Z/)
    assert.match(report, /Listening mode: all/)
    assert.match(report, /Bind host: 0\.0\.0\.0/)
    assert.match(report, /Local listener: http:\/\/127\.0\.0\.1:9899/)
    assert.match(report, /Remote listener: https:\/\/192\.168\.1\.20:9898/)
    assert.match(report, /Candidate addresses: 2/)
    assert.match(report, /ipv4\/external: https:\/\/192\.168\.1\.20:9898/)
  })

  it("uses explicit fallbacks when server metadata is unavailable", () => {
    const report = buildDiagnosticReport(
      null,
      "Unknown",
      { host: "web", platform: "web", windowContext: "remote" },
      labels,
      new Date("2026-08-10T12:00:00.000Z"),
    )

    assert.match(report, /Server version: —/)
    assert.match(report, /Remote listener: —/)
    assert.match(report, /Candidate addresses: 0/)
  })

  it("uses caller-provided labels for exported reports", () => {
    const report = buildDiagnosticReport(
      meta,
      "Linux x86_64",
      { host: "tauri", platform: "desktop", windowContext: "local" },
      {
        ...labels,
        reportTitle: "Rapport de diagnostic CodeNomad",
        generated: "Généré",
        listeningMode: "Mode d’écoute",
        modes: { ...labels.modes, all: "Toutes les interfaces réseau" },
        scopes: { ...labels.scopes, external: "Réseau" },
      },
      new Date("2026-08-10T12:00:00.000Z"),
    )

    assert.match(report, /Rapport de diagnostic CodeNomad/)
    assert.match(report, /Généré: 2026-08-10T12:00:00\.000Z/)
    assert.match(report, /Mode d’écoute: Toutes les interfaces réseau/)
    assert.match(report, /ipv4\/Réseau:/)
  })

  it("identifies a specific interface and omits its unreachable loopback candidate", () => {
    const report = buildDiagnosticReport(
      { ...meta, host: "192.168.1.20", addresses: meta.addresses },
      "Linux x86_64",
      { host: "electron", platform: "desktop", windowContext: "local" },
      labels,
      new Date("2026-08-10T12:00:00.000Z"),
    )

    assert.match(report, /Listening mode: specific/)
    assert.match(report, /Candidate addresses: 1/)
    assert.doesNotMatch(report, /https:\/\/127\.0\.0\.1:9898/)
  })

  it("retains only the configured concrete loopback address", () => {
    const report = buildDiagnosticReport(
      {
        ...meta,
        host: "127.0.0.2",
        listeningMode: "local",
        remoteUrl: "https://127.0.0.2:9898",
        addresses: [
          { ip: "127.0.0.1", family: "ipv4", scope: "loopback", remoteUrl: "https://127.0.0.1:9898" },
          { ip: "127.0.0.2", family: "ipv4", scope: "loopback", remoteUrl: "https://127.0.0.2:9898" },
        ],
      },
      "Windows x64",
      { host: "electron", platform: "desktop", windowContext: "local" },
      labels,
      new Date("2026-08-10T12:00:00.000Z"),
    )

    assert.match(report, /Listening mode: local/)
    assert.match(report, /Candidate addresses: 1/)
    assert.match(report, /https:\/\/127\.0\.0\.2:9898/)
    assert.doesNotMatch(report, /https:\/\/127\.0\.0\.1:9898/)
  })

  it("recognizes expanded IPv6 wildcards and concrete IPv6 loopback binds", () => {
    const wildcard = buildDiagnosticReport(
      { ...meta, host: "0:0:0:0:0:0:0:0", addresses: [] },
      "Linux arm64",
      { host: "tauri", platform: "desktop", windowContext: "local" },
      labels,
      new Date("2026-08-10T12:00:00.000Z"),
    )
    const loopback = buildDiagnosticReport(
      {
        ...meta,
        host: "::1",
        listeningMode: "local",
        remoteUrl: "https://[::1]:9898",
        addresses: [
          { ip: "127.0.0.1", family: "ipv4", scope: "loopback", remoteUrl: "https://127.0.0.1:9898" },
          { ip: "::1", family: "ipv6", scope: "loopback", remoteUrl: "https://[::1]:9898" },
        ],
      },
      "Linux arm64",
      { host: "tauri", platform: "desktop", windowContext: "local" },
      labels,
      new Date("2026-08-10T12:00:00.000Z"),
    )

    assert.match(wildcard, /Listening mode: all/)
    assert.match(loopback, /Listening mode: local/)
    assert.match(loopback, /ipv6\/loopback: https:\/\/\[::1\]:9898/)
    assert.doesNotMatch(loopback, /https:\/\/127\.0\.0\.1:9898/)
  })
})
