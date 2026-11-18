import type { MissionLaunchPolicy, MissionLegacyLaunchPolicy } from "./launch-policy"

/** Tests that exercise stored legacy policies address their timing/condition/ends fields. */
export function legacyLaunch(config: { launch: MissionLaunchPolicy }): MissionLegacyLaunchPolicy {
  if (!("timing" in config.launch)) throw new Error("Legacy launch policy expected")
  return config.launch
}
