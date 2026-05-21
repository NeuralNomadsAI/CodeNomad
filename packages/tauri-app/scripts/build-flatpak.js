#!/usr/bin/env node
const fs = require("fs")
const path = require("path")
const { spawnSync } = require("child_process")

const root = path.resolve(__dirname, "..")
const workspaceRoot = path.resolve(root, "..", "..")
const version = process.env.VERSION || require(path.join(root, "package.json")).version
const appId = "ai.neuralnomads.codenomad.client"
const buildRoot = path.join(root, "target", "flatpak")
const stagingRoot = path.join(buildRoot, "staging")
const repoRoot = path.join(buildRoot, "repo")
const flatpakBuildRoot = path.join(buildRoot, "build")
const manifestPath = path.join(buildRoot, `${appId}.json`)
const artifactDir = path.join(root, "target", "release", "bundle", "flatpak")
const artifactPath = path.join(artifactDir, `CodeNomad-Tauri-linux-x64-${version}.flatpak`)
const desktopSource = path.join(root, "src-tauri", "icons", "linux", `${appId}.desktop`)

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
fs.mkdirSync(artifactDir, { recursive: true })

copyRequired(path.join(root, "target", "release", "codenomad-tauri"), path.join(stagingRoot, "codenomad-tauri"))
copyRequired(path.join(root, "target", "release", "resources"), path.join(stagingRoot, "resources"))
copyRequired(
  path.join(root, "src-tauri", "icons", "linux", "512x512.png"),
  path.join(stagingRoot, "codenomad-tauri.png"),
)
copyRequired(desktopSource, path.join(stagingRoot, `${appId}.desktop`))

const manifest = {
  "app-id": appId,
  runtime: "org.gnome.Platform",
  "runtime-version": "46",
  sdk: "org.gnome.Sdk",
  branch: "stable",
  command: "codenomad-tauri",
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
      name: "codenomad-tauri",
      "buildsystem": "simple",
      "build-commands": [
        "install -Dm755 codenomad-tauri /app/bin/codenomad-tauri",
        "mkdir -p /app/lib/CodeNomad",
        "cp -a resources /app/lib/CodeNomad/resources",
        `install -Dm644 ${appId}.desktop /app/share/applications/${appId}.desktop`,
        "install -Dm644 codenomad-tauri.png /app/share/icons/hicolor/512x512/apps/codenomad-tauri.png",
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
