import type { ChildProcess } from "node:child_process"

export const NATIVE_REQUEST_PREFIX = "CODENOMAD_NATIVE_REQUEST:"
const NATIVE_RESPONSE_PREFIX = "CODENOMAD_NATIVE_RESPONSE:"

interface NativeRequest {
  v: 1
  id: string
  method: string
  params?: unknown
  deadline: number
}

export function isClosedPipeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_WRITE_AFTER_END"
}

export function parseNativeRequest(line: string): NativeRequest | undefined {
  if (!line.startsWith(NATIVE_REQUEST_PREFIX) || line.length > 20 * 1024 * 1024) return undefined
  try {
    const value = JSON.parse(line.slice(NATIVE_REQUEST_PREFIX.length)) as Partial<NativeRequest>
    if (value.v !== 1 || typeof value.id !== "string" || !value.id || typeof value.method !== "string" || !value.method
      || typeof value.deadline !== "number" || !Number.isSafeInteger(value.deadline)) return undefined
    return value as NativeRequest
  } catch {
    return undefined
  }
}

export async function dispatchNativeRequest(
  child: ChildProcess,
  request: NativeRequest,
  handler: (method: string, params: unknown, deadline: number) => Promise<unknown>,
  isCurrent: () => boolean,
): Promise<void> {
  let response: Record<string, unknown>
  try {
    if (Date.now() >= request.deadline) throw new Error("Native request expired before execution")
    response = { v: 1, id: request.id, ok: true, result: await handler(request.method, request.params, request.deadline) }
  } catch (error) {
    response = {
      v: 1,
      id: request.id,
      ok: false,
      error: { code: "native_error", message: error instanceof Error ? error.message : String(error) },
    }
  }
  if (!isCurrent() || !child.stdin?.writable) return
  try {
    child.stdin.write(`${NATIVE_RESPONSE_PREFIX}${JSON.stringify(response)}\n`, (error) => {
      if (error && !isClosedPipeError(error)) console.warn("[cli] failed to write native response", error)
    })
  } catch (error) {
    if (!isClosedPipeError(error)) throw error
  }
}
