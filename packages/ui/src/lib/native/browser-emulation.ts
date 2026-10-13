import profiles from "./browser-emulation.json"

export type BrowserEmulationPreset = "none" | "mobile" | "mobileLandscape"

export function browserEmulationProfile(preset: unknown) {
  if (preset === "none") return null
  if (typeof preset !== "string") throw new Error("Invalid browser emulation profile")
  const landscape = preset.endsWith("Landscape")
  const size = landscape ? preset.slice(0, -"Landscape".length) : preset
  if (size !== "mobile") throw new Error("Invalid browser emulation profile")
  const { width, height } = profiles[size]
  return {
    width: landscape ? height : width,
    height: landscape ? width : height,
    deviceScaleFactor: profiles.deviceScaleFactor,
    orientation: landscape ? "landscapePrimary" : "portraitPrimary",
    angle: landscape ? 90 : 0,
  }
}
