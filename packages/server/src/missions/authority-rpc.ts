import { z } from "zod"
import type { AuthorityEffectAdapter, NativeMissionAuthority } from "./authority-core"
import { MissionAuthorityError, rejectAuthority, signedAuthorityIntentSchema, type SignedAuthorityIntent } from "./authority-protocol"
import { authorityReceiptQuerySchema, authorityReceiptReadSchema, type AuthorityReceiptRead } from "./authority-receipt"

export const CODENOMAD_MISSIONS_AUTHORITY_RPC = {
  id: "codenomad.missions.authority",
  methods: {
    state: { input: z.object({ missionID: z.string().min(1).max(240) }).strict(), output: { type: "object" } },
    challenge: {
      input: z.object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) }).strict(),
      output: { type: "object" },
    },
    receipt: {
      input: authorityReceiptQuerySchema, output: authorityReceiptReadSchema,
      errors: { "mission.authority-rejected": {
        type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false,
      } },
    },
    intent: {
      input: signedAuthorityIntentSchema,
      output: { type: "object" },
      errors: { "mission.authority-rejected": {
        type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false,
      } },
    },
  },
  events: {},
} as const

/** Does not register anything or enable a plugin. Existing plugin owner wires
 * these handlers with native disposal fencing and declared error conversion. */
export function missionAuthorityHandlers(authority: NativeMissionAuthority, effects: AuthorityEffectAdapter,
  assertActive: () => void) {
  return {
    state: async (input: { missionID: string }) => {
      assertActive()
      return authority.state(input.missionID)
    },
    challenge: async (input: { nonce: string }) => {
      assertActive()
      const result = await authority.challenge(input.nonce)
      assertActive()
      return result
    },
    receipt: async <Failure = never>(input: unknown, context?: { error(name: "mission.authority-rejected", message: string, data: { code: string }): Failure }): Promise<AuthorityReceiptRead | Failure> => {
      try {
        assertActive()
        const result = await authority.readReceipt(input)
        assertActive()
        return result
      } catch (error) {
        const code = error instanceof MissionAuthorityError ? error.code : "observation-unavailable"
        if (context) return context.error("mission.authority-rejected", "Mission receipt unavailable", { code })
        rejectAuthority(code)
      }
    },
    intent: async (input: SignedAuthorityIntent, context: { signal: AbortSignal }) => {
      assertActive()
      return authority.execute(input, {
        expectedSigner: effects.expectedSigner,
        assertCurrent: effects.assertCurrent,
        apply: async (intent, signal) => {
          assertActive()
          signal.throwIfAborted()
          return effects.apply(intent, signal)
        },
      }, context.signal)
    },
  }
}

/** Native RpcCallContext has no caller identity. Preserve only the known read
 * methods: a future method is rejected unless explicitly classified and signed.
 * Do not wrap agent tools/reports in this human RPC gate. */
export function rejectUnsignedMissionMutators<T extends Record<string, (...args: any[]) => any>>(handlers: T,
  namespace: "codenomad.missions" | typeof CODENOMAD_MISSIONS_AUTHORITY_RPC.id = "codenomad.missions"): T {
  return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name,
    (namespace === "codenomad.missions" ? name === "snapshot" || name === "cleanupTarget"
      : name === "state" || name === "challenge" || name === "receipt") ? handler
      : async () => rejectAuthority("unsigned-privileged-method"),
  ])) as T
}
