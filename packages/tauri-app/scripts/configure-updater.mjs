#!/usr/bin/env node
// Injects the Tauri updater configuration at build time.
//
// The updater needs a signing key, and its private half must never live in the
// repository. This script therefore writes the updater block into
// tauri.conf.json only when the matching public key is available in the
// environment, so an unsigned build ships without an updater instead of
// shipping an updater that cannot verify anything.
//
// Recognised environment inputs:
//   TAURI_UPDATER_PUBKEY  base64 minisign public key; empty or unset = no updater
//   TAURI_UPDATER_ENDPOINT  endpoint URL; defaults to the GitHub latest.json

import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const scriptsDirectory = fileURLToPath(new URL(".", import.meta.url))
// The Tauri project lives in src-tauri, not at the package root.
export const configPath = join(scriptsDirectory, "..", "src-tauri", "tauri.conf.json")
const DEFAULT_ENDPOINT = "https://github.com/NeuralNomadsAI/CodeNomad/releases/latest/download/latest.json"

export function resolveUpdaterConfig(environment = process.env) {
  const publicKey = (environment.TAURI_UPDATER_PUBKEY ?? "").trim()
  if (!publicKey) return null
  return {
    active: true,
    dialog: false,
    pubkey: publicKey,
    endpoints: [(environment.TAURI_UPDATER_ENDPOINT ?? "").trim() || DEFAULT_ENDPOINT],
  }
}

export function applyUpdaterConfig(config, updater) {
  const next = structuredClone(config)
  if (!updater) {
    // No verifiable key: keep the built application free of an updater entry.
    delete next.plugins?.updater
    return next
  }
  next.plugins = { ...(next.plugins ?? {}), updater }
  return next
}

export function configureUpdater(options = {}) {
  const environment = options.environment ?? process.env
  const targetPath = options.configPath ?? configPath
  let config
  try {
    config = JSON.parse(readFileSync(targetPath, "utf8"))
  } catch (cause) {
    // A wrong path here used to surface as a bare ENOENT inside a build step
    // with no mention of the file the script was looking for.
    throw new Error(
      `cannot read the Tauri configuration at ${targetPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
  }
  const updater = resolveUpdaterConfig(environment)
  writeFileSync(targetPath, `${JSON.stringify(applyUpdaterConfig(config, updater), null, 2)}\n`, "utf8")
  if (updater) {
    console.log(`[updater-config] updater enabled against ${updater.endpoints[0]}`)
  } else {
    console.log("[updater-config] no signing public key in the environment; updater disabled for this build")
  }
  return updater
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("configure-updater.mjs")) {
  configureUpdater()
}
