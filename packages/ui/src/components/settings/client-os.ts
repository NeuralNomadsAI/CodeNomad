interface UserAgentData {
  platform?: string
  getHighEntropyValues?: (hints: string[]) => Promise<Record<string, string>>
}

export interface ClientNavigator {
  platform?: string
  userAgent?: string
  userAgentData?: UserAgentData
}

/** User-Agent Client Hints (Chromium: Electron, WebView2/Tauri on Windows). */
export interface ClientOsHints {
  platformVersion?: string
  architecture?: string
  bitness?: string
}

export async function readClientOsHints(nav: ClientNavigator = navigator as ClientNavigator): Promise<ClientOsHints | null> {
  try {
    return await nav.userAgentData?.getHighEntropyValues?.(["platformVersion", "architecture", "bitness"]) ?? null
  } catch {
    return null
  }
}

function architectureFromUserAgent(ua: string): string | null {
  const match = ua.match(/Linux\s+(x86_64|aarch64|armv[0-9]+[a-z]*|i[3-6]86)/i)
    ?? ua.match(/Win64;\s*(x64|arm64)/i)
    ?? ua.match(/Mac\s*OS\s*X[^)]*?_(x86_64|arm64)/i)
  return match ? match[1] : null
}

/** Client hints report the family ("x86", "arm") and bitness separately. */
function architectureFromHints(hints: ClientOsHints | null): string | null {
  const family = hints?.architecture?.toLowerCase()
  if (!family) return null
  if (family === "x86") return hints?.bitness === "64" ? "x64" : "x86"
  if (family === "arm") return hints?.bitness === "64" ? "arm64" : "arm"
  return family
}

function versionFromHints(platform: string, platformVersion: string | undefined): string | null {
  if (!platformVersion) return null
  const major = Number.parseInt(platformVersion, 10)
  if (!Number.isFinite(major)) return null
  // Windows reports its UniversalApiContract: 13+ is Windows 11, 1-10 Windows 10.
  if (platform === "Windows") return major >= 13 ? "11" : major >= 1 ? "10" : null
  if (platform === "macOS") return platformVersion.replace(/(\.0)+$/, "")
  return null
}

/** e.g. "Windows 11 x64", "macOS 15.1 arm64", "Linux x86_64"; without hints, the
 * platform and the architecture visible in the user agent. */
export function describeClientOs(nav: ClientNavigator, hints: ClientOsHints | null): string {
  const platform = nav.userAgentData?.platform || nav.platform
  if (!platform) return "Unknown"
  const version = versionFromHints(platform, hints?.platformVersion)
  const arch = architectureFromHints(hints) ?? architectureFromUserAgent(nav.userAgent ?? "")
  return [platform, version, arch && !platform.includes(arch) ? arch : null].filter(Boolean).join(" ")
}
