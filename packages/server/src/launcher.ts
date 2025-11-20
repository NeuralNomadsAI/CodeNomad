import { spawn } from "child_process"
import os from "os"
import path from "path"
import type { Logger } from "./logger"

interface BrowserCandidate {
  name: string
  command: string
  args: (url: string) => string[]
}

const APP_ARGS = (url: string) => [`--app=${url}`, "--new-window"]

export async function launchInBrowser(url: string, logger: Logger): Promise<boolean> {
  const { platform, candidates, manualExamples } = buildPlatformCandidates(url)

  console.log(`Attempting to launch browser (${platform}) using:`)
  candidates.forEach((candidate) => console.log(`  - ${candidate.name}: ${candidate.command}`))

  for (const candidate of candidates) {
    const success = await tryLaunch(candidate, url, logger)
    if (success) {
      return true
    }
  }

  console.error(
    "No supported browser found to launch. Run without --launch and use one of the commands below or install a compatible browser.",
  )
  if (manualExamples.length > 0) {
    console.error("Manual launch commands:")
    manualExamples.forEach((line) => console.error(`  ${line}`))
  }

  return false
}

async function tryLaunch(candidate: BrowserCandidate, url: string, logger: Logger): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false
    try {
      const args = candidate.args(url)
      const child = spawn(candidate.command, args, { stdio: "ignore", detached: true })

      child.once("error", (error) => {
        if (resolved) return
        resolved = true
        logger.debug({ err: error, candidate: candidate.name, command: candidate.command, args }, "Browser launch failed")
        resolve(false)
      })

      child.once("spawn", () => {
        if (resolved) return
        resolved = true
        logger.info(
          {
            browser: candidate.name,
            command: candidate.command,
            args,
            fullCommand: [candidate.command, ...args].join(" "),
          },
          "Launched browser in app mode",
        )
        child.unref()
        resolve(true)
      })
    } catch (error) {
      if (resolved) return
      resolved = true
      logger.debug({ err: error, candidate: candidate.name, command: candidate.command }, "Browser spawn threw")
      resolve(false)
    }
  })
}

function buildPlatformCandidates(url: string) {
  switch (os.platform()) {
    case "darwin":
      return {
        platform: "macOS",
        candidates: buildMacCandidates(),
        manualExamples: buildMacManualExamples(url),
      }
    case "win32":
      return {
        platform: "Windows",
        candidates: buildWindowsCandidates(),
        manualExamples: buildWindowsManualExamples(url),
      }
    default:
      return {
        platform: "Linux",
        candidates: buildLinuxCandidates(),
        manualExamples: buildLinuxManualExamples(url),
      }
  }
}

function buildMacCandidates(): BrowserCandidate[] {
  const apps = [
    { name: "Google Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    { name: "Google Chrome Canary", path: "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" },
    { name: "Microsoft Edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
    { name: "Brave Browser", path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
    { name: "Chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
    { name: "Vivaldi", path: "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi" },
    { name: "Arc", path: "/Applications/Arc.app/Contents/MacOS/Arc" },
  ]

  return apps.map((entry) => ({ name: entry.name, command: entry.path, args: APP_ARGS }))
}

function buildWindowsCandidates(): BrowserCandidate[] {
  const programFiles = process.env["ProgramFiles"]
  const programFilesX86 = process.env["ProgramFiles(x86)"]
  const localAppData = process.env["LocalAppData"]

  const paths = [
    [programFiles, "Google/Chrome/Application/chrome.exe", "Google Chrome"],
    [programFilesX86, "Google/Chrome/Application/chrome.exe", "Google Chrome (x86)"],
    [localAppData, "Google/Chrome/Application/chrome.exe", "Google Chrome (User)"],
    [programFiles, "Microsoft/Edge/Application/msedge.exe", "Microsoft Edge"],
    [programFilesX86, "Microsoft/Edge/Application/msedge.exe", "Microsoft Edge (x86)"],
    [localAppData, "Microsoft/Edge/Application/msedge.exe", "Microsoft Edge (User)"],
    [programFiles, "BraveSoftware/Brave-Browser/Application/brave.exe", "Brave"],
    [localAppData, "BraveSoftware/Brave-Browser/Application/brave.exe", "Brave (User)"],
    [programFiles, "Chromium/Application/chromium.exe", "Chromium"],
  ] as const

  return paths
    .filter(([root]) => Boolean(root))
    .map(([root, rel, name]) => ({
      name,
      command: path.join(root as string, rel),
      args: APP_ARGS,
    }))
}

function buildLinuxCandidates(): BrowserCandidate[] {
  const names = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "brave-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
    "vivaldi",
  ]

  return names.map((name) => ({ name, command: name, args: APP_ARGS }))
}

function buildMacManualExamples(url: string) {
  return [
    `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --app="${url}" --new-window`,
    `"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" --app="${url}" --new-window`,
    `"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" --app="${url}" --new-window`,
  ]
}

function buildWindowsManualExamples(url: string) {
  return [
    `"%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" --app="${url}" --new-window`,
    `"%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe" --app="${url}" --new-window`,
    `"%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" --app="${url}" --new-window`,
  ]
}

function buildLinuxManualExamples(url: string) {
  return [
    `google-chrome --app="${url}" --new-window`,
    `chromium --app="${url}" --new-window`,
    `brave-browser --app="${url}" --new-window`,
    `microsoft-edge --app="${url}" --new-window`,
  ]
}
