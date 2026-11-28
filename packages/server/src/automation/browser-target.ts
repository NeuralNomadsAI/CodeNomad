/** A native preview target witness, as hosts return it from a probe. */
export function isBrowserTarget(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000- \u007f]/u.test(value)
}
