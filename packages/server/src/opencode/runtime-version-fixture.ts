import { MINIMUM_OPENCODE_VERSION, RECOMMENDED_OPENCODE_VERSION } from "./runtime-support"

/** Test runtime versions derived from the supported range, so changing the minimum edits no fixture. */
export const MINIMUM = MINIMUM_OPENCODE_VERSION
export const RECOMMENDED = RECOMMENDED_OPENCODE_VERSION

const [minMajor, minMinor] = MINIMUM.split(".").map(Number)
const [major, minor, patch] = RECOMMENDED.split(".").map(Number)

/** A patch release `n` above the recommendation. */
export const newerPatch = (n = 1) => `${major}.${minor}.${patch + n}`
/** The next minor release line, above every listed version. */
export const NEXT_MINOR = `${major}.${minor + 1}.0`
export const NEXT_MAJOR = `${major + 1}.0.0`
/** The last patch of the release line before the minimum. */
export const BELOW_MINIMUM = minMinor > 0 ? `${minMajor}.${minMinor - 1}.99` : `${minMajor - 1}.99.99`
