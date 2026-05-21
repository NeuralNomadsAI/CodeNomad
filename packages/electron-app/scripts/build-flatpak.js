#!/usr/bin/env node

import fs from "fs"
import path from "path"
import { spawnSync } from "child_process"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
const workspaceRoot = path.resolve(root, "..", "..")
const version = process.env.VERSION || JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version
const appId = "ai.neuralnomads.codenomad.client"
const releaseRoot = path.join(root, "release")
const appSource = path.join(releaseRoot, "linux-unpacked")
const buildRoot = path.join(root, "target", "flatpak")
const stagingRoot = path.join(buildRoot, "staging")
const repoRoot = path.join(buildRoot, "repo")
const flatpakBuildRoot = path.join(buildRoot, "build")
const manifestPath = path.join(buildRoot, `${appId}.electron.json`)
const artifactPath = path.join(releaseRoot, `CodeNomad-Electron-linux-x64-${version}.flatpak`)

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${result.status || 1}`)
  }
}

function copyRequired(from, to) {
  if (!fs.existsSync(from)) {
    throw new Error(`Missing required Flatpak input: ${from}`)
  }
  fs.cpSync(from, to, { recursive: true, dereference: true })
}

fs.rmSync(buildRoot, { recursive: true, force: true })
fs.mkdirSync(stagingRoot, { recursive: true })
fs.mkdirSync(releaseRoot, { recursive: true })

copyRequired(appSource, path.join(stagingRoot, "CodeNomad"))
copyRequired(path.join(root, "electron", "resources", "server", "public", "pwa-512x512.png"), path.join(stagingRoot, `${appId}.png`))

fs.writeFileSync(
  path.join(stagingRoot, `${appId}.desktop`),
  [
    "[Desktop Entry]",
    "Type=Application",
    "Name=CodeNomad",
    "Exec=codenomad-electron",
    `Icon=${appId}`,
    "Terminal=false",
    "Categories=Development;IDE;",
    "StartupWMClass=CodeNomad",
    "",
  ].join("\n"),
)

fs.writeFileSync(
  path.join(stagingRoot, "codenomad-electron"),
  [
    "#!/bin/sh",
    "exec /app/CodeNomad/CodeNomad \"$@\"",
    "",
  ].join("\n"),
  { mode: 0o755 },
)

const manifest = {
  "app-id": appId,
  runtime: "org.freedesktop.Platform",
  "runtime-version": "24.08",
  sdk: "org.freedesktop.Sdk",
  branch: "stable",
  command: "codenomad-electron",
  "finish-args": [
    "--socket=wayland",
    "--socket=x11",
    "--share=ipc",
    "--device=dri",
    "--socket=pulseaudio",
    "--filesystem=home",
    "--share=network",
    "--talk-name=org.freedesktop.Notifications",
  ],
  modules: [
    {
      name: "codenomad-electron",
      buildsystem: "simple",
      "build-commands": [
        "mkdir -p /app/CodeNomad",
        "cp -a CodeNomad/. /app/CodeNomad/",
        "install -Dm755 codenomad-electron /app/bin/codenomad-electron",
        `install -Dm644 ${appId}.desktop /app/share/applications/${appId}.desktop`,
        `install -Dm644 ${appId}.png /app/share/icons/hicolor/512x512/apps/${appId}.png`,
      ],
      sources: [
        {
          type: "dir",
          path: stagingRoot,
        },
      ],
    },
  ],
}

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
fs.rmSync(repoRoot, { recursive: true, force: true })
fs.rmSync(flatpakBuildRoot, { recursive: true, force: true })
fs.rmSync(artifactPath, { force: true })

run("flatpak-builder", ["--force-clean", `--repo=${repoRoot}`, flatpakBuildRoot, manifestPath], {
  cwd: workspaceRoot,
})
run("flatpak", ["build-bundle", repoRoot, artifactPath, appId, "stable"], {
  cwd: workspaceRoot,
})

console.log(`[flatpak] wrote ${artifactPath}`)
