// Browser and Undici WebSockets cannot send reserved protocol close codes.
// Preserve application codes and use a private-use failure code otherwise.
export function clientWebSocketCloseCode(code: number | undefined): number | undefined {
  if (code === undefined || code === 1000) return code
  return Number.isInteger(code) && code >= 3000 && code <= 4999 ? code : 4000
}
