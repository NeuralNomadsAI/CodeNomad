import type { WebContents } from "electron"
import profiles from "../../../ui/src/lib/native/browser-emulation.json"
import { browserEmulationProfile } from "../../../ui/src/lib/native/browser-emulation"

// The debugger must remain attached while overrides are active. Automation's
// withDebugger preserves an existing attachment, so snapshots cannot reset it.
const ownedAttachments = new WeakSet<WebContents>()
const currentProfiles = new WeakMap<WebContents, string>()

export async function setBrowserEmulation(guest: WebContents, preset: unknown): Promise<void> {
  browserEmulationProfile(preset)
  const next = preset as string
  const previous = currentProfiles.get(guest) ?? "none"
  if (previous === next) return
  if (!guest.debugger.isAttached()) {
    guest.debugger.attach("1.3")
    ownedAttachments.add(guest)
  }
  const apply = async (id: string) => {
    const send = (method: string, params: object) => guest.debugger.sendCommand(method, params)
    if (id === "none") {
      await send("Emulation.clearDeviceMetricsOverride", {})
      await send("Emulation.setTouchEmulationEnabled", { enabled: false })
      await send("Emulation.setEmitTouchEventsForMouse", { enabled: false })
      await send("Emulation.setUserAgentOverride", { userAgent: "" })
      return
    }
    const profile = browserEmulationProfile(id)!
    const version = await guest.debugger.sendCommand("Browser.getVersion") as { product: string }
    const fullVersion = version.product.split("/").pop()!
    await send("Emulation.setDeviceMetricsOverride", {
      width: profile.width, height: profile.height, deviceScaleFactor: profile.deviceScaleFactor,
      mobile: true, screenWidth: profile.width, screenHeight: profile.height,
      screenOrientation: { type: profile.orientation, angle: profile.angle },
    })
    await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
    await send("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" })
    await send("Emulation.setUserAgentOverride", {
      userAgent: profiles.userAgent.replace("{version}", fullVersion), platform: "Linux armv8l",
      userAgentMetadata: { brands: [{ brand: "Chromium", version: fullVersion.split(".")[0] }],
        fullVersion, platform: "Android", platformVersion: "11.0.0", architecture: "", model: "", mobile: true },
    })
  }
  try {
    await apply(next)
    currentProfiles.set(guest, next)
    // Applications often cache UA detection at startup; apply before reloading.
    guest.reload()
  } catch (error) {
    await apply(previous)
    throw error
  } finally {
    if ((currentProfiles.get(guest) ?? "none") === "none" && ownedAttachments.delete(guest) && guest.debugger.isAttached()) guest.debugger.detach()
  }
}
