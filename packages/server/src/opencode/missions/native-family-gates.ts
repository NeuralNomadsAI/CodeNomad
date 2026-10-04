import type { Plugin } from "@opencode/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { SessionHooks } from "@opencode/plugin/promise/session"
import type { ShellCreateBefore } from "@opencode/plugin/promise/shell"
import type * as Tool from "@opencode/plugin/promise/tool"

type SessionBoundary = {
  [Name in keyof SessionHooks]: { readonly boundary: Name; readonly event: Readonly<SessionHooks[Name]> }
}[keyof SessionHooks]
type ToolHookEvent = Parameters<Parameters<Plugin.Context["tool"]["hook"]>[1]>[0]
type ToolBeforeEvent = Exclude<ToolHookEvent, { readonly status: "completed" | "error" }>

export type NativeFamilyBoundary = SessionBoundary
  | { readonly boundary: "tool.execute.before"; readonly event: Readonly<ToolBeforeEvent> }
  | { readonly boundary: "tool.executor"; readonly tool: string; readonly input: unknown; readonly context: Tool.ToolContext }
  | { readonly boundary: "shell.create.before"; readonly event: Readonly<ShellCreateBefore> }

export type NativeFamilyResolution<Membership extends object, Permit extends object> =
  | { readonly scope: "owned"; readonly membership: Membership }
  | { readonly scope: "unrelated"; readonly permit: Permit }

export interface NativeFamilyFence {
  /** Gate preparation cancellation only. Native executors retain their original signal. */
  readonly signal: AbortSignal
  assertCurrent(): void
}

/** Experimental owner-supplied capability seam, NOT an attestation producer.
 * Implementations must use authenticated native host policy, proven actual
 * family membership and current lifecycle/connection/worktree ownership. Raw
 * descendants have family authority, not invented business-task authority.
 */
export interface NativeFamilyPolicy<Membership extends object, Permit extends object> {
  /** Synchronous throwing fence, never an unsigned true or async assertion. */
  assertCurrent(boundary: NativeFamilyBoundary, resolution?: NativeFamilyResolution<Membership, Permit>): void
  /** Mandatory at EVERY hook/executor boundary. No absence-of-envelope fallback.
   * Only trusted positive policy can permit unrelated execution. Shell has NO
   * session identity: never infer one from cwd, command, env or timing. */
  resolve(boundary: NativeFamilyBoundary, fence: NativeFamilyFence): Promise<NativeFamilyResolution<Membership, Permit>>
  /** Mandatory, awaited and uncached, including unrelated policy decisions.
   * For owned boundaries, guard authority/lifecycle and freshly write ENV on
   * every actual boundary. Repeat fence after asynchronous work and immediately
   * before writes. An old receipt is not current preparation/qualification. */
  prepare(boundary: NativeFamilyBoundary, resolution: NativeFamilyResolution<Membership, Permit>, fence: NativeFamilyFence): Promise<void>
}

function object(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Separate experimental install call; no product entrypoint is changed here.
 * Hook errors propagate rather than being treated as additive context failures.
 * Removing hooks does NOT preserve native enforcement: host writer-side guards
 * and trustworthy Shell attribution remain CLOSED qualification gates.
 */
export async function installNativeFamilyGates<Membership extends object, Permit extends object>(
  ctx: Pick<Plugin.Context, "session" | "tool" | "shell">,
  policy: NativeFamilyPolicy<Membership, Permit>,
): Promise<Registration> {
  for (const method of ["assertCurrent", "resolve", "prepare"] as const) {
    if (typeof policy?.[method] !== "function") throw new Error(`Missing trusted native family policy: ${method}`)
  }
  let active = true
  const lifetime = new AbortController()
  const registrations: Registration[] = []
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    active = false
    lifetime.abort(new Error("Native family gates retired"))
    return disposal ??= (async () => {
      const outcomes = await Promise.allSettled([...registrations].reverse().map(registration => registration.dispose()))
      const rejected = outcomes.find(result => result.status === "rejected")
      if (rejected?.status === "rejected") throw rejected.reason
    })()
  }

  const admit = async (boundary: NativeFamilyBoundary, nativeSignal?: AbortSignal) => {
    let open = true
    let resolution: NativeFamilyResolution<Membership, Permit> | undefined
    const signal = nativeSignal ? AbortSignal.any([lifetime.signal, nativeSignal]) : lifetime.signal
    const assertCurrent = () => {
      if (!active || !open) throw new Error("Native family boundary retired")
      signal.throwIfAborted()
      if (policy.assertCurrent(boundary, resolution) !== undefined) throw new Error("Invalid synchronous native family fence")
    }
    const fence: NativeFamilyFence = { signal, assertCurrent }
    try {
      assertCurrent()
      resolution = await policy.resolve(boundary, fence)
      assertCurrent()
      if (!object(resolution) || (resolution.scope === "owned" ? !object(resolution.membership)
        : resolution.scope !== "unrelated" || !object(resolution.permit))) {
        throw new Error("Unknown native family membership/policy")
      }
      if (boundary.boundary === "shell.create.before" && resolution.scope === "owned") {
        // Official ShellCreateBefore cannot identify a Session. Even an alleged
        // owned membership must not manufacture attribution from shell fields.
        throw new Error("Owned native Shell has no attributable session identity")
      }
      const prepared = await policy.prepare(boundary, resolution, fence)
      assertCurrent()
      if (prepared !== undefined) throw new Error("Invalid native family preparation acknowledgement")
      return { assertCurrent, retire: () => { open = false } }
    } catch (error) { open = false; throw error }
  }

  const session = async <Name extends keyof SessionHooks>(name: Name) => {
    registrations.push(await ctx.session.hook(name, async event => {
      // Generic indexed access loses the mapped union correlation; both pieces
      // come directly from this official hook registration, not a local draft.
      const boundary = { boundary: name, event } as SessionBoundary
      const admitted = await admit(boundary)
      admitted.retire()
    }))
  }

  try {
    // Include auxiliary assembly and every provider dispatch/transport boundary,
    // not just primary context. WS traffic does not pass through HTTP hooks.
    for (const name of ["prompt", "context", "compaction", "generate", "title", "model.request", "http.request", "http.response",
      "experimental.ws.handshake", "experimental.ws.send", "experimental.ws.receive", "retry"] as const) await session(name)
    registrations.push(await ctx.tool.hook("execute.before", async event => {
      const admitted = await admit({ boundary: "tool.execute.before", event })
      admitted.retire()
    }))
    registrations.push(await ctx.shell.hook("create.before", async event => {
      const admitted = await admit({ boundary: "shell.create.before", event })
      admitted.retire()
    }))
    registrations.push(await ctx.tool.transform((editor: Tool.ToolEditor) => {
      for (const definition of editor.list()) editor.update(definition.id, draft => {
        const native = draft.execute
        // Preserve every definition/schema/option/permission field. Wrapping all
        // effective definitions covers inner Code Mode executable snapshots too.
        draft.execute = async (input, context) => {
          const boundary: NativeFamilyBoundary = { boundary: "tool.executor", tool: definition.id, input, context }
          const admitted = await admit(boundary, context.signal)
          try {
            admitted.assertCurrent()
            const result = await native(input, { ...context, progress: async update => {
              admitted.assertCurrent()
              await context.progress(update)
              admitted.assertCurrent()
            } })
            admitted.assertCurrent()
            return result
          } finally { admitted.retire() }
        }
      })
    }))
  } catch (error) {
    try { await dispose() } catch { /* Preserve the original installation error. */ }
    throw error
  }
  return { dispose }
}
