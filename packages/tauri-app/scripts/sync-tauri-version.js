#!/usr/bin/env node

const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const packageJsonPath = path.join(root, "package.json")
const cargoTomlPath = path.join(root, "src-tauri", "Cargo.toml")
const cargoLockPath = path.join(root, "Cargo.lock")
const tauriConfigPath = path.join(root, "src-tauri", "tauri.conf.json")

function readPackageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("Missing version in packages/tauri-app/package.json")
  }
  return packageJson.version
}

function syncCargoToml(version) {
  const current = fs.readFileSync(cargoTomlPath, "utf8")
  const packageVersionPattern = /(\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m
  const match = current.match(packageVersionPattern)

  if (!match) {
    throw new Error("Unable to find [package] version in packages/tauri-app/src-tauri/Cargo.toml")
  }

  if (match[2] === version) {
    return false
  }

  const updated = current.replace(packageVersionPattern, (_, prefix, __, suffix) => `${prefix}${version}${suffix}`)
  fs.writeFileSync(cargoTomlPath, updated)
  return true
}

function syncCargoLock(version) {
  if (!fs.existsSync(cargoLockPath)) {
    return false
  }

  const current = fs.readFileSync(cargoLockPath, "utf8")
  const packageVersionPattern = /(\[\[package\]\]\r?\nname = "codenomad-tauri"\r?\nversion = ")([^"]+)(")/
  const match = current.match(packageVersionPattern)

  if (!match) {
    throw new Error("Unable to find codenomad-tauri version in packages/tauri-app/Cargo.lock")
  }

  if (match[2] === version) {
    return false
  }

  const updated = current.replace(packageVersionPattern, (_, prefix, __, suffix) => `${prefix}${version}${suffix}`)
  fs.writeFileSync(cargoLockPath, updated)
  return true
}

function syncTauriConfig(version) {
  const current = fs.readFileSync(tauriConfigPath, "utf8")
  const config = JSON.parse(current)
  if (config.version === version) {
    return false
  }

  config.version = version
  fs.writeFileSync(tauriConfigPath, `${JSON.stringify(config, null, 2)}\n`)
  return true
}

function main() {
  const version = readPackageVersion()
  const changed = []

  if (syncCargoToml(version)) {
    changed.push(path.relative(root, cargoTomlPath))
  }

  if (syncCargoLock(version)) {
    changed.push(path.relative(root, cargoLockPath))
  }

  if (syncTauriConfig(version)) {
    changed.push(path.relative(root, tauriConfigPath))
  }

  if (changed.length === 0) {
    console.log(`[sync-tauri-version] already aligned to ${version}`)
    return
  }

  console.log(`[sync-tauri-version] synced ${version} -> ${changed.join(", ")}`)
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[sync-tauri-version] failed: ${message}`)
  process.exit(1)
}
