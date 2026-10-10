import path from "node:path"

/** Case-folded physical path identity on Windows; normalized elsewhere. */
export const physical = (value: string) => process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value)
